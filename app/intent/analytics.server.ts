// Shared analytics data layer — used by the Overview dashboard loader AND the
// analytics assistant. Per-shop, reads our own Postgres (cold layer + profiles).
import prisma from "../db.server";
import { intentCohorts } from "./vectors.server";
import { getUsageSummary } from "./usage.server";
import type { IntentProfile } from "./events";

const FUNNEL = [
  { type: "product_view", label: "Product views" },
  { type: "search", label: "Searches" },
  { type: "add_to_cart", label: "Add to cart" },
  { type: "checkout_started", label: "Checkout" },
  { type: "order_created", label: "Orders" },
];

function dist(items: (string | undefined)[]) {
  const m = new Map<string, number>();
  for (const x of items) if (x) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export interface Overview {
  totalEvents: number;
  totalSessions: number;
  totalProfiles: number;
  abandonedCheckouts: number;
  avgConversion: number | null;
  funnel: Array<{ label: string; count: number }>;
  eventsByDay: Array<{ day: string; events: number; carts: number; orders: number }>;
  topCategories: Array<{ name: string; value: number }>;
  topBrands: Array<{ name: string; value: number }>;
  topSearches: Array<{ name: string; value: number }>;
  queryIntentDist: Array<{ name: string; value: number }>;
  decisionPhaseDist: Array<{ name: string; value: number }>;

  // --- assistant/popup performance (D2C insights) ---
  popup: {
    shown: number;
    dismissed: number;
    clicks: number;      // bot_product_clicked
    addToCarts: number;  // bot_add_to_cart
    byReason: Array<{ reason: string; shown: number; dismissed: number }>;
  };
  chat: {
    conversations: number;
    popupInitiated: number;      // first message from the assistant (a nudge)
    userInitiated: number;
    popupReplied: number;        // popup-initiated convos where the shopper replied
    totalUserMessages: number;
  };
  topClickedProducts: Array<{ productId: string; title: string; clicks: number; carts: number }>;
  // Orders in sessions where the shopper ENGAGED the assistant (clicked a bot
  // suggestion or carted via the bot) before ordering — true bot-assisted sales.
  assistedOrders: { count: number; revenue: number; totalOrders: number; totalRevenue: number };
  recentConversations: Array<{
    sessionId: string;
    messages: number;
    popupInitiated: boolean;
    firstUserMessage: string | null;
    lastActivity: string;
  }>;
  cost: {
    chatTurns: number;       // user messages answered (each ≈ 1 Sonnet agent run + Haiku followups)
    popupsComposed: number;  // popups shown (each ≈ 1 Sonnet compose + Haiku followups)
    profilesEnriched: number; // Haiku intent enrichments (profiles with a narrative)
    estUsd: number;           // rough estimate — fallback when metering has no data yet
    // Real metered usage (response.usage per call) — null until data accrues.
    actual: null | {
      usd: number;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cacheHitPct: number; // share of prompt tokens served from cache (cost saver)
      avgUsdPerCall: number;
    };
  };
}

// Rough per-interaction LLM cost estimates (USD). Chat/popup ≈ one Sonnet agent
// run (tools included) + a Haiku followup call; enrichment ≈ one Haiku call.
const EST_COST = { chatTurn: 0.02, popup: 0.02, enrichment: 0.002 };

async function popupAndChatInsights(shopId: string) {
  const [reasonRows, transcriptRows, recent] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ reason: string | null; type: string; n: bigint }>>(
      `SELECT payload->>'reason' AS reason, type, count(*) AS n
         FROM "Event"
        WHERE "shopId" = $1 AND type IN ('proactive_shown','proactive_dismissed')
        GROUP BY payload->>'reason', type`,
      shopId,
    ),
    prisma.$queryRawUnsafe<Array<{ conversations: bigint; popup_initiated: bigint; popup_replied: bigint; user_msgs: bigint }>>(
      `SELECT count(*) AS conversations,
              count(*) FILTER (WHERE messages->0->>'role' = 'assistant') AS popup_initiated,
              count(*) FILTER (WHERE messages->0->>'role' = 'assistant'
                               AND messages @> '[{"role":"user"}]') AS popup_replied,
              coalesce(sum((SELECT count(*) FROM jsonb_array_elements(messages) m WHERE m->>'role' = 'user')), 0) AS user_msgs
         FROM "ChatTranscript" WHERE shop = $1`,
      shopId,
    ).catch(() => [{ conversations: 0, popup_initiated: 0, popup_replied: 0, user_msgs: 0 } as unknown as { conversations: bigint; popup_initiated: bigint; popup_replied: bigint; user_msgs: bigint }]),
    prisma.$queryRawUnsafe<Array<{ sessionId: string; messages: unknown; updatedAt: Date }>>(
      `SELECT "sessionId", messages, "updatedAt" FROM "ChatTranscript"
        WHERE shop = $1 ORDER BY "updatedAt" DESC LIMIT 8`,
      shopId,
    ).catch(() => []),
  ]);

  const reasonMap = new Map<string, { shown: number; dismissed: number }>();
  let shown = 0, dismissed = 0;
  for (const r of reasonRows) {
    const key = r.reason ?? "(dismissal)";
    const cur = reasonMap.get(key) ?? { shown: 0, dismissed: 0 };
    if (r.type === "proactive_shown") { cur.shown += Number(r.n); shown += Number(r.n); }
    else { cur.dismissed += Number(r.n); dismissed += Number(r.n); }
    reasonMap.set(key, cur);
  }
  const byReason = [...reasonMap.entries()]
    .filter(([k]) => k !== "(dismissal)")
    .map(([reason, v]) => ({ reason, ...v }))
    .sort((a, b) => b.shown - a.shown);

  const t = transcriptRows[0];
  const recentConversations = recent.map((row) => {
    const msgs = (row.messages as Array<{ role: string; content: string }>) ?? [];
    const firstUser = msgs.find((m) => m.role === "user");
    return {
      sessionId: row.sessionId,
      messages: msgs.length,
      popupInitiated: msgs[0]?.role === "assistant",
      firstUserMessage: firstUser ? firstUser.content.slice(0, 90) : null,
      lastActivity: new Date(row.updatedAt).toISOString(),
    };
  });

  return {
    popupShown: shown,
    popupDismissed: dismissed,
    byReason,
    conversations: Number(t.conversations),
    popupInitiated: Number(t.popup_initiated),
    popupReplied: Number(t.popup_replied),
    totalUserMessages: Number(t.user_msgs),
    recentConversations,
  };
}

// Resolve display titles for the most-clicked products (best-effort, live).
async function resolveTitles(shopId: string, ids: string[]): Promise<Map<string, string>> {
  const { getProductDetails } = await import("./storefront.server");
  const out = new Map<string, string>();
  await Promise.all(ids.map(async (id) => {
    try { out.set(id, (await getProductDetails(shopId, id)).title); }
    catch { out.set(id, id.split("/").pop() ?? id); }
  }));
  return out;
}

export async function getOverview(shopId: string): Promise<Overview> {
  const [byType, byCategory, byBrand, bySearch, sessions, profileRows, totalEvents, days] = await Promise.all([
    prisma.event.groupBy({ by: ["type"], where: { shopId }, _count: { _all: true } }),
    prisma.event.groupBy({ by: ["category"], where: { shopId, category: { not: null } }, _count: { _all: true } }),
    prisma.event.groupBy({ by: ["brand"], where: { shopId, brand: { not: null } }, _count: { _all: true } }),
    prisma.event.groupBy({ by: ["searchTerm"], where: { shopId, type: "search", searchTerm: { not: null } }, _count: { _all: true } }),
    prisma.event.findMany({ where: { shopId }, distinct: ["sessionId"], select: { sessionId: true } }),
    prisma.intentProfile.findMany({ where: { shopId }, select: { profile: true } }),
    prisma.event.count({ where: { shopId } }),
    prisma.$queryRawUnsafe<Array<{ day: string; events: bigint; carts: bigint; orders: bigint }>>(
      `SELECT to_char(date_trunc('day', "timestamp"), 'Mon DD') AS day,
              count(*) AS events,
              count(*) FILTER (WHERE type = 'add_to_cart') AS carts,
              count(*) FILTER (WHERE type = 'order_created') AS orders
         FROM "Event"
        WHERE "shopId" = $1 AND "timestamp" > now() - interval '14 days'
        GROUP BY date_trunc('day', "timestamp")
        ORDER BY date_trunc('day', "timestamp")`,
      shopId,
    ),
  ]);

  const count = (t: string) => byType.find((r) => r.type === t)?._count._all ?? 0;
  const profiles = profileRows.map((r) => r.profile as unknown as IntentProfile);
  const convs = profiles.map((p) => p.conversionScore).filter((x): x is number => x != null);

  const top = (rows: Array<{ _count: { _all: number } } & Record<string, any>>, key: string, n: number) =>
    rows.map((r) => ({ name: r[key] as string, value: r._count._all })).sort((a, b) => b.value - a.value).slice(0, n);

  // Assistant/popup performance + top clicked products + order attribution + real LLM usage
  const [insights, clickRows, cartRows, orderAttr, usage] = await Promise.all([
    popupAndChatInsights(shopId),
    prisma.event.groupBy({ by: ["productId"], where: { shopId, type: "bot_product_clicked", productId: { not: null } }, _count: { _all: true } }),
    prisma.event.groupBy({ by: ["productId"], where: { shopId, type: "bot_add_to_cart", productId: { not: null } }, _count: { _all: true } }),
    // Bot-assisted = order in a session with a bot ENGAGEMENT (click/cart via
    // the assistant) before the order. Merely seeing a popup doesn't count.
    prisma.$queryRawUnsafe<Array<{ assisted: bigint; assisted_rev: number | null; total: bigint; total_rev: number | null }>>(
      `SELECT
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM "Event" b
            WHERE b."shopId" = o."shopId" AND b."sessionId" = o."sessionId"
              AND b.type IN ('bot_product_clicked','bot_add_to_cart')
              AND b."timestamp" <= o."timestamp")) AS assisted,
         sum((o.payload->>'cartValue')::float) FILTER (WHERE EXISTS (
           SELECT 1 FROM "Event" b
            WHERE b."shopId" = o."shopId" AND b."sessionId" = o."sessionId"
              AND b.type IN ('bot_product_clicked','bot_add_to_cart')
              AND b."timestamp" <= o."timestamp")) AS assisted_rev,
         count(*) AS total,
         sum((o.payload->>'cartValue')::float) AS total_rev
       FROM "Event" o
      WHERE o."shopId" = $1 AND o.type = 'order_created'`,
      shopId,
    ).catch(() => [{ assisted: 0n, assisted_rev: 0, total: 0n, total_rev: 0 }]),
    getUsageSummary(shopId),
  ]);
  const cartsByProduct = new Map(cartRows.map((r) => [r.productId as string, r._count._all]));
  const topClicked = clickRows
    .map((r) => ({ productId: r.productId as string, clicks: r._count._all, carts: cartsByProduct.get(r.productId as string) ?? 0 }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 5);
  const titles = await resolveTitles(shopId, topClicked.map((p) => p.productId));

  const profilesEnriched = profiles.filter((p) => (p.intentNarrative ?? "").length > 0).length;
  const estUsd =
    insights.totalUserMessages * EST_COST.chatTurn +
    insights.popupShown * EST_COST.popup +
    profilesEnriched * EST_COST.enrichment;

  return {
    popup: {
      shown: insights.popupShown,
      dismissed: insights.popupDismissed,
      clicks: count("bot_product_clicked"),
      addToCarts: count("bot_add_to_cart"),
      byReason: insights.byReason,
    },
    chat: {
      conversations: insights.conversations,
      popupInitiated: insights.popupInitiated,
      userInitiated: insights.conversations - insights.popupInitiated,
      popupReplied: insights.popupReplied,
      totalUserMessages: insights.totalUserMessages,
    },
    topClickedProducts: topClicked.map((p) => ({ ...p, title: titles.get(p.productId) ?? p.productId })),
    assistedOrders: {
      count: Number(orderAttr[0]?.assisted ?? 0),
      revenue: Math.round(Number(orderAttr[0]?.assisted_rev ?? 0)),
      totalOrders: Number(orderAttr[0]?.total ?? 0),
      totalRevenue: Math.round(Number(orderAttr[0]?.total_rev ?? 0)),
    },
    recentConversations: insights.recentConversations,
    cost: {
      chatTurns: insights.totalUserMessages,
      popupsComposed: insights.popupShown,
      profilesEnriched,
      estUsd: Math.round(estUsd * 100) / 100,
      actual: usage
        ? {
            usd: Math.round(usage.totalUsd * 10000) / 10000,
            calls: usage.calls,
            inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
            outputTokens: usage.outputTokens,
            cacheHitPct: usage.cacheHitPct,
            avgUsdPerCall: usage.calls ? Math.round((usage.totalUsd / usage.calls) * 10000) / 10000 : 0,
          }
        : null,
    },
    totalEvents,
    totalSessions: sessions.length,
    totalProfiles: profiles.length,
    abandonedCheckouts: Math.max(0, count("checkout_started") - count("order_created")),
    avgConversion: convs.length ? convs.reduce((s, x) => s + x, 0) / convs.length : null,
    funnel: FUNNEL.map((f) => ({ label: f.label, count: count(f.type) })),
    eventsByDay: days.map((d) => ({ day: d.day, events: Number(d.events), carts: Number(d.carts), orders: Number(d.orders) })),
    topCategories: top(byCategory, "category", 8),
    topBrands: top(byBrand, "brand", 8),
    topSearches: top(bySearch, "searchTerm", 10),
    queryIntentDist: dist(profiles.map((p) => p.queryIntent)),
    decisionPhaseDist: dist(profiles.map((p) => p.decisionPhase)),
  };
}

// Full bundle for the analytics assistant (overview + semantic cohorts).
export async function getAnalyticsBundle(shopId: string) {
  const [overview, cohorts] = await Promise.all([getOverview(shopId), intentCohorts(shopId).catch(() => [])]);
  return { overview, cohorts };
}

// Shopper insights: what groups of shoppers want, and what individual active
// shoppers are trying to do right now — in plain language, no engine jargon.
// Built to stay usable at 1000s of shoppers: the loader filters/aggregates
// server-side from URL params, charts summarize the filtered set, and the
// list paginates. Every filter is a plain GET param, so views are shareable.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { intentCohorts } from "../intent/vectors.server";
import { getShopInfo } from "../intent/settings.server";
import type { IntentProfile } from "../intent/events";
import { Donut, CategoryBars } from "../components/charts";

const PAGE_SIZE = 10;
// Aggregation window cap — plenty for insight, bounded for a hot loader.
const MAX_PROFILES = 500;

const readinessOf = (s: number | undefined | null) =>
  s == null ? "low" : s >= 0.6 ? "high" : s >= 0.3 ? "medium" : "low";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const url = new URL(request.url);
  const g = (k: string) => url.searchParams.get(k) ?? "";
  const days = ["7", "30", "90", "all"].includes(g("days")) ? g("days") : "30";
  const sort = ["recent", "intent", "budget"].includes(g("sort")) ? g("sort") : "recent";
  const page = Math.max(1, Number(g("page")) || 1);
  const fIntent = g("intent");
  const fPhase = g("phase");
  const fReadiness = g("readiness");
  const fCat = g("cat");
  const fHesitating = g("hesitating") === "1";

  const cutoff = days === "all" ? undefined : new Date(Date.now() - Number(days) * 86400000);
  const [profileRows, cohorts, shopInfo] = await Promise.all([
    prisma.intentProfile.findMany({
      where: { shopId, ...(cutoff ? { lastUpdated: { gte: cutoff } } : {}) },
      orderBy: { lastUpdated: "desc" },
      take: MAX_PROFILES,
    }),
    intentCohorts(shopId).catch(() => []),
    getShopInfo(shopId).catch(() => ({})),
  ]);

  // Only profiles with an AI-written story read well; signal-only rows are noise here.
  const all = profileRows
    .map((r) => ({ p: r.profile as unknown as IntentProfile, at: r.lastUpdated.toISOString() }))
    .filter((x) => (x.p.intentNarrative ?? "").length > 0);

  // Category filter options come from the UNFILTERED window so chips don't vanish
  // as you drill in.
  const catCounts = new Map<string, number>();
  for (const { p } of all) if (p.focusCategory) catCounts.set(p.focusCategory, (catCounts.get(p.focusCategory) ?? 0) + 1);
  const catOptions = [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);

  const filtered = all.filter(({ p }) => {
    if (fIntent && p.queryIntent !== fIntent) return false;
    if (fPhase && p.decisionPhase !== fPhase) return false;
    if (fReadiness && readinessOf(p.conversionScore) !== fReadiness) return false;
    if (fCat && p.focusCategory !== fCat) return false;
    if (fHesitating && p.cartHesitation !== "high") return false;
    return true;
  });

  // Aggregates over the FILTERED set — charts answer "who are these shoppers".
  const dist = (vals: Array<string | undefined>, labels: Record<string, string>) => {
    const m = new Map<string, number>();
    for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].map(([k, v]) => ({ name: labels[k] ?? k, value: v })).sort((a, b) => b.value - a.value);
  };
  const budgets = filtered.map(({ p }) => p.priceCeiling).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
  const readiness = { high: 0, medium: 0, low: 0 };
  for (const { p } of filtered) readiness[readinessOf(p.conversionScore)]++;

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "intent") return (b.p.conversionScore ?? 0) - (a.p.conversionScore ?? 0);
    if (sort === "budget") return (b.p.priceCeiling ?? 0) - (a.p.priceCeiling ?? 0);
    return b.at.localeCompare(a.at);
  });
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);

  return {
    cohorts,
    currency: (shopInfo as { currencyCode?: string }).currencyCode ?? "",
    total: all.length,
    matched: sorted.length,
    page: safePage,
    pages,
    profiles: sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    mindsetDist: dist(filtered.map(({ p }) => p.queryIntent), MINDSET),
    phaseDist: dist(filtered.map(({ p }) => p.decisionPhase), PHASE),
    readinessDist: [
      { name: "Ready to buy", value: readiness.high },
      { name: "Warming up", value: readiness.medium },
      { name: "Early browsing", value: readiness.low },
    ].filter((x) => x.value > 0),
    topCategories: [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, value]) => ({ name, value })),
    stats: {
      highIntent: readiness.high,
      hesitating: filtered.filter(({ p }) => p.cartHesitation === "high").length,
      medianBudget: budgets.length ? budgets[Math.floor(budgets.length / 2)] : null,
    },
    catOptions,
  };
};

// Plain-language labels for engine terms.
const PHASE: Record<string, string> = { browsing: "Just browsing", comparing: "Comparing options", deciding: "Close to buying" };
const MINDSET: Record<string, string> = {
  exploratory: "Exploring the store",
  targeted: "Knows what they want",
  comparing: "Weighing options",
  deal_seeking: "Hunting for a deal",
};
const intentTone = (v: number) => (v >= 0.5 ? "success" : v >= 0.3 ? "warning" : "neutral") as "success" | "warning" | "neutral";

// One filter dimension rendered as toggle chips; clicking the active chip clears it.
function FilterChips({
  label, param, options, active, onPick,
}: { label: string; param: string; options: Array<{ value: string; label: string }>; active: string; onPick: (param: string, value: string) => void }) {
  return (
    <s-stack direction="inline" gap="small">
      <s-text tone="neutral">{label}</s-text>
      {options.map((o) => (
        <s-button
          key={o.value}
          variant={active === o.value ? "primary" : "tertiary"}
          onClick={() => onPick(param, active === o.value ? "" : o.value)}
        >
          {o.label}
        </s-button>
      ))}
    </s-stack>
  );
}

export default function IntentProfiles() {
  const d = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const pick = (param: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(param, value); else next.delete(param);
    next.delete("page"); // filter change resets pagination
    setParams(next, { preventScrollReset: true });
  };
  const active = (k: string) => params.get(k) ?? "";
  const hasFilters = ["intent", "phase", "readiness", "cat", "hesitating"].some((k) => params.get(k));

  // Budgets in the store's own currency (₹, €, …) — never a bare number that
  // reads as dollars. Falls back to a plain number when the code is unknown.
  const fmtMoney = (v: number) => {
    try {
      if (d.currency) return new Intl.NumberFormat("en", { style: "currency", currency: d.currency, maximumFractionDigits: 0 }).format(v);
    } catch { /* unknown code → fall through */ }
    return `${d.currency ? `${d.currency} ` : ""}${Math.round(v).toLocaleString()}`;
  };

  const statTile = (label: string, value: string, hint?: string) => (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text tone="neutral">{label}</s-text>
        <s-heading>{value}</s-heading>
        {hint && <s-text tone="neutral">{hint}</s-text>}
      </s-stack>
    </s-box>
  );

  return (
    <s-page heading="Shopper insights">
      {/* Overview: who is in the current view */}
      <s-section heading="Overview">
        <s-stack direction="inline" gap="small">
          <FilterChips
            label="Window" param="days" active={active("days") || "30"} onPick={(p, v) => pick(p, v || "30")}
            options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "all", label: "All time" }]}
          />
        </s-stack>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginTop: 12 }}>
          {statTile("Shoppers analyzed", String(d.matched), hasFilters ? `of ${d.total} in window` : undefined)}
          {statTile("Ready to buy", String(d.stats.highIntent), "60%+ buying intent")}
          {statTile("Hesitating at the cart", String(d.stats.hesitating), "added, then wavered")}
          {statTile("Median budget", d.stats.medianBudget != null ? fmtMoney(d.stats.medianBudget) : "—", "typical spend ceiling")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 16 }}>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text tone="neutral">Shopper mindset</s-text>
            <Donut data={d.mindsetDist} />
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text tone="neutral">Decision phase</s-text>
            <Donut data={d.phaseDist} />
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-text tone="neutral">Purchase readiness</s-text>
            <Donut data={d.readinessDist} />
          </s-box>
          {d.topCategories.length > 0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-text tone="neutral">Most-wanted categories</s-text>
              <CategoryBars data={d.topCategories} />
            </s-box>
          )}
        </div>
      </s-section>

      <s-section heading="Shopper groups">
        <s-text tone="neutral">
          Shoppers with similar goals, grouped automatically. Use these to spot demand patterns —
          e.g. a cluster of budget cushion hunters is a merchandising signal.
        </s-text>
        {d.cohorts.length === 0 ? (
          <s-paragraph><s-text tone="neutral">Not enough shopper activity yet to form groups.</s-text></s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {d.cohorts.map((c, i) => (
              <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small">
                    <s-badge tone="info">{`${c.size} shopper${c.size === 1 ? "" : "s"}`}</s-badge>
                    {c.focusCategory && <s-badge>{`Interested in ${c.focusCategory}`}</s-badge>}
                    {c.queryIntent && <s-badge>{MINDSET[c.queryIntent] ?? c.queryIntent}</s-badge>}
                    {c.priceCeiling != null && <s-badge>{`Budget ~${fmtMoney(c.priceCeiling)}`}</s-badge>}
                    {c.avgConversion != null && (
                      <s-badge tone={intentTone(c.avgConversion)}>{`${Math.round(c.avgConversion * 100)}% buying intent`}</s-badge>
                    )}
                  </s-stack>
                  <s-paragraph>{c.narrative}</s-paragraph>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Shoppers">
        <s-text tone="neutral">
          What individual shoppers were trying to do, in the assistant&apos;s own words, with the action it recommends.
          Filter to the shoppers that matter, e.g. ready-to-buy hesitators.
        </s-text>

        <s-stack direction="block" gap="small">
          <FilterChips
            label="Mindset" param="intent" active={active("intent")} onPick={pick}
            options={Object.entries(MINDSET).map(([value, label]) => ({ value, label }))}
          />
          <FilterChips
            label="Phase" param="phase" active={active("phase")} onPick={pick}
            options={Object.entries(PHASE).map(([value, label]) => ({ value, label }))}
          />
          <FilterChips
            label="Readiness" param="readiness" active={active("readiness")} onPick={pick}
            options={[{ value: "high", label: "Ready to buy" }, { value: "medium", label: "Warming up" }, { value: "low", label: "Early browsing" }]}
          />
          {d.catOptions.length > 0 && (
            <FilterChips
              label="Category" param="cat" active={active("cat")} onPick={pick}
              options={d.catOptions.map((c) => ({ value: c, label: c }))}
            />
          )}
          <s-stack direction="inline" gap="small">
            <FilterChips
              label="More" param="hesitating" active={active("hesitating")} onPick={pick}
              options={[{ value: "1", label: "Hesitating at the cart" }]}
            />
            <FilterChips
              label="Sort" param="sort" active={active("sort") || "recent"} onPick={(p, v) => pick(p, v || "recent")}
              options={[{ value: "recent", label: "Most recent" }, { value: "intent", label: "Highest intent" }, { value: "budget", label: "Highest budget" }]}
            />
            {hasFilters && (
              <s-button variant="tertiary" tone="critical" onClick={() => setParams(new URLSearchParams(active("days") ? { days: active("days") } : {}), { preventScrollReset: true })}>
                Clear filters
              </s-button>
            )}
          </s-stack>
        </s-stack>

        {d.profiles.length === 0 ? (
          <s-paragraph>
            <s-text tone="neutral">
              {d.total === 0 ? "No shopper stories yet — they appear as visitors browse." : "No shoppers match these filters."}
            </s-text>
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {d.profiles.map(({ p, at }, i) => (
              <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small">
                    {p.conversionScore != null && (
                      <s-badge tone={intentTone(p.conversionScore)}>{`${Math.round(p.conversionScore * 100)}% buying intent`}</s-badge>
                    )}
                    {p.decisionPhase && <s-badge tone="info">{PHASE[p.decisionPhase] ?? p.decisionPhase}</s-badge>}
                    {p.focusCategory && <s-badge>{`Looking at ${p.focusCategory}`}</s-badge>}
                    {p.priceCeiling != null && <s-badge>{`Budget ~${fmtMoney(p.priceCeiling)}`}</s-badge>}
                    {p.cartHesitation === "high" && <s-badge tone="warning">Hesitating at the cart</s-badge>}
                    <s-text tone="neutral">{new Date(at).toLocaleString()}</s-text>
                  </s-stack>
                  <s-paragraph>{p.intentNarrative}</s-paragraph>
                  {p.nextBestAction && <s-text tone="info">{`Assistant's move: ${p.nextBestAction}`}</s-text>}
                </s-stack>
              </s-box>
            ))}
            {d.pages > 1 && (
              <s-stack direction="inline" gap="small">
                <s-button variant="tertiary" disabled={d.page <= 1} onClick={() => pickPage(params, setParams, d.page - 1)}>Previous</s-button>
                <s-text tone="neutral">{`Page ${d.page} of ${d.pages} · ${d.matched} shoppers`}</s-text>
                <s-button variant="tertiary" disabled={d.page >= d.pages} onClick={() => pickPage(params, setParams, d.page + 1)}>Next</s-button>
              </s-stack>
            )}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

function pickPage(
  params: URLSearchParams,
  setParams: (p: URLSearchParams, o?: { preventScrollReset?: boolean }) => void,
  page: number,
) {
  const next = new URLSearchParams(params);
  next.set("page", String(page));
  setParams(next, { preventScrollReset: true });
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
export { EmbeddedErrorBoundary as ErrorBoundary } from "../embedded-boundary";

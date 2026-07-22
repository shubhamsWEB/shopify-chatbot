// Per-shop merchant settings: brand description (grounds every bot reply) and
// the widget welcome message. Table is created lazily so production needs no
// out-of-band `prisma db push`; a 60s in-memory cache keeps the per-turn read free.
import prisma from "../db.server";

// Merchant-tunable bot behavior. Every field maps to an explained control on
// the admin "Bot settings" page; defaults reproduce the shipped behavior.
export interface BotConfig {
  proactiveEnabled: boolean;   // master switch for all intent nudges
  welcomeEnabled: boolean;     // auto-open welcome for fresh visitors
  welcomeDelaySec: number;     // seconds before the welcome auto-opens
  idleResumeEnabled: boolean;  // nudge again after a chat goes quiet
  idleResumeSec: number;       // seconds of chat silence before nudging again
  maxPopupsPerSession: number; // hard cap per browsing session
  sameNudgeCooldownMin: number; // minutes before the same nudge type can repeat
  minTimeOnSiteSec: number;    // grace period before the first nudge
  soundEnabled: boolean;       // soft chime when a popup opens
  badgeEnabled: boolean;       // red attention badge on the chat bubble
  customerDataEnabled: boolean; // allow signed-in shoppers to query their own orders
}

export const DEFAULT_CONFIG: BotConfig = {
  proactiveEnabled: true,
  welcomeEnabled: true,
  welcomeDelaySec: 10,
  idleResumeEnabled: true,
  idleResumeSec: 50,
  maxPopupsPerSession: 99,
  sameNudgeCooldownMin: 5,
  minTimeOnSiteSec: 8,
  soundEnabled: true,
  badgeEnabled: true,
  customerDataEnabled: true,
};

const clampNum = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const clampBool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const clampStr = (v: unknown, max: number): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : undefined;
};

export function normalizeConfig(raw: Partial<BotConfig> | null | undefined): BotConfig {
  const r = raw ?? {};
  return {
    proactiveEnabled: clampBool(r.proactiveEnabled, DEFAULT_CONFIG.proactiveEnabled),
    welcomeEnabled: clampBool(r.welcomeEnabled, DEFAULT_CONFIG.welcomeEnabled),
    welcomeDelaySec: clampNum(r.welcomeDelaySec, DEFAULT_CONFIG.welcomeDelaySec, 0, 120),
    idleResumeEnabled: clampBool(r.idleResumeEnabled, DEFAULT_CONFIG.idleResumeEnabled),
    idleResumeSec: clampNum(r.idleResumeSec, DEFAULT_CONFIG.idleResumeSec, 20, 600),
    maxPopupsPerSession: clampNum(r.maxPopupsPerSession, DEFAULT_CONFIG.maxPopupsPerSession, 1, 99),
    sameNudgeCooldownMin: clampNum(r.sameNudgeCooldownMin, DEFAULT_CONFIG.sameNudgeCooldownMin, 1, 120),
    minTimeOnSiteSec: clampNum(r.minTimeOnSiteSec, DEFAULT_CONFIG.minTimeOnSiteSec, 3, 120),
    soundEnabled: clampBool(r.soundEnabled, DEFAULT_CONFIG.soundEnabled),
    badgeEnabled: clampBool(r.badgeEnabled, DEFAULT_CONFIG.badgeEnabled),
    customerDataEnabled: clampBool(r.customerDataEnabled, DEFAULT_CONFIG.customerDataEnabled),
  };
}

// Human-handoff / support-channel config. Merchant-editable (like `config`),
// NOT developer-only (`backoffice`). String secrets live in this JSONB blob at
// the same trust boundary as `contactEmail` — typed into the merchant's own app
// admin over HTTPS. normalizeConfig only does bool/number, so this shape is
// normalized separately (normalizeSupportConfig).
export interface SupportConfig {
  enabled: boolean;          // master switch — omits the 3 handoff tools from TOOLS when false
  notifyEmail?: string;      // overrides recipientFor() for handoff/ticket notifications
  webhookUrl?: string;       // generic outgoing webhook (Zapier/Make/n8n/LimeChat bridge)
  webhookSecret?: string;    // HMAC key for X-SalesHQ-Signature
  whatsappNumber?: string;   // digits only, E.164 without '+', e.g. "15551234567"
  freshdeskEnabled: boolean; // Phase 2 — real two-way CRM adapter
  freshdeskDomain?: string;  // subdomain only, e.g. "acme" for acme.freshdesk.com
  freshdeskApiKey?: string;
}

export const DEFAULT_SUPPORT_CONFIG: SupportConfig = { enabled: true, freshdeskEnabled: false };

export function normalizeSupportConfig(raw: Partial<SupportConfig> | null | undefined): SupportConfig {
  const r = raw ?? {};
  const webhookUrl = clampStr(r.webhookUrl, 500);
  return {
    enabled: clampBool(r.enabled, DEFAULT_SUPPORT_CONFIG.enabled),
    notifyEmail: clampStr(r.notifyEmail, 200),
    webhookUrl: webhookUrl && /^https?:\/\//i.test(webhookUrl) ? webhookUrl : undefined,
    webhookSecret: clampStr(r.webhookSecret, 200),
    whatsappNumber: clampStr(r.whatsappNumber, 20)?.replace(/[^\d]/g, "") || undefined,
    freshdeskEnabled: clampBool(r.freshdeskEnabled, DEFAULT_SUPPORT_CONFIG.freshdeskEnabled),
    freshdeskDomain: clampStr(r.freshdeskDomain, 100)
      ?.replace(/^https?:\/\//i, "")
      .replace(/\.freshdesk\.com.*$/i, "")
      .replace(/\/+$/, "") || undefined,
    freshdeskApiKey: clampStr(r.freshdeskApiKey, 200),
  };
}

// Developer-managed controls (backoffice app) — merchants can't see or edit.
export interface BackofficeMeta {
  plan?: string;              // trial | starter | growth | pro
  convoLimit?: number | null; // monthly AI-reply cap; null/absent = unlimited
  costCapUsd?: number | null; // monthly LLM spend ceiling
  botEnabled?: boolean;       // kill switch; false disables chat + popups
  notes?: string;
  status?: string;            // trial | active — synced from Shopify billing
  trialEndsAt?: string | null;
  topUpBalance?: number;      // extra AI replies purchased on top of the plan cap; never expires monthly, only spent
  topUpPurchaseIds?: string[]; // AppPurchaseOneTime ids already credited — idempotency for the webhook (bounded, last 50)
  pdfPageLimit?: number | null; // monthly PDF-import page cap; null = unlimited (comped)
  pdfPageBalance?: number;    // bundled top-up PDF pages; never expires, spent only when a parse exceeds the monthly cap
}

export interface ShopInfo {
  name?: string;
  ownerName?: string;
  contactEmail?: string;
  domain?: string;
  planName?: string;
  currencyCode?: string;
  shopCreatedAt?: string;
}

export interface ShopSettings {
  brandDescription: string;
  welcomeMessage: string;
  config: BotConfig;
  support: SupportConfig;
  backoffice: BackofficeMeta;
  shopInfo: ShopInfo;
}

export const DEFAULT_WELCOME =
  "Hi! 👋 I'm your personal shopping assistant. I can:\n" +
  "- **Find products** that fit your needs and budget\n" +
  "- **Compare items** side by side\n" +
  "- **Recommend picks** personalized to what you're browsing\n" +
  "- **Answer questions** on details, sizing, and stock\n\n" +
  "What are you looking for today?";
const EMPTY: ShopSettings = { brandDescription: "", welcomeMessage: "", config: DEFAULT_CONFIG, support: DEFAULT_SUPPORT_CONFIG, backoffice: {}, shopInfo: {} };

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= prisma
    .$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "ShopSettings" (
        "shop" TEXT NOT NULL PRIMARY KEY,
        "brandDescription" TEXT NOT NULL DEFAULT '',
        "welcomeMessage" TEXT NOT NULL DEFAULT '',
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    )
    .then(() =>
      prisma.$executeRawUnsafe(
        `ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "config" JSONB NOT NULL DEFAULT '{}'`,
      ),
    )
    .then(() =>
      prisma.$executeRawUnsafe(
        `ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "backoffice" JSONB NOT NULL DEFAULT '{}'`,
      ),
    )
    // Found by the OKF E2E on a fresh DB (2026-07-09): this column only ever
    // reached prod via an out-of-band db push, so the lazy path silently broke
    // every getSettings read on a clean database.
    .then(() =>
      prisma.$executeRawUnsafe(
        `ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "shopInfo" JSONB NOT NULL DEFAULT '{}'`,
      ),
    )
    .then(() =>
      prisma.$executeRawUnsafe(
        `ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "support" JSONB NOT NULL DEFAULT '{}'`,
      ),
    )
    .then(() => undefined)
    .catch((e) => {
      tableReady = null; // retry on next call
      throw e;
    });
  return tableReady;
}

const cache = new Map<string, { v: ShopSettings; at: number }>();
const TTL_MS = 60_000;

export async function getBackofficeMeta(shop: string): Promise<BackofficeMeta> {
  try {
    await ensureTable();
    const row = await prisma.shopSettings.findUnique({ where: { shop }, select: { backoffice: true } });
    return ((row as { backoffice?: unknown } | null)?.backoffice as BackofficeMeta) ?? {};
  } catch (err) {
    console.error("[settings] backoffice read failed:", (err as Error).message);
    return {};
  }
}

export async function getSettings(shop: string): Promise<ShopSettings> {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  try {
    await ensureTable();
    const row = await prisma.shopSettings.findUnique({ where: { shop } });
    const v: ShopSettings = row
      ? {
          brandDescription: row.brandDescription,
          welcomeMessage: row.welcomeMessage,
          config: normalizeConfig(row.config as Partial<BotConfig>),
          support: normalizeSupportConfig((row as { support?: unknown }).support as Partial<SupportConfig>),
          backoffice: ((row as { backoffice?: unknown }).backoffice as BackofficeMeta) ?? {},
          shopInfo: ((row as { shopInfo?: unknown }).shopInfo as ShopInfo) ?? {},
        }
      : EMPTY;
    cache.set(shop, { v, at: Date.now() });
    return v;
  } catch (err) {
    // Fail soft: an unbranded reply beats a failed turn.
    console.error("[settings] read failed:", (err as Error).message);
    return hit?.v ?? EMPTY;
  }
}

export async function getShopInfo(shop: string): Promise<ShopInfo> {
  try {
    await ensureTable();
    const row = await prisma.shopSettings.findUnique({ where: { shop }, select: { shopInfo: true } });
    return ((row as { shopInfo?: unknown } | null)?.shopInfo as ShopInfo) ?? {};
  } catch (err) {
    console.error("[settings] shopInfo read failed:", (err as Error).message);
    return {};
  }
}

export async function saveSettings(shop: string, s: ShopSettings): Promise<void> {
  await ensureTable();
  const brandDescription = s.brandDescription.trim().slice(0, 2000);
  const welcomeMessage = s.welcomeMessage.trim().slice(0, 500);
  const config = normalizeConfig(s.config);
  const support = normalizeSupportConfig(s.support);
  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, brandDescription, welcomeMessage, config: config as unknown as object, support: support as unknown as object, backoffice: s.backoffice as unknown as object, shopInfo: s.shopInfo as unknown as object },
    update: { brandDescription, welcomeMessage, config: config as unknown as object, support: support as unknown as object },
  });
  cache.set(shop, { v: { brandDescription, welcomeMessage, config, support, backoffice: s.backoffice ?? {}, shopInfo: s.shopInfo ?? {} }, at: Date.now() });
}

/** Developer-only: update the backoffice controls without touching merchant fields. */
export async function saveBackoffice(shop: string, meta: BackofficeMeta): Promise<void> {
  await ensureTable();
  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, backoffice: meta as unknown as object },
    update: { backoffice: meta as unknown as object },
  });
  cache.delete(shop); // next read picks up fresh meta
}

/** Admin-load sync: store read-only shop metadata without touching merchant settings. */
export async function saveShopInfo(shop: string, info: ShopInfo): Promise<void> {
  await ensureTable();
  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, shopInfo: info as unknown as object },
    update: { shopInfo: info as unknown as object },
  });
  cache.delete(shop);
}

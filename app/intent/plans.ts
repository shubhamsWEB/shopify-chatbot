// Single source of truth for billing tiers. Shopify BILLING (shopify.server),
// the billing sync, and the merchant upgrade UI all derive from this map.
//
// WHY REPLIES, NOT CONVERSATIONS: the real COGS driver is the LLM. Each shopper
// question triggers ~2-3 model calls (agent tool loop) plus intent + followups,
// so one "conversation" of 45 messages can cost ~$1 while a single-question one
// costs ~$0.02. Pricing per conversation lets a heavy session run unbounded
// cost on a fixed fee. So we meter the measurable cost unit:
//   1) AI replies / month  — the merchant-facing quota (one assistant answer)
//   2) LLM cost cap / month — hard margin backstop; only bites on abuse
// The storefront gate (assertBotOperational) blocks when EITHER is exceeded.

// Blended cost of one AI reply, from live metering (Sonnet-5 chat loop ~$0.014 +
// Haiku followups/intent ~$0.004 + analytics amortized). Tune as usage data grows.
export const COST_PER_REPLY_USD = 0.02;

export interface PlanDef {
  price: number;        // USD / 30 days
  replies: number;      // monthly AI-reply quota (assistant answers)
  costCapUsd: number;   // monthly LLM spend ceiling (margin/abuse backstop)
  blurb: string;
}

export const PLANS = {
  Starter: { price: 29, replies: 500, costCapUsd: 20, blurb: "For new stores getting started" },
  Growth: { price: 79, replies: 1500, costCapUsd: 60, blurb: "For growing stores with steady traffic" },
  Pro: { price: 199, replies: 4000, costCapUsd: 160, blurb: "For high-volume stores" },
} as const satisfies Record<string, PlanDef>;

export type PlanName = keyof typeof PLANS;
export const PLAN_NAMES = Object.keys(PLANS) as PlanName[];

export const ENTRY_PLAN: PlanName = "Starter";

// Free trial: short, and hard-capped on both replies and LLM spend so an
// unpaid store can't run up cost. Trial = an ACTIVE subscription in its trial
// window (hasActivePayment true), so the storefront works during it.
export const TRIAL_DAYS = 7;
export const TRIAL_REPLY_CAP = 250;
export const TRIAL_COST_CAP_USD = 10;

/** Case-insensitive plan lookup. "comped"/"trial" and unknowns return null. */
export function findPlan(name?: string | null): PlanName | null {
  if (!name) return null;
  const hit = PLAN_NAMES.find((p) => p.toLowerCase() === name.toLowerCase());
  return hit ?? null;
}

/** Monthly reply cap for a plan name. comped = unlimited; unknown = null. */
export function capForPlan(name?: string | null): number | null {
  if (name && name.toLowerCase() === "comped") return null; // developer comp
  const p = findPlan(name);
  return p ? PLANS[p].replies : null;
}

/** Monthly LLM cost cap for a plan name. comped = no cap; unknown = null. */
export function costCapForPlan(name?: string | null): number | null {
  if (name && name.toLowerCase() === "comped") return null;
  const p = findPlan(name);
  return p ? PLANS[p].costCapUsd : null;
}

// PDF-import page budget, per billing cycle (audit 2026-07-09). Each Gemini
// parse costs ~$0.0008/page at list price — trivial per document, but with no
// per-plan cap a merchant could script thousands of pages/day. The ladder
// mirrors the reply caps: makes PDF import a visible plan-tier perk and bounds
// worst-case cost per shop. Enforced against a monthly PdfPageCount counter
// (pdfparse.server.ts), separate from the daily per-shop rate limit (abuse
// guard) that already exists.
export const TRIAL_PDF_PAGE_CAP = 50;
export const PDF_PAGE_CAPS: Record<PlanName, number> = {
  Starter: 200,
  Growth: 600,
  Pro: 2000,
};

/** Monthly PDF page cap for a plan name. comped = unlimited (null); unknown
 * (incl. "trial") = null — callers use TRIAL_PDF_PAGE_CAP for the pre-plan trial. */
export function pdfPageCapFor(name?: string | null): number | null {
  if (name && name.toLowerCase() === "comped") return null;
  const p = findPlan(name);
  return p ? PDF_PAGE_CAPS[p] : null;
}

// Top-up packs (spec: one-time purchase, per Shopify's AppPurchaseOneTime —
// preferred over usage-based billing for a discrete "buy more when exhausted"
// action; simpler, matches the flat-tier model, no recurring metering). A
// merchant only sees these once they hold an active plan (top-ups extend a
// paid plan, not the pre-plan trial). Priced above COST_PER_REPLY_USD with a
// volume discount at larger packs, in line with how the base plans price
// (Starter ≈$0.058/reply) — a top-up at a similar or slightly higher per-reply
// rate keeps margin and doesn't make "just buy more" cheaper than upgrading.
export interface TopUpPack {
  name: string;      // also the Shopify billing "plan" key (one-time charge name)
  replies: number;
  pdfPages: number;  // bundled PDF-import pages (replies/10) — non-expiring balance, spent after the monthly plan cap
  priceUsd: number;
}

// Per-reply ladder tracks the plans (Starter $0.058 → Growth $0.053 → Pro
// $0.050) sitting just above the equivalent-volume plan rate, so a pack never
// undercuts upgrading but never feels like a penalty either:
//   500 → $35 ($0.070)   ·  2,000 → $119 ($0.0595)
// 5,000 → $275 ($0.055)  · 10,000 → $499 ($0.0499)
// All comfortably above COST_PER_REPLY_USD ($0.02 blended COGS).
export const TOPUP_PACKS: TopUpPack[] = [
  { name: "Top-up 500", replies: 500, pdfPages: 50, priceUsd: 35 },
  { name: "Top-up 2000", replies: 2000, pdfPages: 200, priceUsd: 119 },
  { name: "Top-up 5000", replies: 5000, pdfPages: 500, priceUsd: 275 },
  { name: "Top-up 10000", replies: 10000, pdfPages: 1000, priceUsd: 499 },
];

export const TOPUP_PACK_NAMES = TOPUP_PACKS.map((p) => p.name);

export function topUpPackByName(name?: string | null): TopUpPack | null {
  if (!name) return null;
  return TOPUP_PACKS.find((p) => p.name === name) ?? null;
}

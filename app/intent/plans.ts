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

// Bridges Shopify's subscription state into the backoffice meta the storefront
// gate already enforces. Called from the app.tsx loader on each admin load:
// the merchant's active tier becomes their plan + monthly convo cap, with no
// extra storefront code (proxy.chat → assertBotOperational reads convoLimit).
import type { authenticate } from "../shopify.server";
import { PLANS, PLAN_NAMES, capForPlan, costCapForPlan, TRIAL_REPLY_CAP, TRIAL_COST_CAP_USD, type PlanName } from "./plans";
import { getBackofficeMeta, saveBackoffice } from "./settings.server";

type AdminCtx = Awaited<ReturnType<typeof authenticate.admin>>;
type Billing = AdminCtx["billing"];
type Admin = AdminCtx["admin"];

/** Highest-priced active plan for this shop, or null if none active. */
async function activePlan(billing: Billing, isTest: boolean): Promise<PlanName | null> {
  const res = await billing.check({ plans: PLAN_NAMES, isTest }).catch(() => null);
  if (!res?.hasActivePayment) return null;
  const active = new Set((res.appSubscriptions ?? []).map((s) => s.name));
  // Pick the richest active tier (a store could hold more than one line item).
  return [...PLAN_NAMES].sort((a, b) => PLANS[b].price - PLANS[a].price).find((p) => active.has(p)) ?? null;
}

const SUB_QUERY = `#graphql
  query BillingTrial {
    currentAppInstallation {
      activeSubscriptions { name status createdAt trialDays }
    }
  }`;

type SubStatus = { status: "trial" | "active"; trialEndsAt: string | null };

/** Trial vs active + trial-end for the given plan, via the subscription's
 * createdAt + trialDays. Fail-soft → treated as active if unknown. */
async function subStatus(admin: Admin, plan: PlanName): Promise<SubStatus> {
  try {
    const resp = await admin.graphql(SUB_QUERY);
    const body = (await resp.json()) as {
      data?: { currentAppInstallation?: { activeSubscriptions?: Array<{ name: string; createdAt: string; trialDays: number }> } };
    };
    const subs = body.data?.currentAppInstallation?.activeSubscriptions ?? [];
    const sub = subs.find((s) => s.name === plan) ?? subs[0];
    const days = Number(sub?.trialDays ?? 0);
    if (sub?.createdAt && days > 0) {
      const end = new Date(sub.createdAt).getTime() + days * 86_400_000;
      if (Date.now() < end) return { status: "trial", trialEndsAt: new Date(end).toISOString() };
    }
    return { status: "active", trialEndsAt: null };
  } catch {
    return { status: "active", trialEndsAt: null };
  }
}

/**
 * Sync the active Shopify subscription → backoffice plan + convoLimit + trial
 * status. Fail-soft (never throws into the loader). Skips `comped` shops so
 * developer comps aren't overwritten, and only writes when something changed.
 */
export async function syncBilling(shop: string, billing: Billing, admin: Admin, isTest: boolean): Promise<void> {
  try {
    const meta = await getBackofficeMeta(shop);
    if ((meta.plan ?? "").toLowerCase() === "comped") return; // manual override wins

    const plan = await activePlan(billing, isTest);
    if (!plan) return; // no active subscription — leave meta as-is

    const { status, trialEndsAt } = await subStatus(admin, plan);
    // During the trial, apply the low trial caps (both replies and $), not the
    // plan's — a 7-day unpaid store can't run up cost. After trial → plan caps.
    const convoLimit = status === "trial" ? TRIAL_REPLY_CAP : capForPlan(plan);
    const costCapUsd = status === "trial" ? TRIAL_COST_CAP_USD : costCapForPlan(plan);
    if (
      meta.plan === plan && meta.convoLimit === convoLimit && meta.costCapUsd === costCapUsd &&
      meta.status === status && meta.trialEndsAt === trialEndsAt
    ) {
      return; // no change
    }
    await saveBackoffice(shop, { ...meta, plan, convoLimit, costCapUsd, status, trialEndsAt });
  } catch (err) {
    console.error("[billing] sync failed:", (err as Error).message);
  }
}

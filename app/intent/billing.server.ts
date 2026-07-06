// Bridges Shopify's subscription state into the backoffice meta the storefront
// gate already enforces. Called from the app.tsx loader on each admin load:
// the merchant's active tier becomes their plan + monthly convo cap, with no
// extra storefront code (proxy.chat → assertBotOperational reads convoLimit).
import type { authenticate } from "../shopify.server";
import { ENTRY_PLAN, PLANS, PLAN_NAMES, TRIAL_DAYS, capForPlan, costCapForPlan, TRIAL_REPLY_CAP, TRIAL_COST_CAP_USD, type PlanName } from "./plans";
import { getBackofficeMeta, saveBackoffice, type BackofficeMeta } from "./settings.server";

type AdminCtx = Awaited<ReturnType<typeof authenticate.admin>>;
type Billing = AdminCtx["billing"];
type Admin = AdminCtx["admin"];
type BillingState = { meta: BackofficeMeta; activePlan: PlanName | null; trialActive: boolean };

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

export function trialActive(meta: BackofficeMeta): boolean {
  return meta.status === "trial" && !!meta.trialEndsAt && Date.now() < new Date(meta.trialEndsAt).getTime();
}

export function trialExpired(meta: BackofficeMeta): boolean {
  return meta.status === "trial_expired" || (meta.status === "trial" && !!meta.trialEndsAt && Date.now() >= new Date(meta.trialEndsAt).getTime());
}

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
  await ensureBillingState(shop, billing, admin, isTest);
}

/**
 * Keep billing/backoffice state current without forcing Shopify plan approval on
 * first install. New installs get an internal capped trial; paid approval is
 * requested only from the Plan & usage page.
 */
export async function ensureBillingState(shop: string, billing: Billing, admin: Admin, isTest: boolean): Promise<BillingState> {
  try {
    const meta = await getBackofficeMeta(shop);
    if ((meta.plan ?? "").toLowerCase() === "comped") return { meta, activePlan: null, trialActive: false }; // manual override wins

    const plan = await activePlan(billing, isTest);
    if (plan) {
      const { status, trialEndsAt } = await subStatus(admin, plan);
      // During the Shopify trial, apply the low trial caps (both replies and $),
      // not the plan's. After trial → plan caps.
      const convoLimit = status === "trial" ? TRIAL_REPLY_CAP : capForPlan(plan);
      const costCapUsd = status === "trial" ? TRIAL_COST_CAP_USD : costCapForPlan(plan);
      const next = { ...meta, plan, convoLimit, costCapUsd, status, trialEndsAt };
      if (
        meta.plan !== plan || meta.convoLimit !== convoLimit || meta.costCapUsd !== costCapUsd ||
        meta.status !== status || meta.trialEndsAt !== trialEndsAt
      ) {
        await saveBackoffice(shop, next);
      }
      return { meta: next, activePlan: plan, trialActive: status === "trial" };
    }

    if (trialActive(meta)) return { meta, activePlan: null, trialActive: true };

    if (trialExpired(meta)) {
      const next = { ...meta, status: "trial_expired", trialEndsAt: meta.trialEndsAt ?? null, convoLimit: 0, costCapUsd: 0 };
      if (meta.status !== next.status || meta.convoLimit !== 0 || meta.costCapUsd !== 0) await saveBackoffice(shop, next);
      return { meta: next, activePlan: null, trialActive: false };
    }

    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString();
    const next = {
      ...meta,
      plan: meta.plan ?? ENTRY_PLAN,
      convoLimit: TRIAL_REPLY_CAP,
      costCapUsd: TRIAL_COST_CAP_USD,
      status: "trial",
      trialEndsAt,
    };
    await saveBackoffice(shop, next);
    return { meta: next, activePlan: null, trialActive: true };
  } catch (err) {
    console.error("[billing] sync failed:", (err as Error).message);
    return { meta: await getBackofficeMeta(shop), activePlan: null, trialActive: false };
  }
}

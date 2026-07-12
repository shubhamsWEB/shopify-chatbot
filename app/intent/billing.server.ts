// Bridges Shopify's subscription state into the backoffice meta the storefront
// gate already enforces. Called from the app.tsx loader on each admin load:
// the merchant's active tier becomes their plan + monthly convo cap, with no
// extra storefront code (proxy.chat → assertBotOperational reads convoLimit).
import type { authenticate } from "../shopify.server";
import { PLANS, PLAN_NAMES, TRIAL_DAYS, capForPlan, costCapForPlan, pdfPageCapFor, TRIAL_REPLY_CAP, TRIAL_COST_CAP_USD, TRIAL_PDF_PAGE_CAP, type PlanName } from "./plans";
import { getBackofficeMeta, saveBackoffice, type BackofficeMeta } from "./settings.server";

type AdminCtx = Awaited<ReturnType<typeof authenticate.admin>>;
type Admin = AdminCtx["admin"];
type BillingState = { meta: BackofficeMeta; activePlan: PlanName | null; trialActive: boolean };

const SUB_QUERY = `#graphql
  query ActiveSubs {
    currentAppInstallation {
      activeSubscriptions { name status createdAt trialDays }
    }
  }`;

type ActiveSub = { name: string; status: string; createdAt: string; trialDays: number };

/**
 * The shop's active app subscriptions, read straight from the Admin API. This
 * is TEST-AGNOSTIC — `billing.check({isTest})` only returns charges matching a
 * single test flag, so on production (SHOPIFY_BILLING_TEST defaults true) it
 * silently missed the merchant's REAL live Pro/Starter subscription and the
 * backoffice fell back to "trial" while Shopify showed the paid plan (sync bug
 * report, 2026-07-08). `activeSubscriptions` returns every active sub whatever
 * the test flag, so plan detection matches Shopify exactly.
 */
async function fetchActiveSubs(admin: Admin): Promise<ActiveSub[]> {
  try {
    const resp = await admin.graphql(SUB_QUERY);
    const body = (await resp.json()) as {
      data?: { currentAppInstallation?: { activeSubscriptions?: ActiveSub[] } };
    };
    return body.data?.currentAppInstallation?.activeSubscriptions ?? [];
  } catch {
    return [];
  }
}

/** Richest of our plans among the shop's active subscriptions, or null. */
function planFromSubs(subs: ActiveSub[]): PlanName | null {
  const active = new Set(subs.map((s) => s.name));
  return [...PLAN_NAMES].sort((a, b) => PLANS[b].price - PLANS[a].price).find((p) => active.has(p)) ?? null;
}

type SubStatus = { status: "trial" | "active"; trialEndsAt: string | null };

export function trialActive(meta: BackofficeMeta): boolean {
  return meta.status === "trial" && !!meta.trialEndsAt && Date.now() < new Date(meta.trialEndsAt).getTime();
}

export function trialExpired(meta: BackofficeMeta): boolean {
  return meta.status === "trial_expired" || (meta.status === "trial" && !!meta.trialEndsAt && Date.now() >= new Date(meta.trialEndsAt).getTime());
}

/** Trial vs active + trial-end for the subscribed plan, via its createdAt +
 * trialDays. Pure — reads the already-fetched subs. */
function subStatus(subs: ActiveSub[], plan: PlanName): SubStatus {
  const sub = subs.find((s) => s.name === plan) ?? subs[0];
  const days = Number(sub?.trialDays ?? 0);
  if (sub?.createdAt && days > 0) {
    const end = new Date(sub.createdAt).getTime() + days * 86_400_000;
    if (Date.now() < end) return { status: "trial", trialEndsAt: new Date(end).toISOString() };
  }
  return { status: "active", trialEndsAt: null };
}

/**
 * Keep billing/backoffice state current without forcing Shopify plan approval on
 * first install. New installs get an internal capped trial; paid approval is
 * requested only from the Plan & usage page.
 */
export async function ensureBillingState(shop: string, admin: Admin): Promise<BillingState> {
  try {
    const meta = await getBackofficeMeta(shop);
    if ((meta.plan ?? "").toLowerCase() === "comped") return { meta, activePlan: null, trialActive: false }; // manual override wins

    const subs = await fetchActiveSubs(admin);
    const plan = planFromSubs(subs);
    if (plan) {
      const { status, trialEndsAt } = subStatus(subs, plan);
      // Once a plan is actively subscribed, the merchant gets THAT PLAN's
      // reply/cost cap — even during Shopify's own pre-charge trial window on
      // the subscription. Applying TRIAL_REPLY_CAP here was the bug (2026-07-08
      // report): a merchant who picked Starter (500 replies) was stuck at 250
      // for their whole Shopify trial. status/trialEndsAt are still tracked for
      // the "trial ends in N days" UI banner, just no longer used to pick the cap.
      //
      // Caps are (re)derived from the plan ONLY when the plan itself changed or
      // no cap is set yet. This sync runs on every admin page load — deriving
      // unconditionally silently clobbered any manual backoffice adjustment
      // (developer bumps a shop to a custom limit → merchant opens any admin
      // page → limit snaps back to the plan default; second half of the same
      // bug report). A developer override on an unchanged plan now sticks.
      const planChanged = meta.plan !== plan;
      const convoLimit = planChanged || meta.convoLimit == null ? capForPlan(plan) : meta.convoLimit;
      const costCapUsd = planChanged || meta.costCapUsd == null ? costCapForPlan(plan) : meta.costCapUsd;
      const pdfPageLimit = planChanged || meta.pdfPageLimit == null ? pdfPageCapFor(plan) : meta.pdfPageLimit;
      const next = { ...meta, plan, convoLimit, costCapUsd, pdfPageLimit, status, trialEndsAt };
      if (
        meta.plan !== plan || meta.convoLimit !== convoLimit || meta.costCapUsd !== costCapUsd ||
        meta.pdfPageLimit !== pdfPageLimit || meta.status !== status || meta.trialEndsAt !== trialEndsAt
      ) {
        await saveBackoffice(shop, next);
      }
      return { meta: next, activePlan: plan, trialActive: status === "trial" };
    }

    if (trialActive(meta)) {
      // Normalize a stale plan label mid-trial: shops whose trial state was
      // written by the pre-2026-07-08 code carry plan="Starter" (the old
      // ENTRY_PLAN default) even though no subscription exists — and this
      // early-return kept that label alive forever, since the "label as
      // trial" write below only runs when a trial is (re)initialized. With no
      // active sub, the truthful label during the internal trial is "trial".
      if (meta.plan !== "trial") {
        const next = { ...meta, plan: "trial" };
        await saveBackoffice(shop, next);
        return { meta: next, activePlan: null, trialActive: true };
      }
      return { meta, activePlan: null, trialActive: true };
    }

    if (trialExpired(meta)) {
      const next = { ...meta, status: "trial_expired", trialEndsAt: meta.trialEndsAt ?? null, convoLimit: 0, costCapUsd: 0, pdfPageLimit: 0 };
      if (meta.status !== next.status || meta.convoLimit !== 0 || meta.costCapUsd !== 0 || meta.pdfPageLimit !== 0) await saveBackoffice(shop, next);
      return { meta: next, activePlan: null, trialActive: false };
    }

    // No active Shopify subscription → the pre-plan internal trial. Label the
    // plan "trial" (was ENTRY_PLAN, which showed a misleading "Starter" badge in
    // the backoffice while no plan was actually chosen — sync bug report). Once
    // the merchant approves a plan, the branch above flips plan → that tier and
    // re-derives the caps, keeping Shopify and the backoffice in lockstep.
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString();
    const next = {
      ...meta,
      plan: "trial",
      convoLimit: TRIAL_REPLY_CAP,
      costCapUsd: TRIAL_COST_CAP_USD,
      pdfPageLimit: TRIAL_PDF_PAGE_CAP,
      status: "trial",
      trialEndsAt,
    };
    // First-time write, OR the plan just lapsed from a real tier back to trial.
    if (meta.plan !== "trial" || meta.status !== "trial" || meta.convoLimit !== TRIAL_REPLY_CAP || meta.pdfPageLimit !== TRIAL_PDF_PAGE_CAP) {
      await saveBackoffice(shop, next);
    }
    return { meta: next, activePlan: null, trialActive: true };
  } catch (err) {
    console.error("[billing] sync failed:", (err as Error).message);
    return { meta: await getBackofficeMeta(shop), activePlan: null, trialActive: false };
  }
}

// Merchant-facing plan & usage page. Shows the active subscription, this
// month's conversation usage against the plan cap, and lets the merchant
// upgrade/downgrade — which routes through Shopify's billing approval flow.
//
// The upgrade is triggered by a ?upgrade=<Plan> link, handled in the loader:
// billing.request throws a redirect to Shopify's confirmation page, which App
// Bridge follows at the top level. (A form POST from inside the embedded iframe
// cannot perform that top-level redirect — this loader path is the one that
// works, same mechanism as app.tsx's billing.require gate.)
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, PLAN_NAMES, capForPlan, findPlan, TRIAL_DAYS, TRIAL_REPLY_CAP, TOPUP_PACKS, topUpPackByName, type PlanName } from "../intent/plans";
import { monthlyReplies } from "../intent/transcript.server";
import { ensureBillingState } from "../intent/billing.server";

// eslint-disable-next-line no-undef
const isTest = () => process.env.SHOPIFY_BILLING_TEST !== "false";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const shop = session.shop;

  // Upgrade/downgrade request, or a top-up pack purchase — both throw a
  // redirect to Shopify's approval page (same mechanism, different billing
  // config: subscription vs one-time — see shopify.server BILLING).
  const params = new URL(request.url).searchParams;
  const upgrade = findPlan(params.get("upgrade"));
  const topup = topUpPackByName(params.get("topup"));
  let billingError = false;
  if (upgrade || topup) {
    try {
      return await billing.request({
        plan: (upgrade ?? topup!.name) as string,
        isTest: isTest(),
        returnUrl: `https://${shop}/admin/apps`, // back to the app after approval
      });
    } catch (err) {
      // A redirect is thrown as a Response — must propagate to reach Shopify.
      if (err instanceof Response) throw err;
      // Otherwise billing can't operate (app not set to public/Custom
      // distribution in the Partner Dashboard → "Apps without a public
      // distribution cannot use the Billing API"). Degrade gracefully instead
      // of crashing into the error boundary.
      console.error("[billing] request failed:", (err as Error).message);
      billingError = true;
    }
  }

  const [state, used] = await Promise.all([
    ensureBillingState(shop, admin),
    monthlyReplies(shop),
  ]);
  const meta = state.meta;

  const comped = (meta.plan ?? "").toLowerCase() === "comped";
  // Effective plan the storefront enforces: comp overrides billing.
  const current: PlanName | null = comped ? null : state.activePlan;
  // Effective reply cap actually enforced (trial cap during trial, else plan) —
  // billing sync writes it to meta.convoLimit; fall back to the plan's.
  const cap = comped ? null : (meta.convoLimit ?? capForPlan(current));

  const inTrial = !comped && meta.status === "trial" && !!meta.trialEndsAt;
  const trialExpired = !comped && meta.status === "trial_expired";
  const trialDaysLeft = inTrial ? Math.max(0, Math.ceil((new Date(meta.trialEndsAt!).getTime() - Date.now()) / 86_400_000)) : 0;

  return {
    current,
    comped,
    botEnabled: meta.botEnabled !== false,
    billingError,
    inTrial,
    trialExpired,
    trialDaysLeft,
    trialEndsAt: inTrial ? meta.trialEndsAt! : null,
    used,
    cap,
    // Top-ups only make sense once a plan is actually active — they extend a
    // paid plan's quota, not the pre-plan trial.
    topUpBalance: current ? (meta.topUpBalance ?? 0) : 0,
    canTopUp: !!current,
    plans: PLAN_NAMES.map((name) => ({ name, ...PLANS[name] })),
    topUpPacks: TOPUP_PACKS,
  };
};

export default function Billing() {
  const data = useLoaderData<typeof loader>();
  // When the loader handled an upgrade it returned a redirect (no page data).
  if (!data || !("plans" in data)) return null;
  const { current, comped, botEnabled, billingError, inTrial, trialExpired, trialDaysLeft, trialEndsAt, used, cap, topUpBalance, canTopUp, plans, topUpPacks } = data;
  const trialEndLabel = trialEndsAt ? new Date(trialEndsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  // Reaching the plan cap only actually stops the assistant once any
  // purchased top-up balance is also spent (botGate.server spends it first).
  const atPlanCap = cap != null && used >= cap;
  const over = atPlanCap && topUpBalance <= 0;
  const near = cap != null && !atPlanCap && used / cap >= 0.8;
  const barColor = over ? "#d72c0d" : atPlanCap || near ? "#e0a400" : "#008060";

  return (
    <s-page heading="Plan & usage">
      {billingError && (
        <s-banner tone="critical" heading="Couldn't start checkout">
          Billing isn&apos;t available for this app install yet. This happens when the app isn&apos;t set to public or Custom distribution in the Shopify Partner Dashboard. Once distribution is configured, plan selection will work.
        </s-banner>
      )}
      {!botEnabled && (
        <s-banner tone="critical" heading="Assistant disabled">
          Your shopping assistant is currently turned off. Contact SalesHQ support to restore service.
        </s-banner>
      )}
      {over && botEnabled && (
        <s-banner tone="warning" heading="Monthly AI reply limit reached">
          Your assistant is paused until the counter resets on the 1st — or buy a top-up pack or upgrade below to raise the limit right away.
        </s-banner>
      )}
      {atPlanCap && !over && botEnabled && (
        <s-banner tone="info" heading="Plan limit reached — running on your top-up balance">
          You have {topUpBalance.toLocaleString()} top-up {topUpBalance === 1 ? "reply" : "replies"} left this month; the assistant keeps working until that&apos;s spent too.
        </s-banner>
      )}
      {trialExpired && botEnabled && (
        <s-banner tone="warning" heading="Free trial ended">
          Choose a plan below to continue using the SalesHQ assistant on your storefront.
        </s-banner>
      )}

      <s-section heading="This month's usage">
        <s-paragraph>
          <s-text tone="neutral">
            {comped
              ? "Complimentary account — unlimited AI replies."
              : current
                ? `Current plan: `
                : inTrial
                  ? "Free trial — no plan approval needed yet."
                  : "No active subscription."}
          </s-text>
          {current && <s-text><b>{current}</b></s-text>}
          {inTrial && (
            <span style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", background: "#fff1e3", color: "#b98900", padding: "2px 10px", borderRadius: 100, fontSize: 12, fontWeight: 600 }}>
              Free trial · {trialDaysLeft} {trialDaysLeft === 1 ? "day" : "days"} left
            </span>
          )}
        </s-paragraph>
        {inTrial && (
          <s-paragraph>
            <s-text tone="neutral">You&apos;re on a free trial until {trialEndLabel}. Choose a plan any time — approving it ends the trial and starts your plan (and billing) right away, with the full plan limits.</s-text>
          </s-paragraph>
        )}

        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6d7175", marginBottom: 6 }}>
            <span>{used.toLocaleString()} AI replies</span>
            <span>{cap == null ? "Unlimited" : `${cap.toLocaleString()} limit`}</span>
          </div>
          <div style={{ height: 10, background: "#e3e5e8", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ width: `${cap == null ? 6 : Math.max(pct, 2)}%`, height: "100%", background: barColor, borderRadius: 6, transition: "width .3s" }} />
          </div>
          {cap != null && (
            <div style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>
              {over ? "Limit reached — assistant paused." : `${pct}% used · resets on the 1st`}
            </div>
          )}
          {canTopUp && topUpBalance > 0 && (
            <div style={{ fontSize: 12, color: "#008060", marginTop: 4 }}>
              + {topUpBalance.toLocaleString()} top-up {topUpBalance === 1 ? "reply" : "replies"} available (doesn&apos;t expire monthly)
            </div>
          )}
        </div>
      </s-section>

      {canTopUp && (
        <s-section heading="Top up AI replies">
          <s-paragraph>
            <s-text tone="neutral">
              Need more before the 1st? Buy a pack — it stacks on top of your plan and only gets spent once your monthly quota runs out. Never expires.
            </s-text>
          </s-paragraph>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16, marginTop: 12 }}>
            {topUpPacks.map((pack) => (
              <s-box key={pack.name} padding="base" borderWidth="base" borderRadius="base">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{pack.replies.toLocaleString()}</div>
                  <div style={{ fontSize: 12, color: "#6d7175" }}>AI replies</div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>${pack.priceUsd}</div>
                  <s-button variant="secondary" href={`/app/billing?topup=${encodeURIComponent(pack.name)}`}>
                    Buy
                  </s-button>
                </div>
              </s-box>
            ))}
          </div>
        </s-section>
      )}

      <s-section heading="Plans">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
          {plans.map((p) => {
            const isCurrent = p.name === current;
            return (
              <s-box key={p.name} padding="base" borderWidth="base" borderRadius="base" background={isCurrent ? "subdued" : undefined}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 200, justifyContent: "space-between" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18, fontWeight: 700 }}>{p.name}</span>
                      {isCurrent && <s-badge tone="success">Current</s-badge>}
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>
                      ${p.price}<span style={{ fontSize: 13, fontWeight: 400, color: "#6d7175" }}>/mo</span>
                    </div>
                    <div style={{ fontSize: 13, color: "#6d7175", marginTop: 4 }}>{p.blurb}</div>
                    <div style={{ fontSize: 14, marginTop: 12, fontWeight: 600 }}>
                      {p.replies.toLocaleString()} AI replies / mo
                    </div>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    {isCurrent ? (
                      <s-button variant="secondary" disabled>Current plan</s-button>
                    ) : (
                      <s-button variant="primary" href={`/app/billing?upgrade=${p.name}`}>
                        {current ? "Switch to this plan" : inTrial ? "Approve plan" : "Choose plan"}
                      </s-button>
                    )}
                  </div>
                </div>
              </s-box>
            );
          })}
        </div>
        <s-paragraph>
          <s-text tone="neutral">New installs get a {TRIAL_DAYS}-day capped trial ({TRIAL_REPLY_CAP.toLocaleString()} AI replies) before plan approval is required. One AI reply = one answer from the assistant. Charges are billed through Shopify after approval.</s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

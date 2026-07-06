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
import { PLANS, PLAN_NAMES, capForPlan, findPlan, TRIAL_DAYS, TRIAL_REPLY_CAP, type PlanName } from "../intent/plans";
import { monthlyReplies } from "../intent/transcript.server";
import { getBackofficeMeta } from "../intent/settings.server";

// eslint-disable-next-line no-undef
const isTest = () => process.env.SHOPIFY_BILLING_TEST !== "false";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;

  // Upgrade/downgrade request — throws a redirect to Shopify's approval page.
  const upgrade = findPlan(new URL(request.url).searchParams.get("upgrade"));
  let billingError = false;
  if (upgrade) {
    try {
      return await billing.request({
        plan: upgrade,
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

  const [check, used, meta] = await Promise.all([
    billing.check({ plans: PLAN_NAMES, isTest: isTest() }).catch(() => ({ hasActivePayment: false, appSubscriptions: [] as { name?: string }[] })),
    monthlyReplies(shop),
    getBackofficeMeta(shop),
  ]);

  const activeName = check.appSubscriptions?.[0]?.name ?? null;
  const comped = (meta.plan ?? "").toLowerCase() === "comped";
  // Effective plan the storefront enforces: comp overrides billing.
  const current: PlanName | null = comped ? null : findPlan(activeName);
  // Effective reply cap actually enforced (trial cap during trial, else plan) —
  // billing sync writes it to meta.convoLimit; fall back to the plan's.
  const cap = comped ? null : (meta.convoLimit ?? capForPlan(current));

  const inTrial = !comped && meta.status === "trial" && !!meta.trialEndsAt;
  const trialDaysLeft = inTrial ? Math.max(0, Math.ceil((new Date(meta.trialEndsAt!).getTime() - Date.now()) / 86_400_000)) : 0;

  return {
    current,
    comped,
    botEnabled: meta.botEnabled !== false,
    billingError,
    inTrial,
    trialDaysLeft,
    trialEndsAt: inTrial ? meta.trialEndsAt! : null,
    used,
    cap,
    plans: PLAN_NAMES.map((name) => ({ name, ...PLANS[name] })),
  };
};

export default function Billing() {
  const data = useLoaderData<typeof loader>();
  // When the loader handled an upgrade it returned a redirect (no page data).
  if (!data || !("plans" in data)) return null;
  const { current, comped, botEnabled, billingError, inTrial, trialDaysLeft, trialEndsAt, used, cap, plans } = data;
  const trialEndLabel = trialEndsAt ? new Date(trialEndsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const over = cap != null && used >= cap;
  const near = cap != null && !over && used / cap >= 0.8;
  const barColor = over ? "#d72c0d" : near ? "#e0a400" : "#008060";

  return (
    <s-page heading="Plan & usage">
      {billingError && (
        <s-banner tone="critical" heading="Couldn't start checkout">
          Billing isn't available for this app install yet. This happens when the app isn't set to public or Custom distribution in the Shopify Partner Dashboard. Once distribution is configured, plan selection will work.
        </s-banner>
      )}
      {!botEnabled && (
        <s-banner tone="critical" heading="Assistant disabled">
          Your shopping assistant is currently turned off. Contact SalesHQ support to restore service.
        </s-banner>
      )}
      {over && botEnabled && (
        <s-banner tone="warning" heading="Monthly AI reply limit reached">
          Your assistant is paused until the counter resets on the 1st, or upgrade below to raise the limit right away.
        </s-banner>
      )}

      <s-section heading="This month's usage">
        <s-paragraph>
          <s-text tone="neutral">
            {comped
              ? "Complimentary account — unlimited AI replies."
              : current
                ? `Current plan: `
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
            <s-text tone="neutral">You&apos;re on a free trial. First charge on {trialEndLabel} unless you cancel. Your assistant is fully active during the trial.</s-text>
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
        </div>
      </s-section>

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
                        {current ? "Switch to this plan" : "Choose plan"}
                      </s-button>
                    )}
                  </div>
                </div>
              </s-box>
            );
          })}
        </div>
        <s-paragraph>
          <s-text tone="neutral">Plans include a {TRIAL_DAYS}-day free trial (capped at {TRIAL_REPLY_CAP.toLocaleString()} AI replies). One AI reply = one answer from the assistant. Charges are billed through Shopify. Changing plans takes effect immediately after approval.</s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

// Compliance & privacy admin page. Shows what data the app stores for this shop,
// the plan/billing status, and GDPR tools so the merchant can export or erase a
// customer’s data on demand (beyond the automatic compliance webhooks).
import type { HeadersFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, PLAN } from "../shopify.server";
import prisma from "../db.server";
import { exportCustomer, redactCustomer } from "../intent/privacy.server";

// Default true; set SHOPIFY_BILLING_TEST=false only for the real launch.
// eslint-disable-next-line no-undef
const isTest = () => process.env.SHOPIFY_BILLING_TEST !== "false";
const PRIVACY_POLICY_URL = "https://saleshq-chatbot.vercel.app/privacy";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;

  const [events, profiles, billingCheck] = await Promise.all([
    prisma.event.count({ where: { shopId: shop } }),
    prisma.intentProfile.count({ where: { shopId: shop } }),
    billing.check({ plans: [PLAN], isTest: isTest() }).catch(() => ({ hasActivePayment: false, appSubscriptions: [] as { name?: string }[] })),
  ]);

  const sub = billingCheck.appSubscriptions?.[0];
  return {
    shop,
    counts: { events, profiles },
    plan: { name: sub?.name ?? PLAN, active: billingCheck.hasActivePayment },
    privacyPolicyUrl: PRIVACY_POLICY_URL,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const customerId = String(form.get("customerId") || "").trim();
  if (!customerId) return { error: "Enter a customer ID." };

  if (intent === "export") {
    const data = await exportCustomer(session.shop, customerId);
    return { exported: data, count: data.events.length + data.profiles.length };
  }
  if (intent === "redact") {
    await redactCustomer(session.shop, customerId);
    return { redacted: customerId };
  }
  return { error: "Unknown action." };
};

export default function Privacy() {
  const { counts, plan, privacyPolicyUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  const [customerId, setCustomerId] = useState("");
  const busy = fetcher.state !== "idle";
  const submit = (intent: "export" | "redact") => {
    if (!customerId.trim() || busy) return;
    if (intent === "redact" && !window.confirm(`Erase ALL data for customer ${customerId}? This cannot be undone.`)) return;
    fetcher.submit({ intent, customerId }, { method: "POST" });
  };

  return (
    <s-page heading="Compliance & privacy">
      <s-section heading="Subscription">
        <s-stack direction="inline" gap="base">
          <s-badge tone={plan.active ? "success" : "warning"}>
            {plan.active ? `${plan.name} — active` : "No active plan"}
          </s-badge>
          <s-link href="/app">Manage in app</s-link>
        </s-stack>
      </s-section>

      <s-section heading="Data we store for your shop">
        <s-stack direction="block" gap="small">
          <s-text>Behavioral events: <s-badge>{counts.events.toLocaleString()}</s-badge></s-text>
          <s-text>Intent profiles: <s-badge>{counts.profiles.toLocaleString()}</s-badge></s-text>
          <s-paragraph>
            <s-text tone="neutral">
              We store storefront behavioral events and derived shopper-intent profiles, scoped to your shop only.
              Tracking runs only with shopper consent (Shopify Customer Privacy API). All data is deleted automatically
              when the app is uninstalled or via Shopify’s GDPR webhooks. Read our{" "}
            </s-text>
            <s-link href={privacyPolicyUrl} target="_blank">privacy policy</s-link>.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Customer data requests (GDPR)">
        <s-paragraph>
          <s-text tone="neutral">
            Shopify forwards data-request and deletion requests automatically. You can also export or erase a
            specific customer’s data here using their Shopify customer ID.
          </s-text>
        </s-paragraph>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <input
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            placeholder="Shopify customer ID, e.g. 1234567890"
            style={{ flex: 1, maxWidth: 320, padding: "10px 14px", borderRadius: 10, border: "1px solid #c9cccf", fontSize: 14, outline: "none" }}
          />
          <s-button variant="secondary" onClick={() => submit("export")} {...(busy ? { loading: true } : {})}>Export data</s-button>
          <s-button variant="primary" tone="critical" onClick={() => submit("redact")} {...(busy ? { loading: true } : {})}>Erase data</s-button>
        </div>

        {result && "error" in result && result.error ? (
          <s-banner tone="critical">{result.error}</s-banner>
        ) : null}
        {result && "redacted" in result ? (
          <s-banner tone="success">Erased all data for customer {result.redacted}.</s-banner>
        ) : null}
        {result && "exported" in result ? (
          <s-section heading={`Export — ${result.count} record(s)`}>
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px", margin: 0 }}>
                {JSON.stringify(result.exported, null, 2)}
              </pre>
            </s-box>
          </s-section>
        ) : null}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

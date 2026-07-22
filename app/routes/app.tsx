import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureBillingState } from "../intent/billing.server";
import { syncShopInfo } from "../intent/shopinfo.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // First install gets a capped internal trial. Shopify billing approval is
  // requested only when the merchant chooses a paid plan from Plan & usage.
  const [{ meta: backoffice }] = await Promise.all([
    ensureBillingState(session.shop, admin),
    syncShopInfo(session.shop, admin),
  ]);

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    botEnabled: backoffice.botEnabled !== false,
  };
};

export default function App() {
  const { apiKey, botEnabled } = useLoaderData<typeof loader>();
  const homeRel = { rel: "home" };

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app" {...homeRel}>Overview</s-link>
        <s-link href="/app/intent">Intent</s-link>
        <s-link href="/app/assistant">Assistant</s-link>
        <s-link href="/app/knowledge">Knowledge</s-link>
        <s-link href="/app/support">Support</s-link>
        <s-link href="/app/billing">Plan & usage</s-link>
        <s-link href="/app/privacy">Compliance</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      {!botEnabled ? (
        <s-banner tone="critical" heading="Service stopped">
          Your SalesHQ shopping assistant is temporarily disabled. Shoppers will not see the chat widget or receive AI-powered help until service is restored. Contact your SalesHQ account manager if you need assistance.
        </s-banner>
      ) : null}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export { EmbeddedErrorBoundary as ErrorBoundary } from "../embedded-boundary";

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

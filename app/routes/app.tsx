import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate, PLAN } from "../shopify.server";
import { getBackofficeMeta } from "../intent/settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  // Gate the app on an active subscription (14-day free trial). On no-subscription
  // (and a Partner-owned app) this redirects to Shopify's approval page.
  // isTest must be true for dev/test stores (they can't take real charges).
  // Default true; set SHOPIFY_BILLING_TEST=false only for the real launch.
  // eslint-disable-next-line no-undef
  const isTest = process.env.SHOPIFY_BILLING_TEST !== "false";
  try {
    await billing.require({
      plans: [PLAN],
      isTest,
      onFailure: async () => billing.request({ plan: PLAN, isTest }),
    });
  } catch (err) {
    // The redirect to the approval page is thrown as a Response — must propagate.
    if (err instanceof Response) throw err;
    // Otherwise billing can't operate (e.g. app still owned by a Shop, not a
    // Partner org — appSubscriptionCreate is rejected). Don't crash the admin;
    // self-heals once the app is migrated to a Partner organization.
    console.error("[billing] gate skipped:", (err as Error).message,
      JSON.stringify((err as { errorData?: unknown }).errorData ?? null));
  }

  // eslint-disable-next-line no-undef
  const backoffice = await getBackofficeMeta(session.shop);
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    botEnabled: backoffice.botEnabled !== false,
  };
};

export default function App() {
  const { apiKey, botEnabled } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Overview</s-link>
        <s-link href="/app/intent">Intent profiles</s-link>
        <s-link href="/app/assistant">Analytics assistant</s-link>
        <s-link href="/app/privacy">Compliance</s-link>
        <s-link href="/app/settings">Bot settings</s-link>
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
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

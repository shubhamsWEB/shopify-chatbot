import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { shopifyApi, WebhookValidationErrorReason } from "@shopify/shopify-api";
import type { BillingConfigSubscriptionLineItemPlan } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { PLANS, PLAN_NAMES, TRIAL_DAYS, ENTRY_PLAN } from "./intent/plans";
import type { AdminGraphql } from "./intent/storefront-token.server";

// Tiered subscriptions, all with the configured free trial. app.tsx syncs ANY
// active plan; the active tier drives the storefront convo cap (see
// billing.server → syncBilling). isTest is on outside production so dev stores
// aren't charged. PLAN kept as the default/entry tier for existing callers.
export const PLAN = ENTRY_PLAN;
export const BILLING: Record<string, BillingConfigSubscriptionLineItemPlan> = Object.fromEntries(
  PLAN_NAMES.map((name) => [
    name,
    {
      trialDays: TRIAL_DAYS,
      lineItems: [
        {
          amount: PLANS[name].price,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    } satisfies BillingConfigSubscriptionLineItemPlan,
  ]),
);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: BILLING,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  hooks: {
    afterAuth: async ({ session, admin }) => {
      shopify.registerWebhooks({ session });

      // Mint + store the Storefront API token for this shop (spec §4.2/§4.4).
      // Dynamic import keeps shopify.server free of a load-time cycle.
      try {
        const { createAndStoreStorefrontToken } = await import("./intent/storefront-token.server");
        await createAndStoreStorefrontToken(admin as unknown as AdminGraphql, session.shop);
      } catch (err) {
        console.error("storefront token mint failed:", (err as Error).message);
      }

      // Connect the Web Pixel, pointing it at our ingestion endpoint (spec §4.4).
      const ingestUrl = `https://${session.shop}/apps/saleshq/ingest`;
      try {
        const res = await admin.graphql(
          `#graphql
          mutation CreatePixel($settings: JSON!) {
            webPixelCreate(webPixel: { settings: $settings }) {
              userErrors { field message }
              webPixel { id }
            }
          }`,
          { variables: { settings: JSON.stringify({ ingestUrl }) } },
        );
        // Surface userErrors — GraphQL 200s carry access/validation failures that a
        // catch never sees (a missing write_pixels scope failed here silently once).
        const body = (await res.json()) as { data?: { webPixelCreate?: { userErrors?: unknown[]; webPixel?: { id: string } } } };
        const errs = body.data?.webPixelCreate?.userErrors;
        if (errs?.length) console.error("webPixelCreate userErrors:", JSON.stringify(errs));
        else console.log("webPixelCreate ok:", body.data?.webPixelCreate?.webPixel?.id);
      } catch (err) {
        // ponytail: create throws if a pixel already exists — fine, ingestUrl is stable.
        console.warn("webPixelCreate skipped:", (err as Error).message);
      }
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

// HMAC-only webhook auth for purge handlers (app/uninstalled, shop/redact).
// authenticate.webhook() also loads/refreshes the offline session; on uninstall
// the token is revoked so refresh 500s and purgeShop never runs.
const webhookValidator = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY || "",
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(",") ?? [],
  hostName: "webhook-validator",
  isEmbeddedApp: true,
});

export async function validateWebhookOnly(request: Request) {
  if (request.method !== "POST") {
    throw new Response(undefined, { status: 405, statusText: "Method not allowed" });
  }
  const rawBody = await request.text();
  const check = await webhookValidator.webhooks.validate({ rawBody, rawRequest: request });
  if (!check.valid) {
    const unauthorized = check.reason === WebhookValidationErrorReason.InvalidHmac;
    throw new Response(undefined, {
      status: unauthorized ? 401 : 400,
      statusText: unauthorized ? "Unauthorized" : "Bad Request",
    });
  }
  return { shop: check.domain, topic: check.topic, payload: JSON.parse(rawBody) as unknown };
}

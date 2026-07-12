import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { shopifyApi, WebhookValidationErrorReason } from "@shopify/shopify-api";
import type { BillingConfigSubscriptionLineItemPlan, BillingConfigOneTimePlan } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { PLANS, PLAN_NAMES, ENTRY_PLAN, TOPUP_PACKS } from "./intent/plans";
import type { AdminGraphql } from "./intent/storefront-token.server";

// Tiered subscriptions. NO Shopify-side trialDays: the app's own pre-plan
// trial (TRIAL_DAYS/TRIAL_REPLY_CAP in intent/plans.ts, run by
// ensureBillingState) is THE trial. Approving a plan ends it and bills from
// day one — previously each subscription carried its own 7-day free window,
// so a merchant who picked a plan stayed labeled "Trial" for another week
// (double-trial, 2026-07-08 report). app.tsx syncs ANY active plan; the
// active tier drives the storefront convo cap. PLAN kept as the default/entry
// tier for existing callers.
export const PLAN = ENTRY_PLAN;
export const BILLING: Record<string, BillingConfigSubscriptionLineItemPlan | BillingConfigOneTimePlan> = {
  ...Object.fromEntries(
    PLAN_NAMES.map((name) => [
      name,
      {
        lineItems: [
          {
            amount: PLANS[name].price,
            currencyCode: "USD",
            interval: BillingInterval.Every30Days,
          },
        ],
      } satisfies BillingConfigSubscriptionLineItemPlan,
    ]),
  ),
  // AI-reply top-up packs — one-time purchases, not recurring (intent/plans.ts).
  ...Object.fromEntries(
    TOPUP_PACKS.map((pack) => [
      pack.name,
      { amount: pack.priceUsd, currencyCode: "USD", interval: BillingInterval.OneTime } satisfies BillingConfigOneTimePlan,
    ]),
  ),
};

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

      // Sync store details first (name/owner) so the day-0 welcome is
      // personalized, then send it immediately on install — this also seeds the
      // onboarding anchor; days 1/3/7 follow via the daily cron. Only the
      // welcome step is due at t=0. Fire-and-forget — never block install; if no
      // owner email is resolvable yet the cron retries.
      void (async () => {
        try {
          const { syncShopInfo } = await import("./intent/shopinfo.server");
          await syncShopInfo(session.shop, admin as unknown as Parameters<typeof syncShopInfo>[1]);
        } catch (err) {
          console.error("shopInfo sync before welcome failed:", (err as Error).message);
        }
        const { dispatchCampaign } = await import("./nudges/dispatch.server");
        await dispatchCampaign(session.shop, "onboarding");
      })().catch((err) => console.error("welcome-on-install failed:", (err as Error).message));
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

// Shopify fires APP_SUBSCRIPTIONS_UPDATE on every subscription change
// (approve, cancel, expire, decline). Re-deriving plan/caps/status here keeps
// the storefront gate in lockstep with Shopify billing deterministically —
// previously the sync only ran on admin page loads, so a cancel (or a
// subscribe from a lapsed trial) stayed stale until the merchant happened to
// open the admin. The payload isn't trusted for state: ensureBillingState
// re-queries activeSubscriptions itself.
import type { ActionFunctionArgs } from "react-router";
import { validateWebhookOnly, unauthenticated } from "../shopify.server";
import { ensureBillingState } from "../intent/billing.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await validateWebhookOnly(request);
  try {
    const { admin } = await unauthenticated.admin(shop);
    const { meta } = await ensureBillingState(shop, admin);
    console.log(`[billing] subscription webhook synced ${shop} → plan=${meta.plan} status=${meta.status}`);
  } catch (err) {
    // Fail-soft: the gate's self-heal and the next admin load still converge.
    console.error(`[billing] subscription webhook sync failed for ${shop}:`, (err as Error).message);
  }
  return new Response();
};

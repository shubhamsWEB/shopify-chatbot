import type { ActionFunctionArgs } from "react-router";
import { validateWebhookOnly } from "../shopify.server";
import { purgeShop } from "../intent/privacy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await validateWebhookOnly(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  // Purge ALL shop data, not just the session — tenant isolation + GDPR.
  // Idempotent: webhooks retry and can fire after uninstall.
  await purgeShop(shop);
  return new Response();
};

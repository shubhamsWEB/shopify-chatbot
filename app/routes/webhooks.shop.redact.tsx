// Mandatory GDPR webhook (Shopify App Store): shop/redact.
// Fires 48h after uninstall — erase ALL data we hold for the shop.
import type { ActionFunctionArgs } from "react-router";
import { validateWebhookOnly } from "../shopify.server";
import { purgeShop } from "../intent/privacy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await validateWebhookOnly(request);
  console.log(`[webhook] ${topic} for ${shop}`);
  await purgeShop(shop);
  return new Response();
};

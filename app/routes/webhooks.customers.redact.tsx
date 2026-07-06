// Mandatory GDPR webhook (Shopify App Store): customers/redact.
// Erase everything we hold on this customer.
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { redactCustomer } from "../intent/privacy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  const customerId = String((payload as { customer?: { id?: string | number } })?.customer?.id ?? "");
  console.log(`[webhook] ${topic} for ${shop} customer=${customerId}`);
  if (customerId) await redactCustomer(shop, customerId);
  return new Response();
};

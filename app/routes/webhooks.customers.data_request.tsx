// Mandatory GDPR webhook (Shopify App Store): customers/data_request.
// Assemble the data we hold on the customer so the merchant can provide it.
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { exportCustomer } from "../intent/privacy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  const customerId = String((payload as { customer?: { id?: string | number } })?.customer?.id ?? "");
  console.log(`[webhook] ${topic} for ${shop} customer=${customerId}`);

  if (customerId) {
    const data = await exportCustomer(shop, customerId);
    // ponytail: log the export; merchant retrieves it from the admin Privacy page.
    // Upgrade path: persist to a DataRequest table / email the owner if volume grows.
    console.log(`[privacy] data_request export`, JSON.stringify(data).slice(0, 2000));
  }
  return new Response();
};

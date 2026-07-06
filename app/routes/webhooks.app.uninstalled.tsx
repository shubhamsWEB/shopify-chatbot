import type { ActionFunctionArgs } from "react-router";
import { validateWebhookOnly } from "../shopify.server";
import { purgePiiOnUninstall } from "../intent/privacy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await validateWebhookOnly(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  // PII + credentials only — stats/billing rows stay for backoffice + reinstall caps.
  await purgePiiOnUninstall(shop);
  return new Response();
};

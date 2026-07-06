// Transaction-grade events (spec §4.1). HMAC is verified by authenticate.webhook.
// Respond 200 fast; the queue does the heavy lifting downstream.
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingest } from "../intent/hot.server";
import { normalizeWebhook } from "../intent/derive";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const event = normalizeWebhook({ topic, shop, payload });
  if (event) {
    await ingest(event).catch((err) => console.error(`ingest failed for ${topic}`, err));
  }

  return new Response();
};

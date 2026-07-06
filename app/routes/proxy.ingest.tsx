// Pixel ingestion behind the App Proxy. The pixel runs in a cross-origin
// sandbox, so it POSTs to the absolute shop URL https://{shop}/apps/saleshq/ingest
// — Shopify proxies it here WITH a signature, so the shop is trusted and the
// body's shopId (if any) is overridden. Keeps CORS for the sandbox origin.
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { CanonicalEventSchema } from "../intent/events";
import { ingest } from "../intent/hot.server";
import { assertBotOperational } from "../intent/botGate.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) return new Response("Unauthorized", { status: 401, headers: CORS });
  const shopId = session.shop;

  const blocked = await assertBotOperational(shopId, { cors: true });
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400, headers: CORS });
  }

  // Accept a single event, a bare array, or {events:[...]} (widget batching).
  const unwrapped = (body as { events?: unknown[] })?.events ?? body;
  const raw = (Array.isArray(unwrapped) ? unwrapped : [unwrapped]).slice(0, 25);
  const results = await Promise.allSettled(
    raw.map(async (item) => {
      // shopId from the verified proxy session — never trust the client's value.
      // Client may declare web_pixel or widget_seed (the seed dedupe depends on
      // it); privileged sources (chatbot/webhook) can't be spoofed from here.
      const claimed = (item as { source?: string })?.source;
      const source = claimed === "widget_seed" ? "widget_seed" : "web_pixel";
      const event = CanonicalEventSchema.parse({ ...(item as object), shopId, source });
      return ingest(event);
    }),
  );
  const accepted = results.filter((r) => r.status === "fulfilled").length;
  return Response.json({ accepted, rejected: results.length - accepted }, { headers: CORS });
}

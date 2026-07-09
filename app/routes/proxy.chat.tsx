// Chat endpoint behind the Shopify App Proxy. The shop is taken from the
// HMAC-verified proxy session, NEVER from the request body — this is the tenant
// isolation boundary. Storefront calls https://{shop}/apps/saleshq/chat.
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { runChat } from "../intent/chat.server";
import { ingest } from "../intent/hot.server";
import { allowLlm } from "../intent/ratelimit.server";
import { appendTranscript } from "../intent/transcript.server";
import { assertBotOperational, spendTopUpReply } from "../intent/botGate.server";
import { linkSessionToCustomer } from "../intent/identity.server";
import type { CanonicalEvent, EventType } from "../intent/events";

export const config = { maxDuration: 60 };

const Body = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).optional(),
  trigger: z.object({ type: z.string(), productId: z.string().optional() }).optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional(),
  cart: z.object({
    items: z.array(z.object({ title: z.string(), quantity: z.number(), price: z.number().optional() })),
    total: z.number().optional(),
    currency: z.string().optional(),
  }).optional(),
});

function logBot(shopId: string, sessionId: string, type: EventType, productId?: string) {
  const event: CanonicalEvent = {
    eventId: `bot_${type}_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    shopId, sessionId, type, timestamp: new Date().toISOString(), source: "chatbot", productId,
  };
  ingest(event).catch((err) => console.error(`bot event ${type} failed`, err));
}

export async function action({ request }: ActionFunctionArgs) {
  // Verifies the proxy signature + that the shop has the app installed.
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session?.shop) return new Response("Unauthorized", { status: 401 });
  const shopId = session.shop;
  // Shopify appends this to the signed proxy request only when the shopper is
  // logged in — never trust anything else for identity. This route never read
  // it (proxy.chat-stream.tsx did, but the widget doesn't call that route at
  // all — dead code), so get_my_orders/track_order/reorder always saw a guest,
  // even for a signed-in shopper (live bug report, 2026-07-07).
  const customerId = new URL(request.url).searchParams.get("logged_in_customer_id") || undefined;

  let body;
  try {
    body = Body.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (!body.message && !body.trigger) {
    return Response.json({ error: "message or trigger required" }, { status: 400 });
  }
  if (!(await allowLlm(shopId, body.sessionId))) {
    return Response.json({ response: "You're sending messages too fast. Please wait a moment.", products: [] }, { status: 429 });
  }

  const blocked = await assertBotOperational(shopId);
  if (blocked) {
    const payload = await blocked.json();
    return Response.json({ response: payload.message, products: [], serviceStopped: true }, { status: 503 });
  }

  // Stitches this session's guest browsing onto the customer once they log in.
  if (customerId) linkSessionToCustomer(shopId, body.sessionId, customerId).catch(() => {});

  try {
    const result = await runChat({ ...body, shopId, customerId, admin });
    if (result.comparison) logBot(shopId, body.sessionId, "bot_comparison_shown");
    for (const p of result.products) logBot(shopId, body.sessionId, "bot_suggestion_shown", p.productId);
    // Durable transcript so returning visitors get their conversation back.
    if (body.message) {
      await appendTranscript(shopId, body.sessionId, [
        { role: "user", content: body.message },
        { role: "assistant", content: result.response, products: result.products, followups: result.followups },
      ]);
    }
    // Over-quota shops run on purchased top-up replies; spend one now that a
    // reply was actually delivered (no-op while inside the plan quota).
    spendTopUpReply(shopId).catch(() => {});
    return Response.json(result);
  } catch (err) {
    console.error("chat failed", err);
    return Response.json({ response: "Sorry, I'm having trouble right now. Please try again.", products: [] });
  }
}

// Streaming chat endpoint behind the Shopify App Proxy — same auth/tenant
// isolation as proxy.chat, but the final answer streams token-by-token over SSE
// so the shopper sees text appear immediately. Events:
//   {type:"reset"}                       clear any interim text (a tool turn ran)
//   {type:"delta", text}                 append a token
//   {type:"done", ...ChatResult}         final products/followups/cartAdd + text
//   {type:"error", message}              fatal
// The widget falls back to POST /chat if this stream fails.
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { runChat } from "../intent/chat.server";
import { allowLlm } from "../intent/ratelimit.server";
import { appendTranscript } from "../intent/transcript.server";
import { assertBotOperational, spendTopUpReply } from "../intent/botGate.server";
import { linkSessionToCustomer } from "../intent/identity.server";
import { ingest } from "../intent/hot.server";
import type { CanonicalEvent, EventType } from "../intent/events";

export const config = { maxDuration: 60 };

const Body = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional(),
  cart: z.object({
    items: z.array(z.object({ title: z.string(), quantity: z.number(), price: z.number().optional() })),
    total: z.number().optional(),
    currency: z.string().optional(),
  }).optional(),
});

function logBot(shopId: string, sessionId: string, type: EventType, productId?: string, customerId?: string) {
  const event: CanonicalEvent = {
    eventId: `bot_${type}_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    shopId, sessionId, customerId, type, timestamp: new Date().toISOString(), source: "chatbot", productId,
  };
  ingest(event).catch((err) => console.error(`bot event ${type} failed`, err));
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session?.shop) return new Response("Unauthorized", { status: 401 });
  const shopId = session.shop;
  const customerId = new URL(request.url).searchParams.get("logged_in_customer_id") || undefined;

  let body;
  try { body = Body.parse(await request.json()); } catch { return Response.json({ error: "invalid body" }, { status: 400 }); }
  if (!body.message) return Response.json({ error: "message required" }, { status: 400 });
  if (!(await allowLlm(shopId, body.sessionId))) {
    return Response.json({ response: "You're sending messages too fast. Please wait a moment.", products: [] }, { status: 429 });
  }
  const blocked = await assertBotOperational(shopId);
  if (blocked) {
    const payload = await blocked.json();
    return Response.json({ response: payload.message, products: [], serviceStopped: true }, { status: 503 });
  }
  if (customerId) linkSessionToCustomer(shopId, body.sessionId, customerId).catch(() => {});

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      try {
        const result = await runChat({
          shopId, sessionId: body.sessionId, message: body.message, history: body.history, cart: body.cart, customerId, admin,
          stream: { onText: (t) => send({ type: "delta", text: t }), onReset: () => send({ type: "reset" }) },
        });
        if (result.comparison) logBot(shopId, body.sessionId, "bot_comparison_shown", undefined, customerId);
        for (const p of result.products) logBot(shopId, body.sessionId, "bot_suggestion_shown", p.productId, customerId);
        if (body.message) {
          await appendTranscript(shopId, body.sessionId, [
            { role: "user", content: body.message },
            { role: "assistant", content: result.response, products: result.products, followups: result.followups },
          ]);
        }
        spendTopUpReply(shopId).catch(() => {}); // over-quota shops pay from top-up balance per delivered reply
        send({ type: "done", ...result });
      } catch (err) {
        console.error("chat stream failed", err);
        send({ type: "error", message: "Sorry, I'm having trouble right now. Please try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}

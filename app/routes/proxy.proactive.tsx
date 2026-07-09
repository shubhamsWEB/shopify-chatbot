// Proactive popup decision behind the App Proxy. Shop from the verified proxy
// session, not the body. Storefront calls https://{shop}/apps/saleshq/proactive.
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { decideProactive } from "../intent/proactive.server";
import { appendTranscript } from "../intent/transcript.server";
import { ingest } from "../intent/hot.server";
import { allowLlm } from "../intent/ratelimit.server";
import { assertBotOperational, spendTopUpReply } from "../intent/botGate.server";
import type { CanonicalEvent, EventType } from "../intent/events";

export const config = { maxDuration: 60 };

const Body = z.object({
  sessionId: z.string().min(1),
  productId: z.string().optional(),
  surface: z.enum(["product", "cart", "checkout", "category", "search", "other"]).optional(),
  exitIntent: z.boolean().optional(),
  activeFormField: z.boolean().optional(),
  widgetOpen: z.boolean().optional(),
  debug: z.boolean().optional(),
});

function logBot(shopId: string, sessionId: string, type: EventType, productId?: string) {
  const event: CanonicalEvent = {
    eventId: `bot_${type}_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    shopId, sessionId, type, timestamp: new Date().toISOString(), source: "chatbot", productId,
  };
  ingest(event).catch((err) => console.error(`bot event ${type} failed`, err));
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) return new Response("Unauthorized", { status: 401 });
  const shopId = session.shop;

  const blocked = await assertBotOperational(shopId);
  if (blocked) return Response.json({ show: false, serviceStopped: true });

  let body;
  try {
    body = Body.parse(await request.json());
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  // Proactive runs on every page load — cap hard so it can't drain the LLM budget.
  if (!(await allowLlm(shopId, body.sessionId))) return Response.json({ show: false });

  try {
    const result = await decideProactive(shopId, body.sessionId, body.productId, {
      surface: body.surface,
      exitIntent: body.exitIntent,
      activeFormField: body.activeFormField,
      widgetOpen: body.widgetOpen,
      debug: body.debug,
    });
    if (result.show) {
      if (result.comparison) logBot(shopId, body.sessionId, "bot_comparison_shown");
      for (const p of result.products ?? []) logBot(shopId, body.sessionId, "bot_suggestion_shown", p.productId);
      await appendTranscript(shopId, body.sessionId, [
        { role: "assistant", content: result.response ?? "", products: result.products, followups: result.followups },
      ]);
      // A nudge was actually shown — spend a purchased top-up reply if the
      // shop is past its plan quota (no-op otherwise). Deliberately inside the
      // show branch: polls that decide not to fire must never spend.
      spendTopUpReply(shopId).catch(() => {});
    }
    return Response.json(result);
  } catch (err) {
    console.error("proactive failed", err);
    return Response.json({ show: false });
  }
}

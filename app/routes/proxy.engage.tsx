// Proactive engagement handler (spec §9.3). Fires when the shopper replies to a
// proactive popup — logs the handoff to the reactive chat graph (which already
// re-reads the established intent context). Behind the App Proxy.
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { onEngage } from "../intent/proactive.server";
import { assertBotOperational } from "../intent/botGate.server";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const Body = z.object({ sessionId: z.string().min(1) });

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) return new Response("Unauthorized", { status: 401, headers: CORS });
  const blocked = await assertBotOperational(session.shop, { cors: true });
  if (blocked) return blocked;
  let body;
  try { body = Body.parse(await request.json()); } catch { return Response.json({ ok: false }, { status: 400, headers: CORS }); }
  await onEngage(session.shop, body.sessionId);
  return Response.json({ ok: true }, { headers: CORS });
}

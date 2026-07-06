// Chat transcript restore behind the App Proxy: the widget calls this when its
// tab-local cache is empty (new tab / returning visitor with the same cookie).
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getTranscript } from "../intent/transcript.server";
import { assertBotOperational } from "../intent/botGate.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) return new Response("Unauthorized", { status: 401 });
  const blocked = await assertBotOperational(session.shop);
  if (blocked) return blocked;
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  if (!sessionId) return Response.json({ messages: [] });
  const messages = await getTranscript(session.shop, sessionId);
  return Response.json({ messages });
}

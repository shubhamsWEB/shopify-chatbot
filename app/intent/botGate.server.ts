// Central kill-switch gate for all App Proxy endpoints. Reads backoffice meta
// fresh from DB (no cache) so toggling in the developer backoffice takes effect
// immediately on the next request.
import { getBackofficeMeta } from "./settings.server";
import { monthlyReplies } from "./transcript.server";
import { monthlyCostUsd } from "./usage.server";
import { trialExpired } from "./billing.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function serviceStoppedBody() {
  return {
    error: "service_stopped" as const,
    message: "The assistant is temporarily unavailable. Please check back soon.",
  };
}

/** Returns a 503 Response when the bot is disabled or over its reply/cost cap; null if OK. */
export async function assertBotOperational(
  shop: string,
  opts?: { cors?: boolean },
): Promise<Response | null> {
  const backoffice = await getBackofficeMeta(shop);
  if (backoffice.botEnabled === false || trialExpired(backoffice)) {
    return Response.json(serviceStoppedBody(), { status: 503, headers: opts?.cors ? CORS : undefined });
  }
  const [replies, costUsd] = await Promise.all([monthlyReplies(shop), monthlyCostUsd(shop)]);
  if (backoffice.convoLimit != null && replies >= backoffice.convoLimit) {
    return Response.json(serviceStoppedBody(), { status: 503, headers: opts?.cors ? CORS : undefined });
  }
  if (backoffice.costCapUsd != null && costUsd >= backoffice.costCapUsd) {
    return Response.json(serviceStoppedBody(), { status: 503, headers: opts?.cors ? CORS : undefined });
  }
  return null;
}

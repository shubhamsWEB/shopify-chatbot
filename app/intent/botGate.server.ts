// Central kill-switch gate for all App Proxy endpoints. Reads backoffice meta
// fresh from DB (no cache) so toggling in the developer backoffice takes effect
// immediately on the next request.
import { getBackofficeMeta, saveBackoffice } from "./settings.server";
import { monthlyReplies } from "./transcript.server";
import { monthlyCostUsd } from "./usage.server";
import { trialExpired, freshBackofficeMeta } from "./billing.server";

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
  const backoffice = await freshBackofficeMeta(shop);
  if (backoffice.botEnabled === false || trialExpired(backoffice)) {
    return Response.json(serviceStoppedBody(), { status: 503, headers: opts?.cors ? CORS : undefined });
  }
  const [replies, costUsd] = await Promise.all([monthlyReplies(shop), monthlyCostUsd(shop)]);
  // Fire the usage nudges inline as usage crosses 80% — no wait for the daily
  // cron. dispatchCampaign runs every due step, so this one trigger covers both
  // the 80% warn and (once replies >= convoLimit) the 100% exhausted email.
  // Fire-and-forget (no await) → zero added latency; idempotent via claimStep,
  // so re-entry on every request/poll sends each step at most once per month.
  // ponytail: re-queries backoffice+replies inside the campaign on each request
  // once past 80%. Fine at current volume; if high-usage shops polling every
  // 15s get costly, debounce with a short KV flag before dispatching.
  if (backoffice.convoLimit != null && replies >= 0.8 * backoffice.convoLimit) {
    void import("../nudges/dispatch.server")
      .then((m) => m.dispatchCampaign(shop, "usage-limit"))
      .catch((err) => console.error("inline usage-limit nudge failed", err));
  }
  if (backoffice.convoLimit != null && replies >= backoffice.convoLimit) {
    // Plan quota exhausted — a purchased top-up balance (app/intent/plans.ts
    // TOPUP_PACKS) keeps the bot operational. The gate only CHECKS the balance;
    // spending happens in spendTopUpReply(), called by the routes that actually
    // deliver an AI reply. Decrementing here was a live bug (2026-07-08): this
    // gate runs on EVERY proxy route — pixel ingest (~10 events/session),
    // history, dismiss, and proactive polls every 15s — so an over-cap shop
    // drained its paid balance from background noise without a single reply.
    // A top-up-funded reply also skips the $ backstop below: the pack price has
    // margin over COST_PER_REPLY_USD baked in — it's paid for.
    const balance = backoffice.topUpBalance ?? 0;
    if (balance <= 0) {
      return Response.json(serviceStoppedBody(), { status: 503, headers: opts?.cors ? CORS : undefined });
    }
    return null;
  }
  if (backoffice.costCapUsd != null && costUsd >= backoffice.costCapUsd) {
    return Response.json(serviceStoppedBody(), { status: 503, headers: opts?.cors ? CORS : undefined });
  }
  return null;
}

/**
 * Spend one purchased top-up reply — call ONLY after an AI reply was actually
 * delivered (chat answer sent, proactive nudge shown). No-op while the shop is
 * still inside its plan quota, so callers can invoke it unconditionally.
 * Fire-and-forget safe.
 */
export async function spendTopUpReply(shop: string): Promise<void> {
  try {
    const backoffice = await getBackofficeMeta(shop);
    const balance = backoffice.topUpBalance ?? 0;
    if (backoffice.convoLimit == null || balance <= 0) return;
    const replies = await monthlyReplies(shop);
    if (replies < backoffice.convoLimit) return; // plan quota covered this reply
    // ponytail: read-modify-write, not an atomic decrement — a rare concurrent
    // double-spend at the last unit is acceptable at this request volume (same
    // tradeoff as claimEmit).
    await saveBackoffice(shop, { ...backoffice, topUpBalance: balance - 1 });
  } catch (err) {
    console.error("[botGate] spendTopUpReply failed:", (err as Error).message);
  }
}

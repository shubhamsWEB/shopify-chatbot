// Identity resolution: when a shopper is logged in (customerId known from the
// HMAC-signed logged_in_customer_id), stitch their guest session's events onto
// the customer so the customer-keyed intent profile includes pre-login browsing.
// This is the "customer mapping" that makes intent known per-customer, not just
// per-session (recentEvents matches customerId OR sessionId — see intent-ondemand).
import prisma from "../db.server";
import { ensureProfile } from "./intent-ondemand.server";

// In-memory throttle per (shop, session, customer) so we don't UPDATE on every
// event. 10-minute window is plenty — the backfill is idempotent anyway.
const linked = new Map<string, number>();
const TTL_MS = 10 * 60_000;

/**
 * Map a guest session's intent onto the customer once they're identified
 * (login). Backfills the session's pre-login events with the customerId, then
 * rebuilds the customer-keyed intent profile so their prior browsing shows up
 * immediately — not only on their next chat turn. Fire-and-forget, throttled.
 */
export async function linkSessionToCustomer(shop: string, sessionId: string, customerId: string): Promise<void> {
  if (!sessionId || !customerId) return;
  const key = `${shop}:${sessionId}:${customerId}`;
  const now = Date.now();
  const last = linked.get(key);
  if (last && now - last < TTL_MS) return;
  linked.set(key, now);
  try {
    const { count } = await prisma.event.updateMany({
      where: { shopId: shop, sessionId, customerId: null },
      data: { customerId },
    });
    // Rebuild the customer profile from the now-stitched events (includes the
    // guest browsing). ensureProfile is a no-op if nothing changed.
    if (count > 0) await ensureProfile(shop, customerId, sessionId).catch(() => {});
  } catch (err) {
    console.error("[identity] linkSessionToCustomer failed:", (err as Error).message);
  }
}

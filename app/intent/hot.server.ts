// Ingest path: every event (pixel, webhook, widget bot_*) lands in Postgres.
// The hot session + intent profile are derived from Event rows at read time
// (cache.server / intent-ondemand) — no Redis, no queue, no worker.
import prisma from "../db.server";
import type { CanonicalEvent } from "./events";
import type { LiveContext } from "./derive";
import type { PopupsState, Surface } from "./proactive/types";
import { maybeRollup } from "./retention.server";

export { profileKeyFor } from "./derive";
export type { LiveContext } from "./derive";

export interface HotSession {
  sessionId: string;
  shopId: string;
  customerId?: string;
  startedAt: string;
  lastEventAt: string;
  recentEvents: CanonicalEvent[];
  liveContext: LiveContext;
  // proactive subsystem fields (owned by app/intent/proactive)
  surface?: Surface;
  holdout?: boolean;
  popups?: PopupsState;
}

/**
 * Single ingest path for pixels + webhooks + bot_* events.
 * Idempotent on eventId so webhook retries are safe.
 */
export async function ingest(e: CanonicalEvent): Promise<{ deduped: boolean }> {
  // Widget-seed fallback: skip if the pixel already delivered the same signal
  // (same session/type/product within 90s) so healthy-pixel stores don't double-count.
  if (e.source === "widget_seed") {
    const dup = await prisma.event.findFirst({
      where: {
        shopId: e.shopId, sessionId: e.sessionId, type: e.type,
        productId: e.productId ?? undefined,
        source: { not: "widget_seed" },
        timestamp: { gte: new Date(new Date(e.timestamp).getTime() - 90_000) },
      },
      select: { id: true },
    });
    if (dup) return { deduped: true };
  }

  const created = await prisma.event.createMany({
    data: [
      {
        eventId: e.eventId,
        shopId: e.shopId,
        sessionId: e.sessionId,
        customerId: e.customerId,
        type: e.type,
        source: e.source,
        timestamp: new Date(e.timestamp),
        productId: e.productId,
        category: e.category,
        brand: e.brand,
        price: e.price,
        searchTerm: e.searchTerm,
        payload: e as object,
      },
    ],
    skipDuplicates: true,
  });
  // Opportunistic retention: rolls old events into daily aggregates + prunes
  // (throttled per instance, advisory-locked — see retention.server).
  maybeRollup(e.shopId);

  return { deduped: created.count === 0 };
}

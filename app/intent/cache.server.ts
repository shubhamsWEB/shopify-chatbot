// Hot-state layer, derived entirely from the Event table at read time.
// No Redis, no new table, no per-command cost.
import prisma from "../db.server";
import { ingest, type HotSession } from "./hot.server";
import { applyToLiveContext } from "./derive";
import type { CanonicalEvent, EventType } from "./events";
import { isHoldout } from "./proactive/holdout";
import { emptyPopups, type PopupsState } from "./proactive/types";
import { config } from "./proactive/config";

const RING = 50;

export async function getSession(shopId: string, sessionId: string): Promise<HotSession | null> {
  const rows = await prisma.event.findMany({
    where: { shopId, sessionId },
    orderBy: { timestamp: "asc" },
    take: RING,
    select: { payload: true, timestamp: true, type: true },
  });
  if (rows.length === 0) return null;

  const events = rows.map((r) => r.payload as unknown as CanonicalEvent);
  let liveContext = { recentSearches: [] as string[] };
  for (const e of events) liveContext = applyToLiveContext(liveContext, e);

  // Caps derived from proactive_shown / proactive_dismissed rows.
  const popups: PopupsState = emptyPopups();
  for (const r of rows) {
    const e = r.payload as unknown as CanonicalEvent;
    if (e.type === "proactive_shown") {
      popups.shownCount++;
      popups.unansweredCount++; // reset below when the shopper engages
      popups.lastShownAt = Math.max(popups.lastShownAt, new Date(e.timestamp).getTime());
      if (e.reason) popups.byTrigger[e.reason] = new Date(e.timestamp).getTime();
    } else if (e.type === "proactive_dismissed") {
      popups.dismissed = true;
      popups.cooldownUntil = new Date(e.timestamp).getTime() + config.eligibility.dismissCooldownMs;
    } else if (e.type === "proactive_engaged") {
      popups.unansweredCount = 0; // shopper replied — they're responsive, start over
    }
  }

  const surface = [...events].reverse().find((e) => e.surface)?.surface;
  return {
    sessionId, shopId,
    startedAt: new Date(rows[0].timestamp).toISOString(),
    lastEventAt: new Date(rows[rows.length - 1].timestamp).toISOString(),
    recentEvents: events,
    liveContext,
    surface,
    holdout: isHoldout(sessionId),
    popups,
  };
}

// --- Proactive caps writeback (as Event rows) ---
function logEvent(shopId: string, sessionId: string, type: EventType, extra: Partial<CanonicalEvent> = {}) {
  const e: CanonicalEvent = {
    eventId: `${type}_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    shopId, sessionId, type, timestamp: new Date().toISOString(), source: "chatbot", ...extra,
  };
  return ingest(e);
}

// Claim the right to emit one popup for (session, reason): reject if a
// proactive_shown for this reason is already within the cooldown.
// ponytail: best-effort — a rare concurrent double-eval could double-show.
export function claimEmit(reason: string, popups: PopupsState, cooldownMs = config.eligibility.perTriggerCooldownMs): boolean {
  const last = popups.byTrigger[reason] ?? 0;
  return Date.now() - last >= cooldownMs;
}

export async function markShown(shopId: string, sessionId: string, reason: string): Promise<void> {
  await logEvent(shopId, sessionId, "proactive_shown", { reason });
}

export async function markEngaged(shopId: string, sessionId: string): Promise<void> {
  await logEvent(shopId, sessionId, "proactive_engaged", {});
}

export async function markDismissed(shopId: string, sessionId: string): Promise<void> {
  await logEvent(shopId, sessionId, "proactive_dismissed", {});
}

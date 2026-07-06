// Realtime intent engine — computed at READ time from Event rows, no worker,
// no queue, no Redis. Two layers per read:
//   1. Deterministic signals (computeSignals): always, instant, free.
//   2. LLM enrichment (stage2 aggregate): inline, when enough new behavior
//      arrived — every ACTIVE event batch or any high-signal event. Narrative +
//      subjective fields persist on the profile between enrichments, so the
//      deterministic refresh never clobbers them.
// After an enrichment the narrative is embedded inline (best-effort) so
// semantic ranking keeps working without the worker.
import prisma from "../db.server";
import type { CanonicalEvent, IntentProfile } from "./events";
import { ACTIVE_EVENT_TYPES } from "./events";
import { computeSignals } from "./signals";
import { aggregate } from "./stage2";
import { writeProfile } from "./profile.server";
import { embedText, embeddingsEnabled } from "./embed";
import { storeEmbedding } from "./vectors.server";
import { applyToLiveContext } from "./derive";

const RING = 50;
const LLM_EVERY = 3; // active events between inline enrichments
const HIGH_SIGNAL = new Set(["add_to_cart", "checkout_started", "checkout_abandoned", "order_created"]);

async function recentEvents(shopId: string, profileKey: string): Promise<CanonicalEvent[]> {
  const rows = await prisma.event.findMany({
    where: { shopId, OR: [{ customerId: profileKey }, { sessionId: profileKey }] },
    orderBy: { timestamp: "asc" },
    take: RING,
    select: { payload: true },
  });
  return rows.map((r) => r.payload as unknown as CanonicalEvent);
}

function queryIntentOf(s: ReturnType<typeof computeSignals>): IntentProfile["queryIntent"] {
  if (s.productRevisits >= 2) return "comparing";
  if (s.recentSearches.length > 0 && s.categoriesViewed.length <= 1) return "targeted";
  return "exploratory";
}

function cartHesitationOf(s: ReturnType<typeof computeSignals>): IntentProfile["cartHesitation"] {
  if (s.abandonedCheckout || s.cartAddRemoveCycles >= 2) return "high";
  if (s.cartAddRemoveCycles === 1) return "medium";
  return "low";
}

// Deterministic profile from signals, carrying over the previous LLM-owned
// fields (narrative + subjective judgements) so they survive between enrichments.
function deterministicProfile(
  shopId: string, sessionId: string, s: ReturnType<typeof computeSignals>, prev: IntentProfile | null,
): IntentProfile {
  return {
    ...prev,
    sessionId, shopId,
    lastUpdated: new Date().toISOString(),
    eventsConsidered: s.eventsConsidered,
    computeTier: "warm",
    intentNarrative: prev?.intentNarrative ?? "",
    decisionPhase: s.decisionPhase,
    conversionScore: s.conversionScore,
    focusCategory: s.focusCategory,
    priceTrajectory: s.priceTrajectory,
    priceBand: s.priceBand,
    categoriesViewed: s.categoriesViewed,
    brandsViewed: s.brandsViewed,
    recentSearches: s.recentSearches,
    queryIntent: prev?.queryIntent ?? queryIntentOf(s),
    cartHesitation: prev?.cartHesitation ?? cartHesitationOf(s),
  };
}

// Enrichment cadence: first LLM pass once ≥2 active events exist, then every
// LLM_EVERY active events, and immediately on any high-signal event.
function llmDue(events: CanonicalEvent[], prev: IntentProfile | null): boolean {
  const since = prev?.llmEvents ?? 0;
  let active = 0;
  let newHighSignal = false;
  for (const e of events) {
    if (ACTIVE_EVENT_TYPES.has(e.type)) active++;
    if (active > since && HIGH_SIGNAL.has(e.type)) newHighSignal = true;
  }
  if (active < 2) return false;
  return active - since >= LLM_EVERY || newHighSignal;
}

/**
 * Ensure a fresh profile exists for a read. Recomputes deterministically when
 * new events arrived; runs the inline LLM enrichment when due. Callers await
 * this before readProfile, so the profile a turn sees is current.
 */
export async function ensureProfile(shopId: string, profileKey: string, sessionId: string): Promise<void> {
  try {
    const [row, newest] = await Promise.all([
      prisma.intentProfile.findUnique({ where: { shopId_profileKey: { shopId, profileKey } }, select: { lastUpdated: true, profile: true } }),
      prisma.event.findFirst({ where: { shopId, OR: [{ customerId: profileKey }, { sessionId: profileKey }] }, orderBy: { timestamp: "desc" }, select: { timestamp: true } }),
    ]);
    if (!newest) return; // no events yet
    if (row && newest.timestamp <= row.lastUpdated) return; // already fresh

    const prev = (row?.profile as unknown as IntentProfile) ?? null;
    const events = await recentEvents(shopId, profileKey);
    if (events.length === 0) return;
    const signals = computeSignals(events);

    let profile: IntentProfile;
    if (llmDue(events, prev)) {
      let liveContext = { recentSearches: [] as string[] };
      for (const e of events) liveContext = applyToLiveContext(liveContext, e);
      profile = await aggregate({
        shopId, sessionId,
        customerId: [...events].reverse().find((e) => e.customerId)?.customerId,
        events, signals,
        liveContext: liveContext as unknown as Record<string, unknown>,
      });
      profile.llmEvents = events.filter((e) => ACTIVE_EVENT_TYPES.has(e.type)).length;

      // Embed the fresh narrative for semantic ranking. Best-effort, inline.
      if (embeddingsEnabled()) {
        try {
          const vec = await embedText(profile.intentNarrative);
          if (vec) await storeEmbedding(shopId, profileKey, vec);
        } catch (err) {
          console.error(`[intent] embed failed key=${profileKey}`, (err as Error).message);
        }
      }
    } else {
      profile = deterministicProfile(shopId, sessionId, signals, prev);
    }
    await writeProfile(shopId, profileKey, profile);
  } catch (err) {
    // Fail soft: a stale/deterministic profile is better than a failed turn.
    console.error("[intent] ensureProfile failed", (err as Error).message);
  }
}

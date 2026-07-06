// Friction feature aggregation (spec §4.1 friction). Pure — computed from the
// session's recent event ring + the triggering event. Some features come from
// client instrumentation (dwell/scrollThrash/cartIdle/exitIntent), the rest are
// derived server-side from the event sequence (pdpLoop, smoothProgression).
import type { CanonicalEvent } from "../events";
import type { FrictionFeatures, Surface } from "./types";
import { config } from "./config";

// Distinct returns among PDPs: a product viewed again after a different product
// was seen in between (the "comparison loop" friction signature).
function pdpLoopCount(events: CanonicalEvent[]): number {
  const views = events.filter((e) => e.type === "product_view" && e.productId).map((e) => e.productId!);
  let loops = 0;
  const seen = new Set<string>();
  let last: string | undefined;
  for (const pid of views) {
    if (seen.has(pid) && pid !== last) loops++; // came back to a product after leaving it
    seen.add(pid);
    last = pid;
  }
  return loops;
}

// Distinct OTHER products viewed after the last add_to_cart: the shopper carted
// something and kept comparing — second-guessing, not smooth progression.
function postAddViews(events: CanonicalEvent[]): number {
  let lastAddIdx = -1;
  let carted: string | undefined;
  events.forEach((e, i) => {
    if (e.type === "add_to_cart") { lastAddIdx = i; carted = e.productId; }
  });
  if (lastAddIdx < 0) return 0;
  const seen = new Set<string>();
  for (let i = lastAddIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === "product_view" && e.productId && e.productId !== carted) seen.add(e.productId);
  }
  return seen.size;
}

// 0..1: clean forward movement toward purchase suppresses triggers (spec §6.2).
function smoothProgression(events: CanonicalEvent[], loops: number, postAdd: number): number {
  const has = (t: string) => events.some((e) => e.type === t);
  let s = 0.5;
  if (has("add_to_cart")) s += 0.25;
  if (has("checkout_started")) s += 0.25;
  if (has("remove_from_cart") || has("checkout_abandoned")) s -= 0.35;
  s -= 0.1 * loops;
  s -= 0.15 * Math.min(postAdd, 3); // kept shopping after carting = not smooth
  return Math.max(0, Math.min(1, s));
}

// Latest value of a numeric field across recent events (client-reported friction).
function latest(events: CanonicalEvent[], field: keyof CanonicalEvent): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const v = events[i][field];
    if (typeof v === "number") return v;
  }
  return 0;
}

const EXIT_INTENT_FRESH_MS = 30_000;

export function computeFriction(
  events: CanonicalEvent[],
  surface: Surface,
  triggerExitIntent: boolean,
): FrictionFeatures {
  const loops = pdpLoopCount(events);
  const postAdd = postAddViews(events);
  // Exit intent is a last-chance MOMENT, not a session property: only the live
  // trigger flag or a very recent exit_intent event counts. A stale one would
  // otherwise outrank every later trigger (cart_idle, compare) for the session.
  const exitIntent =
    config.signal.exitIntentEnabled &&
    (triggerExitIntent ||
      events.some(
        (e) => e.type === "exit_intent" && Date.now() - new Date(e.timestamp).getTime() < EXIT_INTENT_FRESH_MS,
      ));
  return {
    dwellMs: latest(events, "dwellMs"),
    dwellBaselineMs: config.dwellBaselineMs[surface] ?? config.dwellBaselineMs.other,
    pdpLoopCount: loops,
    postAddDistinctViews: postAdd,
    scrollThrash: latest(events, "scrollThrash"),
    couponFocusCount: config.checkoutFrictionEnabled ? latest(events, "couponFocusCount") : 0,
    cartIdleMs: latest(events, "cartIdleMs"),
    exitIntent,
    smoothProgressionScore: smoothProgression(events, loops, postAdd),
  };
}

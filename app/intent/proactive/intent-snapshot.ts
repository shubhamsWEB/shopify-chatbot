// Maps our worker-built IntentProfile onto the spec's `intent` snapshot contract
// (score/class/confidence/updatedAt). This is the seam the spec assigns to a
// separate Python scorer; we already compute richer signals, so we read those.
// Pure + deterministic — unit-testable, no I/O.
import type { IntentProfile } from "../events";
import type { IntentSnapshot, IntentClass } from "./types";

const CONFIDENCE_EVENTS_FULL = 6; // events needed before we fully trust the class

function classify(p: IntentProfile): IntentClass {
  if (p.cartHesitation === "high") return "cart_hesitation";
  switch (p.queryIntent) {
    case "comparing": return "comparison";
    case "exploratory": return "exploration";
    case "deal_seeking": return "browsing";
    case "targeted":
      return p.decisionPhase === "deciding" ? "targeted_purchase" : "comparison";
  }
  if (p.decisionPhase === "deciding") return "targeted_purchase";
  if (p.decisionPhase === "comparing") return "comparison";
  return "browsing";
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// Returns null when there's no usable profile (→ suppression fails closed).
export function toIntentSnapshot(p: IntentProfile | null): IntentSnapshot | null {
  if (!p) return null;
  // Prefer the deterministic clickstream score; fall back to the LLM judgement.
  const score = clamp01(p.conversionScore ?? p.conversionLikelihood ?? 0);
  // Confidence grows with evidence; capped by event volume.
  const confidence = clamp01((p.eventsConsidered ?? 0) / CONFIDENCE_EVENTS_FULL);
  const updatedAt = p.lastUpdated ? new Date(p.lastUpdated).getTime() : 0;
  return { score, class: classify(p), confidence, updatedAt };
}

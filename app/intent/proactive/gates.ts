// The three deterministic gates (spec §6). Pure functions, config-driven, no I/O,
// no model. Table-tested in proactive.selfcheck.ts.
import { config } from "./config";
import { triggerConfig, hasHelpAction } from "./triggers";
import type { FrictionFeatures, IntentSnapshot, PopupsState, Surface } from "./types";

export interface GateInput {
  now: number;
  startedAt: number;
  surface: Surface;
  popups: PopupsState;
  friction: FrictionFeatures;
  intent: IntentSnapshot | null;
  activeFormField: boolean;
  widgetOpen: boolean;
  holdout: boolean;
}

// Per-shop merchant overrides for the eligibility knobs (admin Bot settings).
export type EligibilityConfig = typeof config.eligibility;

// Which trigger type might fire on this surface (peek, used for per-trigger cap).
// Gate 1 — Eligibility. Global per-session caps (the per-TRIGGER cooldown is
// checked in the signal gate, once the specific reason is known). (spec §6.1)
export function eligibilityGate(s: GateInput, elig: EligibilityConfig = config.eligibility): "eligibility" | null {
  const c = elig;
  const fail =
    s.holdout ||
    s.now - s.startedAt < c.minSessionAgeMs ||
    s.popups.dismissed ||
    s.now < s.popups.cooldownUntil ||
    s.popups.shownCount >= c.maxPerSession ||
    s.popups.unansweredCount >= c.maxUnansweredPerSession ||
    s.activeFormField ||
    s.widgetOpen;
  return fail ? "eligibility" : null;
}

// Gate 2 — Signal. Reads the precomputed intent + friction. Returns the specific
// trigger reason, or null. Also enforces the per-trigger cooldown so the same
// reason can't repeat, while a DIFFERENT reason (e.g. compare after dwell) can
// still fire within maxPerSession. (spec §6.2)
export function signalGate(s: GateInput, elig: EligibilityConfig = config.eligibility): string | null {
  const cfg = config.signal;
  const f = s.friction;
  const rule = triggerConfig[s.surface];

  let reason: string | null = null;
  // 1) exit intent — highest priority, last chance (score-independent)
  if (f.exitIntent && cfg.exitIntentEnabled) {
    reason = "exit_intent";
  } else if (s.intent) {
    // 2) a surface friction signature + enough intent + NOT smoothly progressing.
    const candidate = rule ? rule.frictionReason(f) : null;
    if (candidate) {
      const threshold = cfg.reasonThresholds[candidate] ?? rule?.intentThreshold ?? cfg.defaultIntentThreshold;
      const highIntent = s.intent.score >= threshold;
      // Smooth progression suppresses browsing nudges, but NOT cart-idle: an idle
      // cart is a stuck signal even though add-to-cart marks the path "smooth".
      const smoothBlocks = candidate !== "cart_idle";
      const smooth = f.smoothProgressionScore >= cfg.smoothFloor;
      if (highIntent && !(smoothBlocks && smooth)) reason = candidate;
    }

    // 3) Class-driven fallbacks — no specific friction signature, but the intent
    // profile tells us how to help. Surface-independent (fires on homepage/"other"
    // too), so the engine assists ANY intent, not just the 4-5 friction cases.
    // Never interrupt a shopper cleanly progressing toward checkout (same
    // principle the friction reasons honor) — class-driven help is for the
    // paused, hesitating, or undecided.
    if (!reason && f.smoothProgressionScore < cfg.smoothFloor && s.intent.score >= cfg.classFallbackFloor) {
      const cls = s.intent.class;
      if (cfg.crossSellEnabled && (cls === "targeted_purchase" || cls === "cart_hesitation")) {
        // Buy intent but paused → suggest a genuine complement to what they want.
        reason = "cross_sell";
      } else if (cfg.exploringEnabled && (cls === "exploration" || cls === "browsing")) {
        // Undecided explorer → help them find something. Needs a little engagement
        // (any scroll/dwell, or time on site) and not a clean bounce. Low intent
        // confidence is EXPECTED — that's exactly the shopper who needs a hand.
        const engaged = f.scrollThrash >= 1 || f.dwellMs > 0 || s.now - s.startedAt > cfg.exploreEngageMs;
        if (engaged) reason = "exploring";
      }
    }
  }
  if (!reason) return null;

  // per-trigger cooldown: don't repeat the same reason within the window
  const last = s.popups.byTrigger[reason] ?? 0;
  if (s.now - last < elig.perTriggerCooldownMs) return null;
  return reason;
}

// Gate 3 — Suppression. Confidence + staleness + relevance. (spec §6.3)
export function suppressionGate(s: GateInput, triggerReason: string | null): "suppression" | null {
  const cfg = config.suppression;
  if (triggerReason === "exit_intent") {
    // last-chance: only block on no-help (always has help) — allow even if score thin
    return hasHelpAction("browsing", s.surface, triggerReason) ? null : "suppression";
  }
  if (!s.intent) return "suppression"; // no usable score → fail closed
  const stale = s.now - s.intent.updatedAt > cfg.intentStalenessMs;
  const lowConfidence = s.intent.confidence < cfg.minConfidence;
  const noHelp = !hasHelpAction(s.intent.class, s.surface, triggerReason);
  // exploring/cross_sell are class-driven: an undecided or just-starting shopper
  // has low confidence by nature, so don't block on it (still enforce freshness
  // and that a concrete help action exists).
  const confBlocks = triggerReason !== "exploring" && triggerReason !== "cross_sell";
  return stale || (confBlocks && lowConfidence) || noHelp ? "suppression" : null;
}

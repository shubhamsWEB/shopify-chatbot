// Proactive popup config (spec §11). Every tunable threshold lives here — gate
// logic reads from this, never hardcodes (acceptance: "zero magic numbers in
// gate logic"). A few knobs are env-overridable for ops without a redeploy.
// eslint-disable-next-line no-undef
const env = (k: string, d: number) => (process.env[k] != null ? Number(process.env[k]) : d);
// eslint-disable-next-line no-undef
const flag = (k: string, d: boolean) => (process.env[k] != null ? process.env[k] === "true" : d);

export const config = {
  sessionTtlMs: 1_800_000, // 30 min sliding
  evalIntervalMs: env("PROACTIVE_EVAL_INTERVAL_MS", 9_000), // debounce between graph runs
  intentStalenessMs: 30_000, // score older than this is unusable

  // Spec §15: run the engine but show nothing until shadow data validates rates.
  // Flip PROACTIVE_SHADOW=false to go live. Decision records always logged.
  shadowMode: flag("PROACTIVE_SHADOW", false),

  eligibility: {
    minSessionAgeMs: env("PROACTIVE_MIN_SESSION_AGE_MS", 8_000), // brief orient, then help
    // Proactive until the shopper says stop: no meaningful per-session cap — the
    // explicit "don't show tips" dismissal is the off switch, and the per-trigger
    // cooldown + intent gates keep individual nudges from repeating back-to-back.
    maxPerSession: env("PROACTIVE_MAX_PER_SESSION", 99),
    // Stop auto-nudging after this many popups go unanswered in a row. A reply
    // (proactive_engaged) resets the count — responsive shoppers keep getting help.
    maxUnansweredPerSession: env("PROACTIVE_MAX_UNANSWERED", 4),
    perTriggerCooldownMs: env("PROACTIVE_TRIGGER_COOLDOWN_MS", 300_000), // same reason can re-fire after 5 min
    dismissCooldownMs: 1_800_000, // an explicit dismissal silences the rest of the session
  },

  signal: {
    // Calibrated to our deterministic clickstream conversionScore (signals.ts):
    // ~0.1 = a product view + linger, ~0.22 = comparison loop, ~0.32 = add-to-cart.
    // Low default so ENGAGED shoppers get proactive help; idle bounces (no friction) stay silent.
    defaultIntentThreshold: env("PROACTIVE_INTENT_THRESHOLD", 0.15),
    // Per-reason overrides: the friction pattern itself is the intent signal, so
    // dwell/compare need only a light score once that friction is present.
    reasonThresholds: { product_dwell: 0.08, product_compare: 0.1, browse_no_addtocart: 0.05, search_refinement: 0.05 } as Record<string, number>,
    smoothFloor: 0.7, // suppress smoothly-progressing buyers (except idle/exit — see gate)
    exitIntentEnabled: flag("PROACTIVE_EXIT_INTENT", true),
    // Class-driven fallbacks so the engine assists ANY intent, on ANY surface
    // (incl. homepage/"other"), when no specific friction signature fired.
    exploreEngageMs: env("PROACTIVE_EXPLORE_ENGAGE_MS", 20_000), // browsing this long (or any scroll/dwell) = engaged enough to offer help
    // Minimal engagement floor for the class-driven fallbacks — well below the
    // friction thresholds (undecided shoppers score low), but above a bounce so
    // we never nudge a barely-there visitor. ~0.05 ≈ one real product view.
    classFallbackFloor: env("PROACTIVE_CLASS_FALLBACK_FLOOR", 0.05),
    crossSellEnabled: flag("PROACTIVE_CROSS_SELL", true),
    exploringEnabled: flag("PROACTIVE_EXPLORING", true),
  },

  suppression: {
    // confidence = eventsConsidered/6, so 0.15 ≈ 1 engaged event before we trust the class.
    minConfidence: env("PROACTIVE_MIN_CONFIDENCE", 0.15),
    intentStalenessMs: 30_000,
  },

  compose: {
    maxMessageChars: 280, // product cards carry detail; allow a touch more than 180
    humanFallback: "bot" as "bot" | "drop",
  },

  policy: {
    discountAllowed: flag("PROACTIVE_DISCOUNT_ALLOWED", false), // exit-intent only, and only if true
  },

  holdoutPct: env("PROACTIVE_HOLDOUT_PCT", 0), // % of sessions never shown (measurement arm; 0 = everyone gets help)

  // Friction we can't instrument on Shopify-hosted checkout (needs a checkout UI
  // extension). Off by default so those signatures never fire on bad data.
  checkoutFrictionEnabled: flag("PROACTIVE_CHECKOUT_FRICTION", false),

  // Per-surface dwell baselines (ms). ponytail: static defaults; upgrade to a
  // per-template rolling median if calibration demands it.
  dwellBaselineMs: { product: 5_000, category: 15_000, search: 12_000, cart: 20_000, checkout: 30_000, other: 15_000 },
} as const;

export type ProactiveConfig = typeof config;

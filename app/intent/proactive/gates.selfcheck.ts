// Self-check for the proactive decision gates (spec §14). Pure, no I/O — run via
// `tsx`. Asserts each gate's fail/pass conditions, exit-intent priority, smooth
// suppression, holdout distribution, and the cost invariant (compose is only
// reachable when all three gates pass).
import assert from "node:assert";
import { config } from "./config";
import { eligibilityGate, signalGate, suppressionGate } from "./gates";
import type { GateInput } from "./gates";
import { isHoldout } from "./holdout";
import { computeFriction } from "./friction";
import type { CanonicalEvent } from "../events";
import { emptyFriction, emptyPopups, type FrictionFeatures, type IntentSnapshot } from "./types";

const NOW = 1_000_000_000_000;
const freshIntent = (over: Partial<IntentSnapshot> = {}): IntentSnapshot => ({
  score: 0.7, class: "targeted_purchase", confidence: 0.8, updatedAt: NOW, ...over,
});
const productFriction = (over: Partial<FrictionFeatures> = {}): FrictionFeatures => ({
  ...emptyFriction(), dwellMs: 50_000, dwellBaselineMs: config.dwellBaselineMs.product,
  smoothProgressionScore: 0, ...over,
});
const base = (over: Partial<GateInput> = {}): GateInput => ({
  now: NOW, startedAt: NOW - 60_000, surface: "product", popups: emptyPopups(),
  friction: productFriction(), intent: freshIntent(), activeFormField: false,
  widgetOpen: false, holdout: false, ...over,
});

// --- Eligibility (each fail condition independently) ---
assert.equal(eligibilityGate(base()), null, "eligible baseline passes");
assert.equal(eligibilityGate(base({ holdout: true })), "eligibility", "holdout fails");
assert.equal(eligibilityGate(base({ startedAt: NOW - 1000 })), "eligibility", "too-new session fails");
assert.equal(eligibilityGate(base({ popups: { ...emptyPopups(), dismissed: true, cooldownUntil: NOW + 1000 } })), "eligibility", "recently dismissed (cooldownUntil in the future) fails");
assert.equal(eligibilityGate(base({ popups: { ...emptyPopups(), dismissed: true, cooldownUntil: NOW - 1000 } })), null, "a stale dismiss (cooldownUntil passed) does NOT block forever — regression test for the permanent-silence bug");
assert.equal(eligibilityGate(base({ popups: { ...emptyPopups(), cooldownUntil: NOW + 1000 } })), "eligibility", "cooldown fails");
assert.equal(eligibilityGate(base({ popups: { ...emptyPopups(), shownCount: config.eligibility.maxPerSession } })), "eligibility", "max-per-session fails");
assert.equal(eligibilityGate(base({ popups: { ...emptyPopups(), unansweredCount: config.eligibility.maxUnansweredPerSession } })), "eligibility", "4 unanswered nudges stops auto-nudge");
assert.equal(eligibilityGate(base({ popups: { ...emptyPopups(), unansweredCount: config.eligibility.maxUnansweredPerSession - 1 } })), null, "under the unanswered cap still eligible");
assert.equal(eligibilityGate(base({ activeFormField: true })), "eligibility", "active form field fails");
assert.equal(eligibilityGate(base({ widgetOpen: true })), "eligibility", "widget open fails");

// --- Signal ---
assert.equal(signalGate(base()), "product_dwell", "high intent + dwell friction fires product_dwell");
// cart_regret: a fresh remove beats other product signals, fires on low score
// (the removal IS the evidence), and works surface-independently (incl. "other").
assert.equal(
  signalGate(base({ friction: productFriction({ cartRemoveRecent: true }), intent: freshIntent({ score: 0.06 }) })),
  "cart_regret", "recent cart remove fires cart_regret even on a thin score",
);
assert.equal(
  signalGate(base({ surface: "other", friction: { ...emptyFriction(), cartRemoveRecent: true }, intent: freshIntent({ score: 0.06, class: "cart_hesitation" }) })),
  "cart_regret", "cart_regret fires on the 'other' surface too",
);
assert.equal(signalGate(base({ friction: productFriction({ dwellMs: 1000, pdpLoopCount: 2 }) })), "product_compare", "comparison loop fires product_compare");
assert.equal(signalGate(base({ popups: { ...emptyPopups(), byTrigger: { product_dwell: NOW - 1000 } } })), null, "per-trigger cooldown suppresses same reason");
assert.equal(signalGate(base({ friction: productFriction({ smoothProgressionScore: 0.9 }) })), null, "smooth progression suppresses");
assert.equal(signalGate(base({ intent: freshIntent({ score: 0.03 }) })), null, "low intent does not fire");
// Class-driven fallbacks (assist ANY intent): with no specific friction signature,
// a buy-intent shopper gets a cross-sell and an undecided explorer gets help.
const noFriction = productFriction({ dwellMs: 1000, pdpLoopCount: 0 });
assert.equal(signalGate(base({ friction: noFriction })), "cross_sell", "no friction + buy intent → cross_sell fallback");
assert.equal(signalGate(base({ friction: noFriction, intent: freshIntent({ score: 0.02 }) })), null, "below engagement floor stays silent");
assert.equal(signalGate(base({ friction: noFriction, intent: freshIntent({ class: "exploration", score: 0.1, confidence: 0.2 }) })), "exploring", "exploration class → exploring nudge");
assert.equal(signalGate(base({ friction: productFriction({ dwellMs: 1000, pdpLoopCount: 0, smoothProgressionScore: 0.9 }) })), null, "smooth progression suppresses the fallbacks too");
assert.equal(signalGate(base({ friction: productFriction({ exitIntent: true, smoothProgressionScore: 0.9 }) })), "exit_intent", "exit intent is highest priority even when smooth");
assert.equal(signalGate(base({ intent: null, friction: productFriction({ exitIntent: true }) })), "exit_intent", "exit intent fires without a score");

// --- Suppression ---
assert.equal(suppressionGate(base(), "product_dwell"), null, "fresh confident relevant intent passes");
assert.equal(suppressionGate(base({ intent: freshIntent({ updatedAt: NOW - 40_000 }) }), "product_dwell"), "suppression", "stale score fails");
assert.equal(suppressionGate(base({ intent: freshIntent({ confidence: 0.1 }) }), "product_dwell"), "suppression", "low confidence fails");
assert.equal(suppressionGate(base({ intent: freshIntent({ class: "checkout_friction" }) }), "product_dwell"), "suppression", "no help action fails");
assert.equal(suppressionGate(base({ intent: null }), "exit_intent"), null, "exit intent passes suppression even with no score");

// --- Cost invariant: compose reachable only when all three gates pass ---
function reachesCompose(s: GateInput): boolean {
  if (eligibilityGate(s)) return false;
  const r = signalGate(s);
  if (!r) return false;
  if (suppressionGate(s, r)) return false;
  return true;
}
assert.equal(reachesCompose(base()), true, "full pass reaches compose");
assert.equal(reachesCompose(base({ holdout: true })), false, "holdout never reaches compose");
assert.equal(reachesCompose(base({ friction: productFriction({ smoothProgressionScore: 0.9 }) })), false, "smooth never reaches compose");
assert.equal(reachesCompose(base({ intent: freshIntent({ confidence: 0.1 }) })), false, "low confidence never reaches compose");

// --- Holdout: stable + ~holdoutPct% over a large sample ---
const N = 20_000;
let hits = 0;
for (let i = 0; i < N; i++) if (isHoldout("sid_" + i)) hits++;
const pct = (hits / N) * 100;
assert.ok(Math.abs(pct - config.holdoutPct) < 2, `holdout ~${config.holdoutPct}% (got ${pct.toFixed(1)}%)`);
assert.equal(isHoldout("stable-id-xyz"), isHoldout("stable-id-xyz"), "holdout stable per id");

// --- friction: browsing alternatives after add_to_cart is comparison, not smooth ---
const fev = (type: string, productId?: string): CanonicalEvent =>
  ({ eventId: `${type}_${productId ?? "x"}_${Math.random()}`, shopId: "s", sessionId: "x", type,
     timestamp: new Date().toISOString(), source: "web_pixel", productId }) as CanonicalEvent;
const postAddFriction = computeFriction(
  [fev("product_view", "A"), fev("add_to_cart", "A"), fev("product_view", "B"), fev("product_view", "C")],
  "product",
  false,
);
assert.equal(postAddFriction.postAddDistinctViews, 2, "2 distinct products viewed after add");
assert.ok(postAddFriction.smoothProgressionScore < config.signal.smoothFloor, "post-add browsing breaks smooth suppression");
assert.equal(
  signalGate(base({ friction: postAddFriction, intent: freshIntent({ score: 0.3 }) })),
  "product_compare",
  "post-add browsing triggers a comparison nudge",
);
// smooth buyer stays suppressed: add_to_cart with NO further browsing
const smoothF = computeFriction([fev("product_view", "A"), fev("add_to_cart", "A")], "product", false);
assert.equal(smoothF.postAddDistinctViews, 0);
assert.ok(smoothF.smoothProgressionScore >= config.signal.smoothFloor, "clean add stays smooth");

console.log("proactive gates selfcheck: OK");

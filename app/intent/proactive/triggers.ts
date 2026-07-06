// Per-surface trigger rules + relevance map (spec §7). Externalized as data so
// thresholds tune per vertical without touching gate logic.
import type { FrictionFeatures, Surface, IntentClass } from "./types";

export interface TriggerRule {
  intentThreshold?: number; // overrides signal.defaultIntentThreshold
  // Return the SPECIFIC trigger reason this friction state warrants, or null.
  // Distinct reasons get independent per-session budgets, so e.g. a dwell popup
  // and a later comparison popup are both allowed within maxPerSession.
  frictionReason: (f: FrictionFeatures) => string | null;
}

export const triggerConfig: Record<Surface, TriggerRule> = {
  product: {
    frictionReason: (f) =>
      // comparison loop, OR carted an item then kept browsing alternatives —
      // both mean "help me decide", so offer a comparison
      f.pdpLoopCount >= 2 || f.postAddDistinctViews >= 2 ? "product_compare"
      : f.dwellMs > f.dwellBaselineMs * 1.8 ? "product_dwell"
      : null,
  },
  category: { frictionReason: (f) => (f.scrollThrash >= 3 ? "browse_no_addtocart" : null) },
  search: { frictionReason: (f) => (f.scrollThrash >= 2 ? "search_refinement" : null) },
  cart: { frictionReason: (f) => (f.cartIdleMs > 25_000 ? "cart_idle" : null) },
  checkout: { frictionReason: (f) => (f.couponFocusCount >= 2 ? "checkout_friction" : null) },
  other: { frictionReason: () => null }, // never fire on unknown surfaces
};

// (intentClass, surface) -> is there a concrete help action to offer? (spec §7.2)
export function hasHelpAction(cls: IntentClass | string, surface: Surface, reason: string | null): boolean {
  // Friction-defined reasons carry their own concrete help (address the friction),
  // independent of the inferred intent class: search_refinement/browse offer to
  // narrow results, cart_idle/checkout unstick, exit_intent is last-chance.
  if (
    reason === "exit_intent" || reason === "cart_idle" || reason === "checkout_friction" ||
    reason === "search_refinement" || reason === "browse_no_addtocart" ||
    // Class-driven reasons carry their own concrete help on any surface:
    // "exploring" offers to find something, "cross_sell" offers a complement.
    reason === "exploring" || reason === "cross_sell"
  ) return true;
  // On a product page there's always a concrete help action (this product), so
  // product is valid for browse-y classes too. Cart/checkout stay restricted to
  // the classes where a nudge there is actually useful.
  const allowed: Record<string, Surface[]> = {
    targeted_purchase: ["product", "cart", "checkout"],
    comparison: ["product", "category", "search"],
    exploration: ["product", "category", "search"],
    cart_hesitation: ["product", "cart", "checkout"],
    checkout_friction: ["checkout"],
    browsing: ["product", "category", "search"],
  };
  return (allowed[cls] ?? []).includes(surface);
}

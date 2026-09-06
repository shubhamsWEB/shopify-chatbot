// Proactive subsystem types (spec §4). The session-state contract is the
// existing HotSession (hot.server) extended with the fields this subsystem OWNS:
// friction, popups, holdout, surface.
import type { ChatResult } from "../chat.server";

export type Surface = "product" | "cart" | "checkout" | "category" | "search" | "other";

export type IntentClass =
  | "targeted_purchase"
  | "comparison"
  | "exploration"
  | "cart_hesitation"
  | "checkout_friction"
  | "browsing";

// Live intent snapshot — mapped from our worker-built IntentProfile (spec §4.1
// `intent`). We don't run a separate scorer; intent-snapshot.ts derives this.
export interface IntentSnapshot {
  score: number; // 0..1 purchase/engagement
  class: IntentClass;
  confidence: number; // 0..1
  updatedAt: number; // epoch ms
}

// Behavioral friction features (spec §4.1 `friction`).
export interface FrictionFeatures {
  dwellMs: number;
  dwellBaselineMs: number;
  pdpLoopCount: number;
  // distinct OTHER products viewed after the last add_to_cart — the shopper is
  // second-guessing the carted item (comparison friction, not smooth progression)
  postAddDistinctViews: number;
  scrollThrash: number;
  couponFocusCount: number;
  cartIdleMs: number;
  exitIntent: boolean;
  smoothProgressionScore: number; // 0..1, high = clean progression toward purchase
  // shopper removed a carted item recently and hasn't re-added or ordered since —
  // the classic "didn't find quite the right fit" moment (cart_regret trigger)
  cartRemoveRecent: boolean;
  removedProductId?: string;
}

// Per-session popup ledger (owned here).
export interface PopupsState {
  shownCount: number;
  byTrigger: Record<string, number>; // trigger reason -> last shown epoch ms
  lastShownAt: number;
  dismissed: boolean;
  cooldownUntil: number;
  unansweredCount: number; // consecutive popups shown with no shopper reply; resets on engage
}

export function emptyFriction(): FrictionFeatures {
  return {
    dwellMs: 0, dwellBaselineMs: 0, pdpLoopCount: 0, postAddDistinctViews: 0, scrollThrash: 0,
    couponFocusCount: 0, cartIdleMs: 0, exitIntent: false, smoothProgressionScore: 0,
    cartRemoveRecent: false,
  };
}
export function emptyPopups(): PopupsState {
  return { shownCount: 0, byTrigger: {}, lastShownAt: 0, dismissed: false, cooldownUntil: 0, unansweredCount: 0 };
}

export type GateName = "eligibility" | "signal" | "suppression";

// The triggering input to one decision-graph run (spec §4.2/§4.3).
export interface TriggerInput {
  shop: string;
  sessionId: string;
  surface: Surface;
  productId?: string;
  exitIntent?: boolean;
  activeFormField?: boolean;
  widgetOpen?: boolean;
}

export interface PopupDecision {
  surface: Surface;
  triggerReason: string | null;
  suppressedAt: GateName | null;
  fired: boolean;
}

export interface ComposedMessage extends Partial<ChatResult> {
  message: string;
}

// Decision record logged for every run (spec §12.1).
export interface DecisionRecord {
  ts: number;
  sessionId: string;
  shop: string;
  surface: Surface;
  intent: { score: number; class: string; confidence: number; ageMs: number };
  gates: { eligibility: string; signal: string; suppression: string };
  fired: boolean;
  triggerReason: string | null;
  deduped: boolean;
  holdout: boolean;
  shadow: boolean;
}

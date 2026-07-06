// Deterministic behavioral-signal extraction (spec §3.3). Pure, no deps — this
// grounds the Stage-2 aggregation so the LLM narrates over real numbers, not guesses.
//
// Sequence-aware, per the session-modeling literature (GRU4Rec, SASRec, BERT4Rec):
// the ORDER and DELTAS carry intent, not just bag-of-events counts. The
// deterministic conversionScore follows clickstream purchase-intent prediction
// (Requena 2020; Hendriksen 2020 for anonymous/pre-login sessions).
import type { CanonicalEvent } from "./events";
import { ACTIVE_EVENT_TYPES } from "./events";

export interface Signals {
  eventsConsidered: number;
  activeEvents: number;
  categoriesViewed: Array<{ category: string; count: number }>;
  brandsViewed: Array<{ brand: string; count: number }>;
  recentSearches: string[];
  attributeTerms: string[];
  pricesViewed: number[];
  maxPriceViewed?: number;
  minPriceViewed?: number;
  cartAddRemoveCycles: number;
  abandonedCheckout: boolean;
  ordered: boolean;
  decisionWindowMs?: number;

  // --- sequence-aware ---
  priceTrajectory: "ascending" | "descending" | "converging" | "stable";
  priceBand?: { low: number; high: number }; // band the shopper is converging on
  focusCategory?: string;                     // recency-weighted dominant category
  categoryJourney: string[];                  // distinct categories in order
  productRevisits: number;                    // products viewed >1× (comparison signal)
  engagementDepth: "skim" | "moderate" | "deep";
  // --- derived intent ---
  conversionScore: number;                    // 0..1, deterministic clickstream estimate
  decisionPhase: "browsing" | "comparing" | "deciding";
}

const STOP = new Set(["the", "a", "for", "with", "and", "under", "over", "best", "good", "in"]);

function countBy<T extends string>(items: T[]): Array<{ key: T; count: number }> {
  const m = new Map<T, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// Trend over the chronological price sequence (SASRec-style: the path matters).
function priceTrajectory(prices: number[]): Signals["priceTrajectory"] {
  if (prices.length < 3) return "stable";
  const first = avg(prices.slice(0, Math.ceil(prices.length / 2)));
  const last = avg(prices.slice(Math.floor(prices.length / 2)));
  const spreadEarly = Math.max(...prices.slice(0, Math.ceil(prices.length / 2))) - Math.min(...prices.slice(0, Math.ceil(prices.length / 2)));
  const spreadLate = Math.max(...prices.slice(Math.floor(prices.length / 2))) - Math.min(...prices.slice(Math.floor(prices.length / 2)));
  const rel = (last - first) / (first || 1);
  if (spreadLate < spreadEarly * 0.6 && Math.abs(rel) < 0.15) return "converging";
  if (rel > 0.15) return "ascending";
  if (rel < -0.15) return "descending";
  return "stable";
}

export function computeSignals(events: CanonicalEvent[]): Signals {
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const categories = countBy(sorted.filter((e) => e.category).map((e) => e.category!));
  const brands = countBy(sorted.filter((e) => e.brand).map((e) => e.brand!));

  const searches = sorted.filter((e) => e.type === "search" && e.searchTerm).map((e) => e.searchTerm!);
  const recentSearches = [...new Set(searches.slice().reverse())].slice(0, 10);

  const attributeTerms = [
    ...new Set(searches.flatMap((s) => s.toLowerCase().split(/[^a-z0-9₹]+/)).filter((w) => w.length > 2 && !STOP.has(w))),
  ].slice(0, 20);

  const pricesViewed = sorted.filter((e) => e.type === "product_view" && e.price != null).map((e) => e.price!);

  // add→remove cycles (hesitation)
  let cycles = 0;
  const addedProducts = new Set<string>();
  for (const e of sorted) {
    if (e.type === "add_to_cart" && e.productId) addedProducts.add(e.productId);
    if (e.type === "remove_from_cart" && e.productId && addedProducts.has(e.productId)) { cycles++; addedProducts.delete(e.productId); }
  }

  const ordered = sorted.some((e) => e.type === "order_created");
  const checkoutStarted = sorted.some((e) => e.type === "checkout_started");
  const abandonedCheckout = checkoutStarted && !ordered;
  const cartAdds = sorted.filter((e) => e.type === "add_to_cart").length;

  let decisionWindowMs: number | undefined;
  if (ordered && sorted.length) {
    decisionWindowMs = new Date(sorted.find((e) => e.type === "order_created")!.timestamp).getTime() - new Date(sorted[0].timestamp).getTime();
  }

  // --- sequence features ---
  const categoryJourney: string[] = [];
  for (const e of sorted) if (e.category && categoryJourney[categoryJourney.length - 1] !== e.category) categoryJourney.push(e.category);

  // recency-weighted focus category (later views weigh more — SASRec intuition)
  const catWeight = new Map<string, number>();
  const catEvents = sorted.filter((e) => e.category);
  catEvents.forEach((e, i) => catWeight.set(e.category!, (catWeight.get(e.category!) ?? 0) + (i + 1) / catEvents.length));
  const focusCategory = [...catWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const productViewCounts = countBy(sorted.filter((e) => e.type === "product_view" && e.productId).map((e) => e.productId!));
  const productRevisits = productViewCounts.filter((p) => p.count > 1).length;

  const dwellMs = sorted.filter((e) => e.dwellMs != null).map((e) => e.dwellMs!);
  const scroll = sorted.filter((e) => e.scrollDepthPct != null).map((e) => e.scrollDepthPct!);
  const engagementDepth: Signals["engagementDepth"] =
    avg(dwellMs) > 40000 || avg(scroll) > 70 ? "deep" : avg(dwellMs) > 0 && avg(dwellMs) < 8000 ? "skim" : "moderate";

  // price band the shopper converges on: middle 60% of recent viewed/cart prices
  const recentPrices = pricesViewed.slice(-6).sort((a, b) => a - b);
  const priceBand = recentPrices.length
    ? { low: recentPrices[Math.floor(recentPrices.length * 0.2)], high: recentPrices[Math.floor(recentPrices.length * 0.8)] }
    : undefined;

  // --- deterministic conversion score (Requena-style feature weighting) ---
  let score = 0.1;
  score += Math.min(cartAdds, 2) * 0.22;
  if (checkoutStarted) score += 0.3;
  if (ordered) score += 0.5;
  if (productRevisits > 0) score += 0.12;       // comparing → closer to decision
  if (engagementDepth === "deep") score += 0.1;
  if (engagementDepth === "skim") score -= 0.05;
  score -= cycles * 0.15;                         // hesitation
  if (abandonedCheckout) score -= 0.1;
  const conversionScore = clamp01(score);

  const decisionPhase: Signals["decisionPhase"] =
    ordered || checkoutStarted || cartAdds > 0 ? "deciding" : productRevisits > 0 || pricesViewed.length >= 3 ? "comparing" : "browsing";

  return {
    eventsConsidered: sorted.length,
    activeEvents: sorted.filter((e) => ACTIVE_EVENT_TYPES.has(e.type)).length,
    categoriesViewed: categories.map(({ key, count }) => ({ category: key, count })),
    brandsViewed: brands.map(({ key, count }) => ({ brand: key, count })),
    recentSearches,
    attributeTerms,
    pricesViewed,
    maxPriceViewed: pricesViewed.length ? Math.max(...pricesViewed) : undefined,
    minPriceViewed: pricesViewed.length ? Math.min(...pricesViewed) : undefined,
    cartAddRemoveCycles: cycles,
    abandonedCheckout,
    ordered,
    decisionWindowMs,
    priceTrajectory: priceTrajectory(pricesViewed),
    priceBand,
    focusCategory,
    categoryJourney,
    productRevisits,
    engagementDepth,
    conversionScore,
    decisionPhase,
  };
}

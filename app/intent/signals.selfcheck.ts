// Run: npm run selfcheck (tsx). Covers the deterministic signal extraction.
import assert from "node:assert/strict";
import { computeSignals } from "./signals";
import type { CanonicalEvent } from "./events";

const ev = (p: Partial<CanonicalEvent> & { type: CanonicalEvent["type"]; t: string }): CanonicalEvent => ({
  eventId: Math.random().toString(36),
  shopId: "s",
  sessionId: "sess",
  timestamp: `2026-06-26T00:00:${p.t}.000Z`,
  source: "web_pixel",
  ...p,
});

const events: CanonicalEvent[] = [
  ev({ type: "product_view", t: "01", productId: "p1", category: "Jackets", brand: "BrandX", price: 4200 }),
  ev({ type: "search", t: "02", searchTerm: "waterproof under 5k" }),
  ev({ type: "product_view", t: "03", productId: "p2", category: "Jackets", brand: "BrandY", price: 8000 }),
  ev({ type: "add_to_cart", t: "04", productId: "p2" }),
  ev({ type: "remove_from_cart", t: "05", productId: "p2" }), // 1 hesitation cycle
  ev({ type: "checkout_started", t: "06" }), // abandoned (no order)
];

const s = computeSignals(events.slice().reverse()); // unsorted input → must sort internally

assert.equal(s.eventsConsidered, 6);
assert.equal(s.categoriesViewed[0].category, "Jackets");
assert.equal(s.categoriesViewed[0].count, 2);
assert.equal(s.maxPriceViewed, 8000);
assert.equal(s.minPriceViewed, 4200);
assert.equal(s.cartAddRemoveCycles, 1, "one add→remove cycle");
assert.equal(s.abandonedCheckout, true);
assert.equal(s.ordered, false);
assert.ok(s.attributeTerms.includes("waterproof"), "parses attribute from search");
assert.ok(!s.attributeTerms.includes("under"), "drops stopwords");
assert.deepEqual(s.recentSearches, ["waterproof under 5k"]);

// sequence-aware features
assert.equal(s.focusCategory, "Jackets");
assert.deepEqual(s.categoryJourney, ["Jackets"]);
assert.equal(s.decisionPhase, "deciding", "cart add → deciding");
assert.ok(s.conversionScore > 0.2 && s.conversionScore < 1, "conversion score in range");

// price trajectory: ascending sequence of 3+ prices
const asc = computeSignals([
  ev({ type: "product_view", t: "01", price: 1000 }),
  ev({ type: "product_view", t: "02", price: 2000 }),
  ev({ type: "product_view", t: "03", price: 3000 }),
]);
assert.equal(asc.priceTrajectory, "ascending");
assert.equal(asc.decisionPhase, "comparing", "3 product views, no cart → comparing");

// converging sequence (narrowing spread around a band)
const conv = computeSignals([
  ev({ type: "product_view", t: "01", price: 500 }),
  ev({ type: "product_view", t: "02", price: 5000 }),
  ev({ type: "product_view", t: "03", price: 2700 }),
  ev({ type: "product_view", t: "04", price: 2750 }),
]);
assert.ok(["converging", "stable"].includes(conv.priceTrajectory));

// ordered path → decision window
const ordered = computeSignals([
  ev({ type: "product_view", t: "00", price: 100 }),
  ev({ type: "order_created", t: "10" }),
]);
assert.equal(ordered.ordered, true);
assert.equal(ordered.decisionWindowMs, 10_000);

console.log("signals selfcheck: OK");

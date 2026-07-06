// Run: npm run selfcheck  (tsx)
// ponytail: no test framework — asserts only. Covers the breakage-prone bits.
import assert from "node:assert/strict";
import { applyToLiveContext, normalizeWebhook, profileKeyFor } from "./derive";
import type { CanonicalEvent } from "./events";

const ev = (p: Partial<CanonicalEvent>): CanonicalEvent => ({
  eventId: "e1",
  shopId: "s",
  sessionId: "sess",
  type: "page_view",
  timestamp: "2026-06-26T00:00:00.000Z",
  source: "web_pixel",
  ...p,
});

// liveContext: product_view sets lastViewed, doesn't mutate input
const base = { recentSearches: [] as string[] };
const c1 = applyToLiveContext(base, ev({ type: "product_view", productId: "p9" }));
assert.equal(c1.lastViewedProductId, "p9");
assert.equal(base.recentSearches.length, 0, "input must not mutate");

// search prepends, newest first, capped at 10
let c = { recentSearches: ["old"] };
c = applyToLiveContext(c, ev({ type: "search", searchTerm: "waterproof" }));
assert.deepEqual(c.recentSearches, ["waterproof", "old"]);

// profile key prefers customerId
assert.equal(profileKeyFor({ sessionId: "x" }), "x");
assert.equal(profileKeyFor({ sessionId: "x", customerId: "c7" }), "c7");

// webhook mapping: cart → add_to_cart with summed cartValue
const cart = normalizeWebhook({
  topic: "CARTS_UPDATE",
  shop: "shop.myshopify.com",
  payload: { token: "tok", line_items: [{ price: "10", quantity: 2 }, { price: "5", quantity: 1 }] },
});
assert.equal(cart?.type, "add_to_cart");
assert.equal(cart?.sessionId, "cart_tok");
assert.equal(cart?.cartValue, 25);

// order uses checkout_token; product updates are dropped
const ord = normalizeWebhook({ topic: "ORDERS_PAID", shop: "s", payload: { checkout_token: "ck", total_price: "99.00" } });
assert.equal(ord?.type, "order_created");
assert.equal(ord?.sessionId, "ord_ck");
assert.equal(ord?.cartValue, 99);

// order prefers saleshq_sid from cart note_attributes (widget → checkout bridge)
const ordLinked = normalizeWebhook({
  topic: "ORDERS_PAID",
  shop: "s",
  payload: {
    checkout_token: "ck",
    total_price: "99.00",
    note_attributes: [{ name: "saleshq_sid", value: "sid_test123" }],
  },
});
assert.equal(ordLinked?.sessionId, "sid_test123");

assert.equal(normalizeWebhook({ topic: "PRODUCTS_UPDATE", shop: "s", payload: {} }), null);

// cart deltas: add raises cartValue by price, remove lowers it (never below 0)
const cartEv = (type: string, price?: number) =>
  ({ eventId: "e", shopId: "s", sessionId: "x", type, timestamp: new Date().toISOString(), source: "widget_seed", price }) as never;
let lc = applyToLiveContext({ recentSearches: [] }, cartEv("add_to_cart", 1699));
assert.equal(lc.cartValue, 1699, "add raises cartValue");
lc = applyToLiveContext(lc, cartEv("remove_from_cart", 1699));
assert.equal(lc.cartValue, 0, "remove empties cartValue");
lc = applyToLiveContext(lc, cartEv("remove_from_cart", 50));
assert.equal(lc.cartValue, 0, "cartValue floors at 0");

console.log("derive selfcheck: OK");

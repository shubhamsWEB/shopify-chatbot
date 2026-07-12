// Runnable check for the pure due()-logic (time + broadcast gating). No DB.
//   npx tsx app/nudges/selfcheck.ts
import assert from "node:assert";
import { onboarding } from "./campaigns/onboarding";
import { newFeature } from "./campaigns/newFeature";
import type { NudgeContext } from "./types";

const DAY = 24 * 60 * 60 * 1000;
const enrolledAt = new Date("2026-01-01T00:00:00Z");
const ctx = (offsetMs: number): NudgeContext => ({
  shop: "t.myshopify.com",
  enrolledAt,
  now: new Date(enrolledAt.getTime() + offsetMs),
});

const step = (id: string) => {
  const s = onboarding.steps.find((x) => x.id === id);
  assert(s, `missing step ${id}`);
  return s;
};

// welcome: due immediately, stays due
assert.equal(step("welcome").due(ctx(0)), true);
// day1: not due at 0, due at exactly 1 day
assert.equal(step("customize-day1").due(ctx(0)), false);
assert.equal(step("customize-day1").due(ctx(1 * DAY)), true);
// day7: not due at day 3, due at day 7
assert.equal(step("results-day7").due(ctx(3 * DAY)), false);
assert.equal(step("results-day7").due(ctx(7 * DAY)), true);

// broadcast gates on release date, not enrollment
const feat = newFeature.steps[0];
const before = { shop: "t", enrolledAt, now: new Date("2026-07-14T00:00:00Z") };
const after = { shop: "t", enrolledAt, now: new Date("2026-07-16T00:00:00Z") };
assert.equal(feat.due(before), false);
assert.equal(feat.due(after), true);

// every referenced template key has a matching def (catches key typos)
import { TEMPLATE_DEFS } from "./templates";
const defKeys = new Set(TEMPLATE_DEFS.map((d) => d.key));
for (const k of [
  "onboarding-welcome",
  "onboarding-brand",
  "onboarding-knowledge",
  "onboarding-results",
  "usage-warn",
  "usage-exhausted",
  "announcement",
]) {
  assert(defKeys.has(k), `missing template def: ${k}`);
}
assert.equal((await step("welcome").render(ctx(0))).templateKey, "onboarding-welcome");
const rendered = await feat.render(after);
assert.equal(rendered.templateKey, "announcement");
assert.equal(rendered.variables?.SUBJECT != null, true);

// unsubscribe token round-trips and rejects tampering
import { signShop, verifyShop } from "./unsub.server";
const tok = signShop("t.myshopify.com");
assert.equal(verifyShop("t.myshopify.com", tok), true);
assert.equal(verifyShop("other.myshopify.com", tok), false); // wrong shop
const flip = tok[0] === "a" ? "b" : "a";
assert.equal(verifyShop("t.myshopify.com", flip + tok.slice(1)), false); // tampered
assert.equal(verifyShop("t.myshopify.com", "short"), false); // length mismatch, no throw

console.log("nudges selfcheck OK");

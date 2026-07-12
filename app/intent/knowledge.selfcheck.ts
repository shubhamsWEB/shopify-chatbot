// Run: npm run selfcheck  (tsx)
// ponytail: no test framework — asserts only. Covers the derivation + offer
// window logic (the breakage-prone pure bits); DB paths aren't exercised here.
import assert from "node:assert/strict";
import { deriveSections, offerLive, rankSections } from "./knowledge.server";
import type { OkfDoc } from "./okf";

// --- deriveSections ---------------------------------------------------------

// 3 headings + a lede → 4 sections, anchors slugified from headings.
const doc = `Welcome to our store policies.

## Returns
Return within 30 days for a full refund.

## Shipping
We ship worldwide in 5-7 days.

## Warranty
One year manufacturer warranty.`;
const secs = deriveSections(doc);
assert.equal(secs.length, 4, "lede + 3 headings = 4 sections");
assert.equal(secs[0].heading, "", "first section is the lede");
assert.equal(secs[1].heading, "Returns");
assert.equal(secs[1].anchor, "returns");
assert.match(secs[1].text, /30 days/);
assert.equal(secs[3].anchor, "warranty");

// markdown stripped in the plain-text projection (links unwrapped, emphasis gone)
const md = deriveSections(`## Deal\nGet **20% off** on [chairs](https://x.com) today!`);
assert.equal(md[0].heading, "Deal");
assert.match(md[0].text, /20% off/);
assert.ok(!md[0].text.includes("**"), "emphasis markers stripped");
assert.ok(!md[0].text.includes("https://"), "link URL stripped, text kept");
assert.match(md[0].text, /chairs/);

// duplicate headings get unique anchors
const dup = deriveSections(`## FAQ\nq1\n## FAQ\nq2`);
assert.equal(dup[0].anchor, "faq");
assert.equal(dup[1].anchor, "faq-1", "second identical heading disambiguated");

// empty heading with no body is dropped
const empty = deriveSections(`## Empty\n\n## Real\nhas content`);
assert.equal(empty.length, 1, "heading with no body dropped");
assert.equal(empty[0].heading, "Real");

// --- offerLive --------------------------------------------------------------

const now = Date.parse("2026-07-09T00:00:00Z");
assert.equal(offerLive({ kind: "policy", effectiveFrom: null, effectiveTo: null }, now), true, "non-offers always live");
assert.equal(offerLive({ kind: "offer", effectiveFrom: null, effectiveTo: null }, now), true, "offer with open window is live");
assert.equal(
  offerLive({ kind: "offer", effectiveFrom: "2026-07-01T00:00:00Z", effectiveTo: "2026-07-31T00:00:00Z" }, now),
  true,
  "offer inside window is live",
);
assert.equal(
  offerLive({ kind: "offer", effectiveFrom: "2026-08-01T00:00:00Z", effectiveTo: null }, now),
  false,
  "offer not yet started is hidden",
);
assert.equal(
  offerLive({ kind: "offer", effectiveFrom: null, effectiveTo: "2026-07-01T00:00:00Z" }, now),
  false,
  "expired offer is hidden",
);

// --- rankSections (golden-QA, no DB) ----------------------------------------

const mkDoc = (kind: OkfDoc["kind"], title: string, body: string): OkfDoc => ({
  id: title, shop: "s", kind, title, body, sections: deriveSections(body),
  tags: [], effectiveFrom: null, effectiveTo: null, status: "published", updatedAt: "2026-07-09T00:00:00Z",
});

const corpus: OkfDoc[] = [
  mkDoc("policy", "Return & Refund Policy",
    "## Returns\nReturn any unused item within 30 days for a full refund.\n\n## Refund timing\nRefunds land within 5-7 business days.\n\n## Warranty\nAll products carry a 1 year manufacturer warranty."),
  mkDoc("faq", "Shipping FAQ",
    "## International shipping\nWe ship worldwide, 7-14 business days.\n\n## Free shipping\nFree on orders over 999 INR within India."),
  mkDoc("offer", "Monsoon Sale", "## Monsoon Sale\n20% off all ergonomic chairs, no code needed."),
];

const golden: Array<{ q: string; expect: RegExp }> = [
  { q: "how many days to return something", expect: /30 days/ },
  { q: "when will I get my refund", expect: /5-7 business days|30 days/ },
  { q: "do you ship to other countries", expect: /worldwide|7-14/ },
  { q: "is there any discount right now", expect: /20% off/ }, // synonym: discount→off/sale
  { q: "what warranty do you offer", expect: /1 year/ },
];
for (const g of golden) {
  const hits = rankSections(g.q, corpus);
  const joined = hits.map((h) => h.text).join(" | ");
  assert.ok(g.expect.test(joined), `rank "${g.q}" expected ${g.expect} in: ${joined || "(none)"}`);
}

// synonym bridge works: "delivery" finds the "shipping" doc
assert.ok(rankSections("how long is delivery", corpus).some((h) => /worldwide|7-14|Free/.test(h.text)), "delivery→shipping synonym");
// stopwords alone return nothing
assert.equal(rankSections("do you have any of this", corpus).length, 0, "stopword-only query returns nothing");
// unrelated query returns nothing (floor holds)
assert.equal(rankSections("blue whale migration patterns", corpus).length, 0, "irrelevant query returns nothing");

// --- PDF parse response handling (no network) -------------------------------

import { parseGeminiText, PdfParseError } from "./pdfparse.server";

// clean JSON from Gemini
const p1 = parseGeminiText('{"title":"Return Policy","kind":"policy","markdown":"## Returns\\nWithin 30 days."}');
assert.equal(p1.title, "Return Policy");
assert.equal(p1.kind, "policy");
assert.match(p1.markdown, /Returns/);
assert.equal(p1.effectiveFrom, null);

// code-fence-wrapped JSON is tolerated
const p2 = parseGeminiText('```json\n{"title":"Sale","kind":"offer","markdown":"## Sale\\n20% off","effectiveFrom":"2026-07-01","effectiveTo":"2026-08-01"}\n```');
assert.equal(p2.kind, "offer");
assert.equal(p2.effectiveFrom, "2026-07-01");

// invalid kind rejected; garbage rejected
assert.throws(() => parseGeminiText('{"title":"x","kind":"nonsense","markdown":"y"}'));
assert.throws(() => parseGeminiText("not json at all"));
let threw = false;
try { parseGeminiText("not json"); } catch (e) { threw = e instanceof PdfParseError; }
assert.ok(threw, "malformed JSON throws PdfParseError");

// --- knowledge gaps (pure parts) ---------------------------------------------

import { normalizeGapQuery, clusterGaps, type KnowledgeGap } from "./knowledgegaps.server";

// dedup key: punctuation/case/whitespace-insensitive, word order preserved
assert.equal(normalizeGapQuery("Return Policy?"), "return policy");
assert.equal(normalizeGapQuery("  return   POLICY!! "), "return policy");
assert.notEqual(normalizeGapQuery("policy return"), normalizeGapQuery("return policy"), "word order preserved");
assert.equal(normalizeGapQuery("???"), "", "punctuation-only yields empty (not recorded)");

// auto-resolve uses the same ranking as the live bot: a gap query that the
// corpus answers ranks non-empty; an uncovered one stays empty.
assert.ok(rankSections("how many days to return", corpus).length > 0, "covered gap would auto-resolve");
assert.equal(rankSections("do you have a loyalty points program", corpus).length, 0, "uncovered gap stays open");

// clustering: near-duplicate phrasings merge, unrelated questions stay apart
const mkGap = (id: string, query: string, count = 1): KnowledgeGap => ({
  id, query, count, status: "open", firstAsked: "2026-07-10T00:00:00Z", lastAsked: "2026-07-10T00:00:00Z",
});
const clusters = clusterGaps([
  mkGap("g1", "gift wrapping cost price", 3),
  mkGap("g2", "how much is gift wrap", 1),
  mkGap("g3", "do you have a loyalty program", 2),
  mkGap("g4", "loyalty points scheme details", 1),
  mkGap("g5", "what colors does the chair come in", 1),
]);
assert.equal(clusters.length, 3, "5 gaps -> 3 clusters (gift-wrap x2, loyalty x2, chair)");
const gift = clusters.find((c) => /gift/.test(c.query))!;
assert.equal(gift.count, 4, "cluster sums member ask-counts (3+1)");
assert.equal(gift.ids.length, 2, "cluster carries both member ids for dismissal");
assert.equal(gift.variants.length, 1, "variant phrasing captured");
assert.equal(clusters[0].query, gift.query, "most-asked cluster sorts first");

console.log("knowledge.selfcheck: OK");

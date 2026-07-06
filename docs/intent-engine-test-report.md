# SalesHQ Intent Engine — Live Verification Report

**Date:** 2026-07-02 · **Store:** saleshq-2.myshopify.com (production, Vercel) · **Method:** 15 independent simulated shoppers, each a fresh session driven through the real App Proxy (`/apps/saleshq/*`) with real catalog products. Every scenario seeds a genuine event sequence via `/ingest`, then asks the proactive engine (`/proactive` with `debug`) or chat (`/chat`) to decide — nothing mocked.

## Architecture under test (post-audit minimal stack)

```
Storefront (pixel + widget)
   └─ App Proxy /apps/saleshq/{ingest,chat,proactive,dismiss,engage}   HMAC-verified, shop derived server-side
        └─ Vercel (React Router app)
             ├─ Postgres/Neon: Event + IntentProfile   ← the ONLY store (no Redis, no queue, no worker)
             ├─ Realtime intent (intent-ondemand): deterministic signals on every read
             │    + inline LLM enrichment (Haiku) when ≥2 active events, then every 3, or any high-signal event
             ├─ Proactive engine: 3 pure gates (eligibility → signal → suppression) → single LLM compose
             └─ Chat: plain Anthropic agent↔tools loop (search/details/compare) + intent-ranked results
```

Removed in the audit: Redis (Upstash), BullMQ, the Railway worker, Stage-1 micro-summaries, LangGraph, the dual-backend switch. Intent is now computed **at read time** — a profile is never more than one request stale.

## Trigger matrix (what makes a popup fire)

All triggers additionally require: session ≥ 8s old, not dismissed, widget closed, not mid-form, per-trigger 5-min cooldown, intent confidence ≥ 0.15. Popups keep coming until the shopper clicks **"Don't show tips this session"** (session-long stop); plain close does not silence.

| Trigger | Surface | Friction signature | Intent score bar |
|---|---|---|---|
| `product_dwell` | product | dwell > 9s (1.8 × 5s baseline) | ≥ 0.08 |
| `product_compare` | product | returned to a product ≥ 2× after leaving (PDP loop) | ≥ 0.10 |
| `browse_no_addtocart` | category | scroll-thrash ≥ 3 | ≥ 0.05 |
| `search_refinement` | search | scroll-thrash ≥ 2 with repeated searches | ≥ 0.05 |
| `cart_idle` | cart | idle on cart > 25s (exempt from smooth-progression suppression) | ≥ 0.15 |
| `exit_intent` | any | cursor leaves viewport top | bypasses score |

Suppression: smoothly progressing buyers (added to cart, no friction loops) are left alone; friction-defined reasons (exit, cart_idle, search_refinement, browse, checkout) always count as having a concrete help action.

## Scenario results — positives (6/6 fired)

| # | Persona | Seeded behavior (real products) | Result |
|---|---|---|---|
| 1 | Lingerer | 1 PDP view of Liquid ₹749.95 + 12s dwell | ✅ `product_dwell` — "…in stock at ₹749.95 — a solid pick right at your budget" + 3 cards + chips |
| 2 | Budget comparer | Hydrogen↔Multi↔Liquid loop (5 views) + search "snowboard under 700" | ✅ `product_compare`, intent class **comparison**, score 0.22, confidence 1.0 — side-by-side markdown table of 3 in-budget boards |
| 3 | Category scroller | 2 collection views + scroll-thrash 4 | ✅ `browse_no_addtocart` — 4 picks across price points + narrowing question |
| 4 | Search refiner | 3 searches ("snowboard" → "cheap…" → "…under 700") + thrash 3 | ✅ `search_refinement` — "3 in-stock snowboards all under ₹700 — what matters most…" (after fix, see below) |
| 5 | Hesitant carter | View + add-to-cart Hydrogen, then 27s idle on cart | ✅ `cart_idle`, intent class **targeted_purchase**, score 0.32 — returns/exchange reassurance + 4 cards |
| 6 | Abandoner | View Oxygen ₹1,025 then mouse-out (exit intent) | ✅ `exit_intent` — "Before you go — the Oxygen you were looking at is in stock…" + chips |

## Scenario results — negatives (6/6 correctly silent)

| # | Case | Expectation | Result |
|---|---|---|---|
| 7 | Idle bounce (1 view, no friction) | silent | ✅ signal gate: none |
| 8 | Smooth buyer (dwell but added to cart) | suppressed | ✅ smooth-progression 0.75 ≥ 0.7 blocks dwell nudge |
| 9 | Session < 8s | blocked | ✅ eligibility fail |
| 10 | Widget already open | blocked | ✅ eligibility fail |
| 11 | Same trigger again immediately | blocked | ✅ 5-min per-trigger cooldown |
| 12 | After "Don't show tips" dismissal | blocked | ✅ eligibility fail, session-long |

## Multi-nudge + personalization

| # | Case | Result |
|---|---|---|
| 13 | Second nudge, same session, different reason (dwell shown earlier → then comparison loop) | ✅ `product_compare` fired — per-reason budgets independent, maxPerSession 99 |
| 14 | Chat "which snowboard should I get?" as the budget comparer | ✅ Only in-budget boards returned: Hydrogen ₹600 (**Best match**), Complete ₹699.95 (**In budget**) — price ceiling learned from behavior, never typed |

## Intent engine observations

- Deterministic layer is instant and correct: conversionScore 0.10 (single view) → 0.22 (comparison loop) → 0.32 (add-to-cart), matching calibration.
- Inline LLM enrichment produced correct classes: comparison persona → `comparison` (confidence 1.0), carter → `targeted_purchase`, browsers → `exploration`.
- Nudge copy is grounded in the profile: budget ceilings, the exact product viewed, colorway counts — no hallucinated products (all cards resolve to live Storefront API data).

## Bug found & fixed during this run

`search_refinement` was suppressed for shoppers whose intent class (`targeted_purchase`/`cart_hesitation`) had no "search" surface in the relevance map, even though the friction itself defines the help. Fix: `search_refinement` and `browse_no_addtocart` now count as friction-defined help in `hasHelpAction` (app/intent/proactive/triggers.ts). Re-tested live: fires correctly.

## Known quirks (non-blocking)

- The ₹10 Gift Card occasionally wins the "Best match" badge (it always fits any budget). Candidate fix: exclude `giftcard` type from intent ranking.
- `_debug.intent.ageMs` can read slightly negative (profile recomputed after the request timestamp is captured) — cosmetic only.
- The Complete Snowboard flipped to out-of-stock mid-testing; the engine correctly kept recommending in-stock alternatives.

## Real-browser persona sessions (2026-07-02, Frido catalog)

Second pass, run exactly as shoppers experience it: fresh `saleshq_sid` cookie per persona, real Chrome, real theme, real navigation/clicks/scrolls — no seeded API events. Catalog = 100 real Frido products (chairs, pillows, cushions, insoles, orthotics; most out of stock, which exercised the OOS paths).

| Persona | Real behavior | Result |
|---|---|---|
| Lingerer (snowboard) | sat on a PDP ~28s | ✅ dwell popup, names the exact product + price |
| Comparer (snowboard) | ping-ponged 2 PDPs | ✅ `product_compare` (verified via trigger cooldown) |
| Lingerer (Frido, OOS) | sat on sold-out Pro Seat Cushion | ✅ "currently out of stock, but here are in-stock alternatives… similar comfort and pain relief" + Coccyx ₹1699 |
| Comparer (Frido) | Socket ↔ Coccyx cushion loop | ✅ `product_compare`, body-weight-variant aware copy |
| Hesitant carter | real Add-to-Cart click → idled on /cart ~45s | ✅ `cart_idle`: "make sure you've selected the right weight variant… in your cart" + complementary cushion |
| Search refiner | searched "insole" → "arch support insole", scrolled up/down | ✅ `search_refinement`: "what matters most — arch support level, custom fit, or budget?" + in-stock scan services |
| Category browser | browsed /collections/all with thrash scrolling | ✅ `browse_no_addtocart` (server verified; timers throttled in the hidden automation tab — see caveats) |
| Abandoner | mouse-out toward tab bar on an OOS chair PDP | ✅ `exit_intent`: "out of stock in both colours — in-stock alternative worth a look" |
| Dismisser | clicked "Don't show tips this session", navigated on, exited again | ✅ silent — eligibility fail persists across pages |

### Bugs found only by real-browser testing (all fixed + deployed)

1. **Stale exit-intent hijacked later popups** — an `exit_intent` event stayed in the session ring forever and outranked cart_idle/compare for the rest of the session. Fix: exit intent counts only from the live trigger or an event <30s old (`friction.ts`).
2. **Gift Card polluted recommendations** — always in-budget, so ranking loved it ("Best match" on a ₹10 gift card next to a cushion). Fix: gift cards excluded from `search_products` unless the query asks for one (`storefront.server.ts`).
3. **Pixel dead on password-protected stores** — the Web Pixel's sandboxed fetch carries no `storefront_digest` cookie, so every event 302'd into the password wall. Invisible on public stores; fatal on dev/preview stores. Fix: the widget seeds `product_view` / `collection_view` / `search` / cart-contents events from the page context (`source: widget_seed`), and ingest dedupes them against pixel events within 90s — no double-count when the pixel is healthy.
4. **Theme swallowed scroll events** — the live theme emits zero `scroll` events (custom view-transition scripts), so event-based thrash detection never fired. Fix: widget polls `scrollY` every 400ms instead (theme-agnostic).
5. **Missing pixel scopes after app re-link** — the new dev-dashboard app lacked `write_pixels`/`read_customer_events`, and `webPixelCreate`'s failure was a silent GraphQL userError. Fixes: scopes added to `shopify.app.toml` (merchant re-approval required), and afterAuth now logs `webPixelCreate` userErrors instead of swallowing them.

### Final positive test — full journey with a known intent

Scripted intent: *budget shopper hunting a seat cushion for tailbone/back pain (~₹1,700), torn between two models, hesitates with the cart.* Journey (all real browser actions, one session): search "seat cushion" → viewed Pro (OOS) → Coccyx → Socket → back to Coccyx → added Coccyx to cart → viewed cart → **removed it** → returned to Coccyx and lingered. Then hands off.

**Engine's read:** conversionScore 0.51, class `comparison`, confidence 1.0. Before the removal it read `targeted_purchase` 0.44 and stayed correctly silent (smooth path to purchase); the remove event flipped it to hesitant-comparer and unlocked the nudge — exactly the calibrated semantics.

**The popup fired unprompted** with: "Here's the side-by-side on the two cushions **you've been going back and forth on**" + a comparison table of **exactly the two products the shopper was torn between** (Coccyx ₹1,699 vs Socket ₹1,799 — price, stock, body-weight variants, pack options), a key-difference paragraph (tailbone-relief focus vs pack-of-2 value), and a recommendation anchored to the shopper's cart activity. Post-show, the same trigger correctly entered cooldown.

One nit: the copy said "already in your cart" moments after removal (compose raced the remove event by a page-load). Content was otherwise fully grounded.

This journey also surfaced the last gap: **cart removals were invisible** without the pixel (the engine kept treating the shopper as a smooth buyer). Fix: the widget now diffs the live cart against a local snapshot on every page load and seeds `add_to_cart` / `remove_from_cart` transitions.

### Post-journey polish (verified live)

- **"Already in your cart" race fixed** twice over: live-context cart value now decrements on `remove_from_cart` (was stuck at the last add; selfcheck covers add/remove/floor-at-zero), and every proactive call awaits the page's seed events before the engine composes — the session can no longer be read mid-update.
- **Welcome auto-open added**: once per browser session, if nothing has spoken by 30s, the chat opens itself with the standing welcome + starter chips (pure UI, no LLM cost). The 30s delay lets intent nudges win; welcome only fills the silence. It respects "Don't show tips" (dismiss flag now persists across pages) and never re-fires after any conversation. Verified live: home page → welcome auto-opened; same session on a PDP → the richer intent nudge (OOS-aware) still fired instead of a second welcome.

### Automation caveats (not product bugs)

- Chrome throttles timers to ~1/min in hidden/unfocused tabs — widget polls and re-checks slow down accordingly. Real shoppers (visible tab) are unaffected; two scenarios needed the trigger sent manually because the test tab was backgrounded.
- Exit intent was dispatched as a synthetic `mouseout` (clientY < 0) — byte-identical to what a real cursor exit produces.

## Re-running this suite

Harness: a standalone Python script (no deps) that logs through the storefront password wall and drives the proxy. Ask Claude for `scenarios.py`, or re-create: seed events via POST `/apps/saleshq/ingest` (unique `sessionId` per persona, timestamps ≥ 8s in the past), then POST `/apps/saleshq/proactive` with `{"sessionId", "surface", "debug": true}` and inspect `_debug.gates` / `_debug.intent`.

## Config knobs (env, no redeploy)

`PROACTIVE_MAX_PER_SESSION` (99) · `PROACTIVE_TRIGGER_COOLDOWN_MS` (300000) · `PROACTIVE_INTENT_THRESHOLD` (0.15) · `PROACTIVE_MIN_CONFIDENCE` (0.15) · `PROACTIVE_MIN_SESSION_AGE_MS` (8000) · `PROACTIVE_HOLDOUT_PCT` (0) · `PROACTIVE_SHADOW` (false) · `INTENT_MODEL` (claude-haiku-4-5) · `EMBEDDINGS_API_KEY` (unset → semantic neighbor ranking off)

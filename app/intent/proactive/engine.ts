// Proactive decision engine (spec §5 graph, §8 compose, §9 emit, §12 logging).
// Deviation from spec: gates run as a short-circuiting pure-function pipeline
// rather than a LangGraph StateGraph — same fail-closed ordering and the same
// cost invariant (the model is touched only after all three gates pass).
import { readProfile } from "../profile.server";
import { runChat } from "../chat.server";
import type { ChatResult } from "../chat.server";
import type { LiveContext } from "../derive";
import { getSession, claimEmit, markShown, markDismissed } from "../cache.server";
import { getSettings, getBackofficeMeta } from "../settings.server";
import { ensureProfile } from "../intent-ondemand.server";
import { config } from "./config";
import { toIntentSnapshot } from "./intent-snapshot";
import { computeFriction } from "./friction";
import { eligibilityGate, signalGate, suppressionGate } from "./gates";
import type { GateInput } from "./gates";
import { isHoldout } from "./holdout";
import {
  emptyPopups, type Surface, type IntentSnapshot,
  type DecisionRecord, type TriggerInput,
} from "./types";

export interface ProactiveResult extends Partial<ChatResult> {
  show: boolean;
  _debug?: unknown; // present only when opts.debug — gate decision for diagnostics
}

export { isHoldout } from "./holdout";

function logDecision(rec: DecisionRecord) {
  console.log("[proactive] decision", JSON.stringify(rec));
}

function record(
  t: TriggerInput, intent: IntentSnapshot | null, now: number,
  gates: DecisionRecord["gates"], fired: boolean, triggerReason: string | null,
  holdout: boolean, deduped = false,
): DecisionRecord {
  return {
    ts: now, sessionId: t.sessionId, shop: t.shop, surface: t.surface,
    intent: intent
      ? { score: intent.score, class: intent.class, confidence: intent.confidence, ageMs: now - intent.updatedAt }
      : { score: 0, class: "none", confidence: 0, ageMs: -1 },
    gates, fired, triggerReason, deduped, holdout, shadow: config.shadowMode,
  };
}

// Build the compose directive from the fired trigger (spec §8.2 opener + guardrails).
function buildDirective(
  reason: string, surface: Surface, productId: string | undefined,
  live: LiveContext | undefined,
): string {
  const pid = productId || live?.lastViewedProductId;
  const skip = "If a proactive nudge is NOT clearly helpful right now, reply with exactly: SKIP (nothing else).";
  const noDiscount = reason === "exit_intent" && config.policy.discountAllowed
    ? "A modest incentive is permitted since they're leaving."
    : "Do NOT offer any discount, coupon, or promo code.";
  const base = `You are sending the FIRST proactive message, unprompted. The shopper has not asked for help. Lead with concrete help tied to their intent. One or two sentences; let any product cards carry the detail. ${noDiscount}`;

  switch (reason) {
    case "exit_intent":
      return `${base} The shopper appears about to leave (${surface}). Offer one genuinely useful reason to stay — a relevant in-stock option or a quick answer. ${pid ? `If they were viewing ${pid}, reference it.` : ""} ${skip}`;
    case "product_dwell":
      return `${base} The shopper is lingering on product ${pid}. Call get_product_details(${pid}) first. If in stock, reply with ONE short sentence on its single best benefit for this shopper, then search_products(inStockOnly) for 2-3 similar items (shown as cards); if out of stock, note it in one line and search_products(inStockOnly) for 2-3 alternatives. Do NOT output a markdown table — prose is one sentence, the cards carry the rest. ${skip}`;
    case "product_compare":
      return `${base} The shopper has been comparing several products (last: ${pid}).${live?.cartValue ? " They already have an item in the cart — they may be second-guessing it, so include the carted product in the comparison if you can identify it." : ""} Lead with ONE short sentence framing the comparison, then call compare_products on 2-3 of the in-stock products they've engaged to show a side-by-side table. ${skip}`;
    case "cart_idle":
      return `${base} The shopper has an idle cart (value ${live?.cartValue}). Address what might be holding them up (shipping, returns, a size swap) in one line, or offer a complementary in-stock product via search_products(inStockOnly). ${skip}`;
    case "browse_no_addtocart":
      return `${base} The shopper is browsing a category without adding anything. Offer to narrow the selection; recommend 2-4 in-stock products fitting their intent via search_products(inStockOnly). ${skip}`;
    case "search_refinement":
      return `${base} The shopper is refining search results. Ask what attribute matters most and recommend 2-4 in-stock matches via search_products(inStockOnly). ${skip}`;
    default:
      return `${base} Offer one concrete, relevant next step. ${skip}`;
  }
}

// Enforce post-generation guardrails (spec §8.5). Returns null to drop (fail closed).
function applyGuardrails(reason: string, result: ChatResult): ChatResult | null {
  const text = result.response ?? "";
  if (/^\s*SKIP\b/i.test(text) && result.products.length === 0) return null; // model declined
  if (reason !== "exit_intent" && /\b(discount|coupon|promo code|% off|percent off)\b/i.test(text)) {
    console.warn("[proactive] dropped: discount outside exit-intent");
    return null;
  }
  // Truncate over-length prose at a word boundary; cards carry the rest.
  // Skip truncation when a markdown table is present (cutting it mid-row breaks rendering).
  const hasTable = /\|.*\|/.test(text);
  if (!hasTable && text.length > config.compose.maxMessageChars) {
    const cut = text.slice(0, config.compose.maxMessageChars);
    result.response = cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length) + "…";
  }
  return result;
}

/**
 * Decide whether to proactively pop, and with what. Backward-compatible entry
 * point (route calls it). Optional signals come from widget instrumentation.
 */
export async function decideProactive(
  shopId: string,
  sessionId: string,
  productId?: string,
  opts: { surface?: Surface; exitIntent?: boolean; activeFormField?: boolean; widgetOpen?: boolean; debug?: boolean } = {},
): Promise<ProactiveResult> {
  const now = Date.now();
  // Per-shop merchant config (admin Bot settings). Master switch + gate knobs.
  const { config: shopCfg } = await getSettings(shopId);
  const backoffice = await getBackofficeMeta(shopId);
  if (!shopCfg.proactiveEnabled) return { show: false };
  if (backoffice.botEnabled === false) return { show: false }; // developer kill switch
  const elig = {
    ...config.eligibility,
    minSessionAgeMs: shopCfg.minTimeOnSiteSec * 1000,
    maxPerSession: shopCfg.maxPopupsPerSession,
    perTriggerCooldownMs: shopCfg.sameNudgeCooldownMin * 60_000,
  };
  // Realtime intent refresh (deterministic + inline LLM when due).
  await ensureProfile(shopId, sessionId, sessionId).catch(() => {});
  const [profile, session] = await Promise.all([
    readProfile(shopId, sessionId).catch(() => null),
    getSession(shopId, sessionId).catch(() => null),
  ]);
  const surface: Surface = opts.surface ?? session?.surface ?? "other";
  const holdout = session?.holdout ?? isHoldout(sessionId);
  const intent = toIntentSnapshot(profile);
  const trigger: TriggerInput = { shop: shopId, sessionId, surface, productId, exitIntent: opts.exitIntent };

  // Log every decision; optionally surface it in the response for debugging.
  const fin = (rec: DecisionRecord, extra: Partial<ProactiveResult> = {}): ProactiveResult => {
    logDecision(rec);
    const base: ProactiveResult = { show: rec.fired, ...extra };
    return opts.debug ? { ...base, _debug: { ...rec, surface } } : base;
  };

  // ingest → no session means fail closed at eligibility.
  if (!session) {
    return fin(record(trigger, intent, now, { eligibility: "fail", signal: "none", suppression: "skip" }, false, null, holdout));
  }

  const popups = session.popups ?? emptyPopups();
  const friction = computeFriction(session.recentEvents, surface, !!opts.exitIntent);
  const live = session.liveContext;

  const gi: GateInput = {
    now, startedAt: new Date(session.startedAt).getTime(), surface, popups, friction, intent,
    activeFormField: !!opts.activeFormField, widgetOpen: !!opts.widgetOpen, holdout,
  };

  // Gate 1
  if (eligibilityGate(gi, elig)) {
    return fin(record(trigger, intent, now, { eligibility: "fail", signal: "none", suppression: "skip" }, false, null, holdout));
  }
  // Gate 2
  const triggerReason = signalGate(gi, elig);
  if (!triggerReason) {
    return fin(record(trigger, intent, now, { eligibility: "pass", signal: "none", suppression: "skip" }, false, null, holdout));
  }
  // Gate 3
  if (suppressionGate(gi, triggerReason)) {
    return fin(record(trigger, intent, now, { eligibility: "pass", signal: `trigger:${triggerReason}`, suppression: "fail" }, false, triggerReason, holdout));
  }

  // All gates passed. Shadow mode: log a would-fire, show nothing (spec §15 Phase 2).
  const gates = { eligibility: "pass", signal: `trigger:${triggerReason}`, suppression: "pass" };
  if (config.shadowMode) {
    return fin(record(trigger, intent, now, gates, false, triggerReason, holdout));
  }

  // Idempotent emit guard (spec §9.1): only one run per (session,trigger) shows.
  if (!claimEmit(triggerReason, popups, elig.perTriggerCooldownMs)) {
    return fin(record(trigger, intent, now, gates, false, triggerReason, holdout, true));
  }

  // compose — the only LLM call.
  let result: ChatResult;
  try {
    result = await runChat({ shopId, sessionId, message: buildDirective(triggerReason, surface, productId, live) });
  } catch (err) {
    const msg = (err as Error).message;
    console.error("[proactive] compose error", msg);
    const rec = record(trigger, intent, now, gates, false, triggerReason, holdout);
    logDecision(rec);
    return opts.debug ? { show: false, _debug: { ...rec, composeError: msg } } : { show: false };
  }

  const guarded = applyGuardrails(triggerReason, result);
  if (!guarded) {
    // declined/invalid → no proactive_shown row is written, so the cap isn't burned
    return fin({ ...record(trigger, intent, now, gates, false, triggerReason, holdout), triggerReason: `${triggerReason}:skip` as string });
  }

  // emit: caps writeback (a proactive_shown Event row) + log.
  await markShown(shopId, sessionId, triggerReason);
  return fin(record(trigger, intent, now, gates, true, triggerReason, holdout), guarded);
}

// Dismissal handler (spec §9.2) — separate entry, NOT in the decision pipeline.
export async function onDismiss(shop: string, sessionId: string): Promise<void> {
  await markDismissed(shop, sessionId);
  console.log("[proactive] feedback", JSON.stringify({ sessionId, kind: "dismissed" }));
}

// Engagement handler (spec §9.3) — user replied; reactive graph takes over.
export async function onEngage(shop: string, sessionId: string): Promise<void> {
  console.log("[proactive] feedback", JSON.stringify({ sessionId, kind: "engaged" }));
}

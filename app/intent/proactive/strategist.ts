// ReAct strategist — the "street smarts" of the proactive engine.
// OBSERVE: the raw session tape (every permitted event, in order), friction
// features, intent snapshot, and what was already nudged. REASON: is an
// unprompted nudge RIGHT NOW genuinely helpful, or pushy/noise? DECIDE: nudge
// with a concrete angle, or wait. The ACT phase is runChat's existing tool
// loop (search/compare/details), which executes the chosen angle.
//
// Cost containment is structural: the deterministic gates (caps, cooldowns,
// session age, dismissals) run BEFORE this and short-circuit for free; the
// strategist only fires for the generic class-fallback cases where the rule
// table has no specific friction signature — the hard signatures (cart_regret,
// product_compare, cart_idle, exit_intent…) stay deterministic and instant.
import { toolCall, HAIKU } from "../claude.server";
import { eventLog } from "../stage2";
import type { CanonicalEvent } from "../events";
import type { FrictionFeatures, IntentSnapshot, PopupsState } from "./types";

// eslint-disable-next-line no-undef
const STRATEGIST_MODEL = process.env.PROACTIVE_STRATEGIST_MODEL || HAIKU;

export interface StrategistDecision {
  nudge: boolean;
  why: string;            // one-line reasoning, logged for observability
  angle?: string;         // when nudging: the concrete help to lead with
  focusProductId?: string; // product the angle centers on, if any
}

const SYSTEM =
  "You are the timing brain of a proactive shopping assistant on a Shopify storefront. " +
  "Given one shopper's live session tape, decide whether an UNPROMPTED nudge right now would genuinely help them, or would feel pushy and hurt trust.\n" +
  "Read the tape as a sequence: what they searched, viewed, lingered on, carted, removed; prices tell you their budget band.\n" +
  "DEFAULT TO NUDGING: the system has already decided help is warranted; your job is to sharpen the angle and only hold back in the few cases where a nudge would clearly annoy. " +
  "NUDGE whenever you can name CONCRETE help tied to what they are doing (help pick between things they compared, alternatives to what didn't fit, a direction when browsing). " +
  "Only WAIT when the shopper is clearly progressing smoothly toward checkout, literally just landed with almost no activity, or a very similar nudge was already shown or dismissed this session. When unsure, NUDGE.\n" +
  "The angle must be specific to THIS shopper's tape, never generic ('can I help you find something?' is a failure). ≤35 words, phrased as instructions to the assistant that will write the message. " +
  "Set focusProductId only to a product id that appears in the tape.";

export async function decideStrategy(args: {
  shop: string;
  surface: string;
  events: CanonicalEvent[];
  friction: FrictionFeatures;
  intent: IntentSnapshot;
  popups: PopupsState;
  startedAtMs: number;
}): Promise<StrategistDecision | null> {
  const now = Date.now();
  const shownHistory = Object.entries(args.popups.byTrigger)
    .map(([reason, at]) => `${reason} ${Math.round((now - at) / 60000)}m ago`)
    .join(", ") || "none";
  const user =
    `Surface: ${args.surface} · Time on site: ${Math.round((now - args.startedAtMs) / 1000)}s\n` +
    `Intent: score=${args.intent.score.toFixed(2)} class=${args.intent.class} confidence=${args.intent.confidence.toFixed(2)}\n` +
    `Friction: ${JSON.stringify({ dwellMs: args.friction.dwellMs, pdpLoops: args.friction.pdpLoopCount, postAddViews: args.friction.postAddDistinctViews, cartRemoveRecent: args.friction.cartRemoveRecent, smooth: args.friction.smoothProgressionScore })}\n` +
    `Nudges already shown: ${shownHistory} · dismissed this session: ${args.popups.dismissed}\n\n` +
    `Session tape (chronological):\n${eventLog(args.events)}`;

  try {
    return await toolCall<StrategistDecision>({
      model: STRATEGIST_MODEL,
      system: SYSTEM,
      user,
      shop: args.shop,
      toolName: "decide_nudge",
      toolDescription: "Decide whether to nudge this shopper right now, and with what concrete angle.",
      maxTokens: 300,
      schema: {
        properties: {
          nudge: { type: "boolean" },
          why: { type: "string", description: "One-line reasoning, ≤20 words." },
          angle: { type: "string", description: "When nudging: the concrete help to lead with, ≤35 words." },
          focusProductId: { type: "string" },
        },
        required: ["nudge", "why"],
      },
    });
  } catch (err) {
    console.error("[proactive] strategist failed:", (err as Error).message);
    return null; // fail open to the dumb fallback — a generic nudge beats none
  }
}

// Instance-local debounce: re-reason only when the session tape actually grew.
// Serverless-local is fine — worst case a cold instance re-runs one cheap call.
const lastRun = new Map<string, { at: number; lastEventAt: string }>();
const MIN_GAP_MS = 15_000;
const MAX_KEYS = 5_000;

export function strategistDue(shop: string, sessionId: string, lastEventAt: string): boolean {
  const key = `${shop}:${sessionId}`;
  const prev = lastRun.get(key);
  const now = Date.now();
  if (prev && (now - prev.at < MIN_GAP_MS || prev.lastEventAt === lastEventAt)) return false;
  if (lastRun.size > MAX_KEYS) lastRun.clear(); // ponytail: crude cap; LRU if it ever matters
  lastRun.set(key, { at: now, lastEventAt });
  return true;
}

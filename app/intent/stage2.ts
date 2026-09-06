// Intent aggregation: one model call reads the raw event sequence + deterministic
// signals, emits the narrative and subjective profile fields. Observable-only:
// nothing not grounded in the data. Runs INLINE at read time (no worker/queue) —
// Haiku by default for realtime latency; INTENT_MODEL env upgrades it.
import { toolCall, HAIKU } from "./claude.server";
import type { CanonicalEvent, IntentProfile } from "./events";
import type { Signals } from "./signals";

// eslint-disable-next-line no-undef
const INTENT_MODEL = process.env.INTENT_MODEL || HAIKU;

// Compact one-line-per-event log (replaces the old Stage-1 micro-summaries —
// 50 events fit in a prompt fine, so the compression stage bought nothing).
export function eventLog(events: CanonicalEvent[]): string {
  return events
    .map((e) => {
      const parts = [e.timestamp, e.type];
      if (e.productId) parts.push(`product=${e.productId}`);
      if (e.category) parts.push(`category=${e.category}`);
      if (e.brand) parts.push(`brand=${e.brand}`);
      if (e.price != null) parts.push(`price=${e.price}`);
      if (e.searchTerm) parts.push(`search="${e.searchTerm}"`);
      if (e.dwellMs) parts.push(`dwellMs=${e.dwellMs}`);
      return parts.join(" ");
    })
    .join("\n");
}

interface AggregateOut {
  intentNarrative: string;
  decisionPhase?: IntentProfile["decisionPhase"];
  engagementStyle?: IntentProfile["engagementStyle"];
  filterStrategy?: IntentProfile["filterStrategy"];
  priceCeiling?: number;
  priceSensitivity?: IntentProfile["priceSensitivity"];
  attributePriorities?: string[];
  urgencyResponsive?: boolean;
  cartHesitation?: IntentProfile["cartHesitation"];
  contradictions?: Array<{ stated: string; revealed: string }>;
  conversionLikelihood?: number;
  queryIntent?: IntentProfile["queryIntent"];
  nextBestAction?: string;
}

const SYSTEM =
  "You build a per-shopper intent profile for a single store. Synthesize the chronological " +
  "event log and the deterministic signals into a 1–3 sentence observable-only narrative " +
  "plus structured fields. CRITICAL: include a field ONLY if the data supports it. Do not invent intent.\n" +
  "Read the events as a SEQUENCE: the order, transitions, and deltas carry the intent — price-bracket " +
  "shifts (use priceTrajectory/priceBand), category journey, product revisits (comparison), add→remove " +
  "timing. Classify the shopper's query intent: exploratory (browsing broadly), targeted (a specific item), " +
  "comparing (weighing options), or deal_seeking (price/discount-led). Decide the single nextBestAction " +
  "that would most help them right now. Surface stated-vs-revealed contradictions explicitly.\n" +
  "CURRENCY: every price in the event log is in the STORE'S currency (given in the user message). Write all " +
  "money amounts in the narrative and nextBestAction using that currency's code or symbol. NEVER write $, USD, " +
  "or any other currency unless it IS the store currency.";

export async function aggregate(args: {
  shopId: string;
  sessionId: string;
  customerId?: string;
  events: CanonicalEvent[];
  signals: Signals;
  liveContext?: Record<string, unknown>;
}): Promise<IntentProfile> {
  const { signals } = args;
  // Store currency rides on pixel events; "unknown" keeps the model from
  // assuming dollars when no event carried it.
  const currency = args.events.map((e) => e.currency).find(Boolean) ?? "unknown — write plain numbers without any currency symbol";
  const user =
    `Store currency: ${currency}\n\n` +
    `Chronological event log:\n${eventLog(args.events)}\n\n` +
    `Deterministic signals:\n${JSON.stringify(signals)}\n\n` +
    `Live context:\n${JSON.stringify(args.liveContext ?? {})}`;

  const out = await toolCall<AggregateOut>({
    model: INTENT_MODEL,
    system: SYSTEM,
    user,
    toolName: "record_intent",
    shop: args.shopId,
    toolDescription: "Record the shopper's intent narrative and structured profile.",
    maxTokens: 1024,
    schema: {
      properties: {
        intentNarrative: { type: "string", description: "1–3 sentences, observable-only." },
        decisionPhase: { type: "string", enum: ["browsing", "comparing", "deciding"] },
        engagementStyle: { type: "string", enum: ["skimmer", "researcher"] },
        filterStrategy: { type: "string", enum: ["price_first", "category_first", "brand_first", "mixed"] },
        priceCeiling: { type: "number", description: "Discovered price ceiling, if observable." },
        priceSensitivity: { type: "string", enum: ["high", "medium", "low"] },
        attributePriorities: { type: "array", items: { type: "string" } },
        urgencyResponsive: { type: "boolean" },
        cartHesitation: { type: "string", enum: ["low", "medium", "high"] },
        contradictions: {
          type: "array",
          items: {
            type: "object",
            properties: { stated: { type: "string" }, revealed: { type: "string" } },
            required: ["stated", "revealed"],
          },
        },
        conversionLikelihood: { type: "number", description: "0..1" },
        queryIntent: { type: "string", enum: ["exploratory", "targeted", "comparing", "deal_seeking"] },
        nextBestAction: { type: "string", description: "Single most useful next move for this shopper, ≤12 words." },
      },
      required: ["intentNarrative"],
    },
  });

  // Merge LLM output with deterministic signals (signals win for countable fields).
  return {
    sessionId: args.sessionId,
    customerId: args.customerId,
    shopId: args.shopId,
    lastUpdated: new Date().toISOString(),
    eventsConsidered: signals.eventsConsidered,
    computeTier: "warm",
    intentNarrative: out.intentNarrative,
    // sequence/derived fields: deterministic signals are authoritative; LLM fills the subjective ones.
    decisionPhase: out.decisionPhase ?? signals.decisionPhase,
    engagementStyle: out.engagementStyle ?? (signals.engagementDepth === "deep" ? "researcher" : signals.engagementDepth === "skim" ? "skimmer" : undefined),
    filterStrategy: out.filterStrategy,
    priceCeiling: out.priceCeiling ?? signals.priceBand?.high ?? signals.maxPriceViewed,
    priceSensitivity: out.priceSensitivity,
    categoriesViewed: signals.categoriesViewed,
    brandsViewed: signals.brandsViewed,
    attributePriorities: out.attributePriorities ?? signals.attributeTerms.slice(0, 6),
    urgencyResponsive: out.urgencyResponsive,
    cartHesitation:
      out.cartHesitation ?? (signals.cartAddRemoveCycles >= 2 ? "high" : signals.cartAddRemoveCycles === 1 ? "medium" : "low"),
    recentSearches: signals.recentSearches,
    decisionWindowDays: signals.decisionWindowMs != null ? signals.decisionWindowMs / 86_400_000 : undefined,
    contradictions: out.contradictions,
    conversionLikelihood: out.conversionLikelihood,
    conversionScore: signals.conversionScore,
    focusCategory: signals.focusCategory,
    priceTrajectory: signals.priceTrajectory,
    priceBand: signals.priceBand,
    queryIntent: out.queryIntent,
    nextBestAction: out.nextBestAction,
  };
}

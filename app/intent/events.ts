// Canonical event schema (spec §5). Every Shopify source normalizes to this one shape.
import { z } from "zod";

export const EVENT_TYPES = [
  "page_view",
  "product_view",
  "collection_view",
  "search",
  "filter_applied",
  "add_to_cart",
  "remove_from_cart",
  "checkout_started",
  "checkout_abandoned",
  "order_created",
  // proactive friction signals (widget-instrumented)
  "exit_intent",
  // proactive popup ledger (Postgres-backend caps; spec §9 emit/dismiss)
  "proactive_shown",
  "proactive_dismissed",
  "proactive_engaged", // shopper replied to a popup — resets the unanswered-nudge counter
  // chatbot-originated (feedback loop, §9)
  "bot_suggestion_shown",
  "bot_comparison_shown",
  "bot_product_clicked",
  "bot_add_to_cart",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// Engaged actions carry intent; passive loads are context only (spec §3.1.2).
export const ACTIVE_EVENT_TYPES = new Set<EventType>([
  "product_view",
  "search",
  "filter_applied",
  "add_to_cart",
  "remove_from_cart",
  "checkout_started",
  "checkout_abandoned",
  "order_created",
]);

const filterValue = z.union([
  z.string(),
  z.number(),
  z.tuple([z.number(), z.number()]),
]);

export const CanonicalEventSchema = z.object({
  eventId: z.string().min(1),
  shopId: z.string().min(1),
  sessionId: z.string().min(1),
  customerId: z.string().optional(),

  type: z.enum(EVENT_TYPES),
  timestamp: z.string().datetime(),

  productId: z.string().optional(),
  variantId: z.string().optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  price: z.number().optional(),
  currency: z.string().optional(),
  searchTerm: z.string().optional(),
  filtersApplied: z.record(filterValue).optional(),
  scrollDepthPct: z.number().optional(),
  dwellMs: z.number().optional(),
  // proactive friction features (spec §4.1), widget-instrumented
  scrollThrash: z.number().optional(),
  cartIdleMs: z.number().optional(),
  couponFocusCount: z.number().optional(),
  surface: z.enum(["product", "cart", "checkout", "category", "search", "other"]).optional(),
  reason: z.string().optional(), // proactive trigger reason on proactive_shown rows

  cartValue: z.number().optional(),
  referrer: z.string().optional(),
  device: z.enum(["mobile", "desktop", "tablet"]).optional(),

  // widget_seed = fallback events from the widget (main page, carries storefront
  // cookies) for stores where the sandboxed pixel can't reach the App Proxy
  // (password-protected previews). Deduped against pixel events at ingest.
  source: z.enum(["web_pixel", "webhook", "chatbot", "widget_seed"]),
});

export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;

// The structured intent profile (spec §3.4). Lives in Postgres.
export interface IntentProfile {
  sessionId: string;
  customerId?: string;
  shopId: string;
  lastUpdated: string;
  eventsConsidered: number;
  computeTier: "hot" | "warm" | "cold";
  intentNarrative: string;
  decisionWindowDays?: number;
  decisionPhase?: "browsing" | "comparing" | "deciding";
  engagementStyle?: "skimmer" | "researcher";
  filterStrategy?: "price_first" | "category_first" | "brand_first" | "mixed";
  priceCeiling?: number;
  priceAbandonThreshold?: number;
  priceSensitivity?: "high" | "medium" | "low";
  categoriesViewed: Array<{ category: string; count: number }>;
  brandsViewed: Array<{ brand: string; count: number }>;
  attributePriorities?: string[];
  shippingTimeToleranceDays?: number;
  urgencyResponsive?: boolean;
  cartHesitation?: "low" | "medium" | "high";
  lastViewedProductId?: string;
  currentCategory?: string;
  recentSearches?: string[];
  cartValue?: number;
  contradictions?: Array<{ stated: string; revealed: string }>;
  conversionLikelihood?: number;        // 0..1 (LLM judgement)

  // deterministic + sequence-aware intent (session-modeling literature)
  conversionScore?: number;             // 0..1 (clickstream estimate, Requena-style)
  focusCategory?: string;               // recency-weighted dominant category
  priceTrajectory?: "ascending" | "descending" | "converging" | "stable";
  priceBand?: { low: number; high: number };
  // query/conversational intent (Sondhi taxonomy, slot-filling surveys)
  queryIntent?: "exploratory" | "targeted" | "comparing" | "deal_seeking";
  nextBestAction?: string;              // single most useful next move for this shopper

  // bookkeeping for the inline LLM cadence (intent-ondemand)
  llmEvents?: number;                   // eventsConsidered at the last LLM enrichment
}

// Pure event-derivation logic (no server deps) so it's unit-testable in isolation.
import type { CanonicalEvent, EventType } from "./events";

export interface LiveContext {
  lastViewedProductId?: string;
  currentCategory?: string;
  recentSearches: string[];
  cartValue?: number;
  device?: string;
}

// Fold one event into the live context. Returns a NEW object (no mutation).
export function applyToLiveContext(ctx: LiveContext, e: CanonicalEvent): LiveContext {
  const next: LiveContext = { ...ctx, recentSearches: [...ctx.recentSearches] };
  if (e.device) next.device = e.device;
  if (e.cartValue != null) next.cartValue = e.cartValue;
  // No absolute cartValue on the event → derive it from add/remove deltas so a
  // removal actually empties the cart in live context (was stuck at the last add).
  else if (e.type === "add_to_cart" && e.price != null) next.cartValue = (ctx.cartValue ?? 0) + e.price;
  else if (e.type === "remove_from_cart" && e.price != null) next.cartValue = Math.max(0, (ctx.cartValue ?? 0) - e.price);
  if (e.category) next.currentCategory = e.category;
  if (e.type === "product_view" && e.productId) next.lastViewedProductId = e.productId;
  if (e.type === "search" && e.searchTerm) {
    next.recentSearches = [e.searchTerm, ...next.recentSearches].slice(0, 10);
  }
  return next;
}

export const profileKeyFor = (
  e: Pick<CanonicalEvent, "customerId" | "sessionId">,
): string => e.customerId ?? e.sessionId;

// --- Webhook → CanonicalEvent mapping ---

type WH = { topic: string; shop: string; payload: any };

function cartValueOf(p: any): number | undefined {
  if (typeof p?.total_price === "string") return Number(p.total_price);
  if (Array.isArray(p?.line_items)) {
    return p.line_items.reduce(
      (sum: number, li: any) => sum + Number(li.price ?? 0) * Number(li.quantity ?? 1),
      0,
    );
  }
  return undefined;
}

// Widget stamps saleshq_sid onto the cart (POST /cart/update.js); Shopify copies
// cart attributes into order note_attributes at checkout. Without this, webhook
// orders get ord_${checkout_token} and never match bot events on sid_* sessions.
function sessionFromNoteAttributes(p: any): string | undefined {
  const attrs = p?.note_attributes;
  if (!Array.isArray(attrs)) return undefined;
  for (const a of attrs) {
    if (a?.name === "saleshq_sid" && a?.value) return String(a.value);
  }
  return undefined;
}

// Map a Shopify webhook to a CanonicalEvent, or null if it carries no user signal
// (e.g. product catalog updates — those just invalidate caches, slice 2+).
export function normalizeWebhook({ topic, shop, payload: p }: WH): CanonicalEvent | null {
  const timestamp = new Date(p?.updated_at ?? p?.created_at ?? Date.now()).toISOString();
  const base = {
    shopId: shop,
    customerId: p?.customer?.id ? String(p.customer.id) : undefined,
    timestamp,
    currency: p?.currency ?? p?.presentment_currency,
    source: "webhook" as const,
  };

  const make = (
    type: EventType,
    sessionId: string,
    extra: Partial<CanonicalEvent>,
  ): CanonicalEvent => ({
    ...base,
    type,
    sessionId,
    eventId: `${topic}:${sessionId}:${timestamp}`,
    ...extra,
  });

  switch (topic) {
    case "CARTS_CREATE":
    case "CARTS_UPDATE":
      return make("add_to_cart", `cart_${p.token ?? p.id}`, { cartValue: cartValueOf(p) });
    case "CHECKOUTS_CREATE":
    case "CHECKOUTS_UPDATE":
      return make("checkout_started", `chk_${p.token ?? p.id}`, { cartValue: cartValueOf(p) });
    case "ORDERS_CREATE":
    case "ORDERS_PAID":
      return make(
        "order_created",
        sessionFromNoteAttributes(p) ?? `ord_${p.checkout_token ?? p.id}`,
        { cartValue: cartValueOf(p) },
      );
    default:
      return null;
  }
}

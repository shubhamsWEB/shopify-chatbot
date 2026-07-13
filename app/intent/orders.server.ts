// Read-only order helpers for the storefront chatbot. Every query is scoped to
// a specific customer via `customer(id: ...)`, so a shopper can only ever see
// THEIR OWN orders — the customerId comes from Shopify's HMAC-signed
// `logged_in_customer_id` (see proxy.chat), never from the request body.
import { getProductDetails } from "./storefront.server";
import type { ProductCard, ProductDetail } from "./storefront.server";

type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export interface OrderSummary {
  name: string; // "#1024"
  processedAt: string | null;
  fulfillmentStatus: string; // FULFILLED | UNFULFILLED | PARTIALLY_FULFILLED | ...
  financialStatus: string; // PAID | REFUNDED | PENDING | ...
  total: string; // formatted with currency
  tracking: Array<{ number?: string; url?: string; company?: string }>;
  items: Array<{ title: string; quantity: number; productId?: string }>;
}

const gid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/Customer/${id}`);

const money = (amount?: string | null, currency?: string | null) => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency ?? ""}`.trim();
  }
};

const ORDERS_QUERY = `#graphql
  query CustomerOrders($id: ID!, $n: Int!) {
    customer(id: $id) {
      orders(first: $n, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          name
          processedAt
          displayFulfillmentStatus
          displayFinancialStatus
          currentTotalPriceSet { presentmentMoney { amount currencyCode } }
          fulfillments(first: 5) { trackingInfo(first: 3) { number url company } }
          lineItems(first: 25) { nodes { title quantity product { id } } }
        }
      }
    }
  }`;

interface RawOrder {
  name: string;
  processedAt: string | null;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  currentTotalPriceSet?: { presentmentMoney?: { amount?: string; currencyCode?: string } };
  fulfillments?: Array<{ trackingInfo?: Array<{ number?: string; url?: string; company?: string }> }>;
  lineItems?: { nodes?: Array<{ title: string; quantity: number; product?: { id?: string } }> };
}

/** Recent orders for a customer, newest first. Returns null when the LOOKUP
 *  FAILED (dead token, ACCESS_DENIED, network) — callers must not present
 *  that as "no orders". [] means the query succeeded and there are none. */
export async function getCustomerOrders(admin: AdminGraphql, customerId: string, n = 5): Promise<OrderSummary[] | null> {
  try {
    const resp = await admin.graphql(ORDERS_QUERY, { variables: { id: gid(customerId), n: Math.min(n, 10) } });
    const body = (await resp.json()) as {
      data?: { customer?: { orders?: { nodes?: RawOrder[] } } };
      errors?: unknown;
    };
    // GraphQL-level failures come back 200 with an errors array — a dead
    // session token or protected-customer-data denial lands here, NOT in the
    // catch. Treat them as lookup failure, never as an empty order history.
    if (body.errors || body.data?.customer === undefined) {
      console.error("[orders] CustomerOrders errored:", JSON.stringify(body.errors ?? body).slice(0, 500));
      return null;
    }
    const nodes = body.data.customer?.orders?.nodes ?? [];
    return nodes.map((o) => ({
      name: o.name,
      processedAt: o.processedAt,
      fulfillmentStatus: o.displayFulfillmentStatus,
      financialStatus: o.displayFinancialStatus,
      total: money(o.currentTotalPriceSet?.presentmentMoney?.amount, o.currentTotalPriceSet?.presentmentMoney?.currencyCode),
      tracking: (o.fulfillments ?? []).flatMap((f) => f.trackingInfo ?? []),
      items: (o.lineItems?.nodes ?? []).map((li) => ({ title: li.title, quantity: li.quantity, productId: li.product?.id })),
    }));
  } catch (err) {
    console.error("[orders] getCustomerOrders failed:", (err as Error).message);
    return null;
  }
}

const normalizeName = (s: string) => s.replace(/[^0-9]/g, "");

/** One order's status — the named order, else the most recent. null = none
 *  or lookup failed (check getCustomerOrders directly to distinguish). */
export async function getOrderStatus(admin: AdminGraphql, customerId: string, orderName?: string): Promise<OrderSummary | null> {
  const orders = await getCustomerOrders(admin, customerId, 10);
  if (!orders || orders.length === 0) return null;
  if (orderName) {
    const want = normalizeName(orderName);
    const hit = orders.find((o) => normalizeName(o.name) === want);
    if (hit) return hit;
  }
  return orders[0];
}

/** Product cards for a past order's items, so the shopper can re-add to cart. */
export async function getReorderCards(admin: AdminGraphql, shop: string, customerId: string, orderName?: string): Promise<ProductCard[]> {
  const order = await getOrderStatus(admin, customerId, orderName);
  if (!order) return [];
  const ids = [...new Set(order.items.map((i) => i.productId).filter((x): x is string => !!x))].slice(0, 6);
  const cards = await Promise.all(ids.map((id) => getProductDetails(shop, id).catch(() => null)));
  // ProductDetail is a superset of ProductCard → safe to surface as cards.
  return cards.filter((c): c is ProductDetail => !!c);
}

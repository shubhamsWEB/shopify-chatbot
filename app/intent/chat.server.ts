// Conversational layer (spec §7). A plain agent ↔ tools loop over the Anthropic
// SDK — was a LangGraph StateGraph, but the graph had exactly two nodes and one
// edge, so the framework bought nothing.
import Anthropic from "@anthropic-ai/sdk";
import client, { CHAT_MODEL, HAIKU } from "./claude.server";
import { searchProducts, getProductDetails, compareProducts, getCategories } from "./storefront.server";
import type { ProductCard, ComparisonMatrix } from "./storefront.server";
import { readProfile } from "./profile.server";
import { getSession } from "./cache.server";
import { ensureProfile } from "./intent-ondemand.server";
import { suggestFollowups } from "./followups";
import { getSettings } from "./settings.server";
import { recordUsage } from "./usage.server";
import { rankByIntent } from "./ranking";
import { similarIntentProducts } from "./vectors.server";
import { getCustomerOrders, getOrderStatus, getReorderCards } from "./orders.server";
import type { IntentProfile } from "./events";

type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_products",
    description: "Search/recommend in-store products by query, category, price band, attributes, stock.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        priceMin: { type: "number" },
        priceMax: { type: "number" },
        attributes: { type: "array", items: { type: "string" } },
        inStockOnly: { type: "boolean" },
        excludeProductIds: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_product_details",
    description: "Full details for one product: description, variants, price(s), stock, attributes.",
    input_schema: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] },
  },
  {
    name: "compare_products",
    description: "Compare 2-4 in-store products into an attribute matrix.",
    input_schema: {
      type: "object",
      properties: { productIds: { type: "array", items: { type: "string" } } },
      required: ["productIds"],
    },
  },
  {
    name: "get_categories",
    description:
      "List the store's product categories (collections) so an undecided shopper can pick a direction. Use for 'just browsing' / exploring shoppers instead of pushing one specific product.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_to_cart",
    description:
      "Add a product to the shopper's cart when they ask to buy/add it. Pass productId. If the product has multiple variants (size/color) and the shopper hasn't picked one, this returns needsVariant with the options — ask which they want, then call again with variantId. quantity defaults to 1.",
    input_schema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        variantId: { type: "string" },
        quantity: { type: "number" },
      },
      required: ["productId"],
    },
  },
  {
    name: "get_my_orders",
    description:
      "List the SIGNED-IN shopper's recent orders (name, date, fulfillment/payment status, total, items). Only works for a logged-in customer.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "track_order",
    description:
      "Get status + shipment tracking for the signed-in shopper's order. Pass orderName (e.g. \"#1024\") to track a specific one, or omit for their most recent order. Logged-in customers only.",
    input_schema: { type: "object", properties: { orderName: { type: "string" } } },
  },
  {
    name: "reorder",
    description:
      "Fetch the products from one of the signed-in shopper's past orders so they can add them to cart again. Pass orderName, or omit for the most recent. Logged-in customers only.",
    input_schema: { type: "object", properties: { orderName: { type: "string" } } },
  },
];

// STATIC system block: instructions + brand only — byte-stable across a shop's
// requests so the prompt-cache prefix (tools → this block) survives every turn.
// The volatile per-shopper context (profile, live) goes in a SEPARATE block
// AFTER the cache breakpoint (see runChat). Never interpolate anything
// per-session/per-turn into this string.
const STATIC_SYSTEM = (brand: string) =>
  `You are a helpful in-store shopping assistant for a single Shopify store. You ONLY know and sell this store's catalog.
${brand ? `\nABOUT THIS BRAND (merchant-provided — ground your tone, claims, and recommendations in this):\n${brand}\n` : ""}

GROUNDING:
- Base every product fact (price, stock, variant, attribute) on a tool result. To state facts about a product mentioned earlier in the conversation, call the tools AGAIN to get current data — don't rely on memory.
- Never invent products. If a tool genuinely returns nothing for the exact ask, say so in one line.
- Do NOT tell the user you fabricated or "hallucinated" data, and never apologize for products you showed earlier — those came from real tool results. If you're unsure, just re-run the tool. Never undermine the shopper's trust.
- NEVER remark that the catalog seems inconsistent, surprising, or "not what you'd expect" from the brand — merchants stock what they stock. Present the products confidently and plainly; if results span categories, prefer the ones matching the brand description and the shopper's context.

STAY IN-CATALOG, SHOW REAL PRODUCTS:
- Only discuss products this store actually carries. You don't know the catalog up front — discover it with search_products.
- If the shopper asks for something and the search returns nothing (or it's clearly not something this store sells), DON'T just offer to broaden or keep asking. In ONE line acknowledge it's not available, then call search_products with a broad/empty query to retrieve the store's ACTUAL products and show those as "here's what we do carry" — steer them to the real catalog.
- Do not interrogate. Ask AT MOST ONE short clarifying question, and only if you truly can't search yet. If you can search, SEARCH and show options instead of asking more.
- Do NOT hide relevant products that are out of stock: include them in results and say plainly they're out of stock right now (their card shows an "Out of stock" badge), then point to in-stock alternatives. Only pass inStockOnly when the shopper explicitly wants something ready to ship, or in proactive nudges.
- Follow the conversation: honor earlier constraints (budget, recipient) but if the shopper clearly changes direction (new category/product), follow their LATEST intent.

ADDING TO CART:
- When the shopper asks to buy, add, or "get me" a product you've been discussing, call add_to_cart with that product's productId. Add the RIGHT product (the one in context), not a random match.
- If add_to_cart returns needsVariant, the product has options (size, color, etc). Ask ONE short question listing the choices, then call add_to_cart again with the chosen variantId. Never guess a variant.
- If it returns outOfStock or variantUnavailable, say so in one line and offer an in-stock alternative via search_products.
- On success (ok:true) confirm in ONE short line what you added (name + option if any). The cart updates on their screen automatically, so don't tell them to click anything.

JUST BROWSING / EXPLORING:
- If the shopper is clearly undecided or "just looking" and hasn't named a product or category, DON'T push one specific item. Call get_categories and invite them to pick a direction. The categories are shown as tappable options, so keep your line to one warm sentence and do NOT list a specific product.

PERSONALIZE & COMPARE:
- Use the intent profile to personalize: price ceiling, attribute priorities, category/brand affinity, decision style.
- Compare only within THIS store. Never point the shopper elsewhere.

ORDERS & ACCOUNT HELP:
- You can help SIGNED-IN shoppers with their own orders: get_my_orders (their recent orders), track_order (status + shipment tracking), and reorder (re-add a past order's items to cart).
- These only work when the shopper is logged in. If a tool returns needsLogin, tell them in ONE friendly line to sign into their account to see their orders — then continue helping with shopping.
- When you track an order, give the plain status (e.g. "Shipped — arriving soon") and, if a tracking number or link is present, share it. Never invent a tracking number or delivery date; only state what the tool returned.
- reorder returns product CARDS (rendered below your message) — introduce them in one line ("Here's what you ordered last time:") and don't re-list them in prose. You cannot cancel, refund, or change orders — for those, point the shopper to the order-status page or the store's support.

TONE — talk like a warm, real human shop associate, not a bot:
- Write the way a friendly person actually talks. Use contractions (you'll, it's, I've, here's) and natural, everyday words.
- DO NOT use em-dashes or en-dashes ("—", "–") at all. They read as robotic. Use a comma, a period, "so", "and", or just two short sentences instead. Never join clauses with a dash.
- Skip stiff, corporate, or salesy filler. Keep it friendly and genuine, like you're helping a friend pick something out.
- Vary your phrasing; don't fall into a formula. Contractions and short natural sentences over long dashed-together ones.

RESPONSE STYLE (keep it clean and scannable):
- Products you return from search_products are rendered as visual CARDS directly below your message. NEVER re-list them in your text — no product names, prices, or image links in prose. Just a one-line intro (e.g. "Here are our snowboards, all in stock:") and one short next step.
- EXCEPTION — comparisons: when you call compare_products, DO render a compact markdown table (that's how the shopper sees the comparison), then ONE short takeaway line. Build the rows from MEANINGFUL FEATURE DIFFERENCES mined from the products' descriptions (materials, design, who it's for, key benefits, sizing/support) — not just price/stock/color. Drop any row where all products are identical (e.g. same brand). 3-6 feature rows, then Price and In Stock last. If a feature isn't stated in the product data, write "Not specified" — NEVER guess or use hedges like "likely".
- Product DETAIL asks: after get_product_details, present the concrete facts as a compact bullet list — real features mined from the description, variant/size/color options, price, stock. Never pad: no "Tagline" rows, no marketing copy restated as a spec. If the stored description is thin, say in ONE line that detailed specs aren't listed for this item, give what IS known, and offer the most useful next step (compare it, see similar, or ask a specific question).
- Currency: always use the store's currency exactly as tool results show it (e.g. INR/₹). NEVER quote prices in dollars or any other currency unless the tool results do.
- Lead with the key point in the first line. No filler openers ("Great!", "Sure!", "How fun!"). No markdown images.
- Keep prose to 1-2 short sentences. One clear next step, not a menu of options.`;

// Volatile per-shopper context — separate system block, rendered AFTER the
// cached static block so it never invalidates the shared prefix.
const DYNAMIC_SYSTEM = (profile: IntentProfile | null, live: unknown) =>
  `SHOPPER INTENT PROFILE:
${profile ? JSON.stringify(profile) : "(none yet — first interaction)"}

LIVE CONTEXT (what they're doing right now):
${JSON.stringify(live ?? {})}`;

// Client action: the widget performs the cart add (Ajax /cart/add.js) and
// refreshes the storefront cart UI live, so the shopper sees it without clicking.
export interface CartAdd {
  productId: string;
  variantId: number; // numeric Shopify variant id for /cart/add.js
  title: string;
  variantTitle?: string;
  quantity: number;
  handle?: string;
  imageUrl?: string;
  price?: number;
  currency?: string;
}

export interface ChatResult {
  response: string;
  products: ProductCard[];
  comparison?: ComparisonMatrix;
  followups?: string[];
  cartAdd?: CartAdd; // present when the bot added something to the cart this turn
}

// Proactive trigger → an internal user message (spec §7.5). The widget pops up
// on a client event (e.g. product click) with no typed message.
function triggerMessage(t: { type: string; productId?: string }): string {
  if (t.type === "product_view" && t.productId) {
    return `I'm currently viewing product ${t.productId}. In one or two sentences highlight its key benefits, then use compare_products to compare it against 2 similar in-store products. Keep it brief and helpful.`;
  }
  return "Greet me and offer help based on what I'm browsing.";
}

export async function runChat(args: {
  shopId: string;
  sessionId: string;
  customerId?: string; // signed logged_in_customer_id when the shopper is logged in
  admin?: AdminGraphql; // shop's Admin API client (from the app proxy) — order lookups
  message?: string;
  trigger?: { type: string; productId?: string };
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  // When present, the final answer is streamed token-by-token: onText for each
  // delta, onReset to discard interim text before a tool-calling turn continues.
  stream?: { onText: (t: string) => void; onReset: () => void };
}): Promise<ChatResult> {
  const message = args.message ?? triggerMessage(args.trigger ?? { type: "greet" });
  // Intent is keyed by customer when we know them (cross-session/device), else
  // by session — recentEvents matches either, so a logged-in shopper's profile
  // aggregates all their events. (Completes the deferred identity mapping.)
  const profileKey = args.customerId ?? args.sessionId;
  await ensureProfile(args.shopId, profileKey, args.sessionId).catch(() => {}); // realtime intent refresh (deterministic + inline LLM when due)
  const [profile, session, settings] = await Promise.all([
    readProfile(args.shopId, profileKey).catch(() => null),
    getSession(args.shopId, args.sessionId).catch(() => null),
    getSettings(args.shopId),
  ]);
  const liveContext = session?.liveContext;
  // Prompt caching (prefix = tools → system blocks → messages): the static
  // instructions+brand block carries the breakpoint; profile/live go in a
  // second, uncached block so per-turn changes don't invalidate the prefix.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: STATIC_SYSTEM(settings.brandDescription), cache_control: { type: "ephemeral" } },
    { type: "text", text: DYNAMIC_SYSTEM(profile, liveContext) },
  ];

  // Semantic neighbors: products favored by similar-intent shoppers (pgvector).
  // Empty until narratives are embedded; degrades gracefully.
  const boostIds = new Set(await similarIntentProducts(args.shopId, profileKey).catch(() => []));

  // Captured tool output = the grounded source for the widget.
  let lastProducts: ProductCard[] = [];
  let lastComparison: ComparisonMatrix | undefined;
  let lastCategories: string[] = []; // exploring nudge: offer these as tappable directions
  let cartAdd: CartAdd | undefined;   // add_to_cart action the widget executes
  // Every product surfaced by any tool call this turn — used to reconcile the
  // cards with the products the model actually NAMES in its final reply, so the
  // shopper never sees cards that don't match the text.
  const pool = new Map<string, ProductCard>();
  const remember = (cards: ProductCard[]) => cards.forEach((c) => { if (c?.productId) pool.set(c.productId, c); });

  async function execTool(name: string, rawInput: unknown): Promise<unknown> {
    const input = rawInput as {
      excludeProductIds?: string[];
      productId?: string;
      productIds?: string[];
    } & Record<string, unknown>;
    if (name === "search_products") {
      const exclude = input.excludeProductIds ?? [];
      if (liveContext?.lastViewedProductId) exclude.push(liveContext.lastViewedProductId);
      const cards = await searchProducts(args.shopId, { ...input, excludeProductIds: exclude });
      // Rank by the shopper's intent (price-fit, attributes, stock) so the BEST
      // matches surface first — not just Shopify's default order.
      lastProducts = rankByIntent(cards, {
        priceCeiling: profile?.priceCeiling,
        priceBand: profile?.priceBand,
        attributePriorities: profile?.attributePriorities,
        boostIds,
      });
      remember(lastProducts);
      return lastProducts;
    }
    if (name === "get_product_details") {
      const detail = await getProductDetails(args.shopId, input.productId ?? "");
      if (detail) remember([detail as unknown as ProductCard]);
      return detail;
    }
    if (name === "compare_products") {
      lastComparison = await compareProducts(args.shopId, input.productIds ?? []);
      lastProducts = lastComparison.products;
      remember(lastProducts);
      return lastComparison;
    }
    if (name === "get_categories") {
      const cats = await getCategories(args.shopId);
      lastCategories = cats.map((c) => c.title);
      return cats.length ? cats : { message: "No categories configured; use search_products instead." };
    }
    if (name === "add_to_cart") {
      const detail = await getProductDetails(args.shopId, input.productId ?? "");
      if (!detail) return { error: "Product not found." };
      remember([detail as unknown as ProductCard]);
      if (!detail.inStock) return { error: "outOfStock", title: detail.title, message: `${detail.title} is out of stock right now.` };
      const variants = detail.variants ?? [];
      const wantVar = typeof input.variantId === "string" ? input.variantId : undefined;
      let chosen = wantVar
        ? variants.find((v) => v.id === wantVar || String(v.id).split("/").pop() === wantVar)
        : variants.length === 1 ? variants[0] : undefined;
      // Multi-variant and none picked → ask the shopper.
      if (!chosen && variants.length > 1) {
        return { needsVariant: true, title: detail.title, variants: variants.map((v) => ({ id: v.id, title: v.title, price: v.price, available: v.available })) };
      }
      chosen = chosen ?? variants[0];
      const variantGid = chosen?.id ?? detail.variantId;
      if (!variantGid) return { error: "No purchasable variant found for this product." };
      if (chosen && chosen.available === false) return { error: "variantUnavailable", title: detail.title, message: `That option of ${detail.title} isn't available right now.` };
      const numericId = Number(String(variantGid).split("/").pop());
      const qty = typeof input.quantity === "number" && input.quantity > 0 ? Math.min(Math.floor(input.quantity), 10) : 1;
      cartAdd = {
        productId: detail.productId, variantId: numericId, title: detail.title,
        variantTitle: chosen?.title, quantity: qty, handle: detail.handle,
        imageUrl: detail.imageUrl, price: chosen?.price ?? detail.price, currency: detail.currency,
      };
      return { ok: true, added: detail.title, variant: chosen?.title ?? "default", quantity: qty };
    }
    // Order tools — logged-in customers only. customerId comes from the signed
    // proxy request, so a shopper can only ever see their own orders.
    if (name === "get_my_orders" || name === "track_order" || name === "reorder") {
      // Merchant privacy switch: order/account help is off for this store.
      if (!settings.config.customerDataEnabled) {
        return { disabled: true, message: "Order lookup isn't available in this store's assistant. Help the shopper with products instead, and point them to the store's account page or support for order questions." };
      }
      if (!args.customerId || !args.admin) {
        return { needsLogin: true, message: "The shopper isn't signed in. Ask them to log into their account to view or track orders." };
      }
      const orderName = typeof input.orderName === "string" ? input.orderName : undefined;
      if (name === "get_my_orders") {
        const orders = await getCustomerOrders(args.admin, args.customerId, 5);
        return orders.length ? orders : { message: "No orders found on this account yet." };
      }
      if (name === "track_order") {
        const order = await getOrderStatus(args.admin, args.customerId, orderName);
        return order ?? { message: orderName ? `No order matching ${orderName} on this account.` : "No orders found on this account yet." };
      }
      // reorder → surface the past order's products as cards to re-add to cart.
      const cards = await getReorderCards(args.admin, args.shopId, args.customerId, orderName);
      if (cards.length) {
        lastProducts = cards;
        remember(cards);
      }
      return cards.length ? cards : { message: "Couldn't find items to reorder from that order." };
    }
    throw new Error(`unknown tool ${name}`);
  }

  // Cache breakpoint on the CURRENT user message: loop call 2+ (after tool
  // results) re-reads everything up to here at ~0.1x price, and the next chat
  // turn extends the same prefix. (Breakpoints used: static system + this = 2.)
  const messages: Anthropic.MessageParam[] = [
    ...(args.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: message, cache_control: { type: "ephemeral" as const } }],
    },
  ];

  // Agent ↔ tools loop: call the model, run any requested tools, feed results
  // back, repeat until it answers in text. MAX_TURNS bounds runaway loops.
  // Cost-optimized two-phase loop: a cheap WORKER model (Haiku) drives tool
  // selection/search, then the FINAL model (Sonnet) composes the user-facing
  // answer — so shopper-visible prose stays Sonnet quality while the ~2-3
  // tool-selection calls run ~3x cheaper. Set TOOL_LOOP_MODEL to override the
  // worker (e.g. =claude-sonnet-5 to disable the split and use Sonnet throughout).
  // eslint-disable-next-line no-undef
  const WORKER = process.env.TOOL_LOOP_MODEL || HAIKU;
  const MAX_TURNS = 8;
  let content: Anthropic.ContentBlock[] = [];
  let composing = WORKER === CHAT_MODEL; // no split when worker == final model
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const model = composing ? CHAT_MODEL : WORKER;
    // Only the final Sonnet compose streams to the shopper; worker turns are
    // internal (tool selection), so the client keeps its typing animation until
    // the compose phase begins.
    const streamThis = !!args.stream && composing;
    let res: Anthropic.Message;
    if (streamThis) {
      const s = client.messages.stream({ model, max_tokens: 1024, system, tools: TOOLS, messages });
      s.on("text", (t) => args.stream!.onText(t));
      res = await s.finalMessage();
    } else {
      res = await client.messages.create({ model, max_tokens: 1024, system, tools: TOOLS, messages });
    }
    recordUsage(args.shopId, model, res.usage);
    content = res.content;
    messages.push({ role: "assistant", content });

    const toolUses = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      // Worker produced a text answer → discard it and recompose on Sonnet
      // (with tools still available, so Sonnet can search more if the worker
      // under-fetched). Keeps final-answer quality identical to all-Sonnet.
      if (!composing) {
        messages.pop();
        composing = true;
        continue;
      }
      break; // final Sonnet answer is done
    }
    if (streamThis) args.stream!.onReset(); // Sonnet called a tool mid-stream; drop interim text

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of toolUses) {
      try {
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(await execTool(b.name, b.input)) });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: (err as Error).message });
      }
    }
    messages.push({ role: "user", content: results });
    // Worker (Haiku) picked the tools; hand off to Sonnet to compose from the
    // results (it can still call more tools). Keeps the call count identical to
    // all-Sonnet (Haiku select → Sonnet compose) — cheaper, no extra latency.
    composing = true;
  }

  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const response = text || "How can I help you today?";

  // Reconcile cards with the reply: any product NAMED in the final text (matched
  // by title) is shown first — so a card never contradicts the prose — then the
  // rest of the last search fills in. A comparison always shows exactly its rows.
  let products = lastProducts;
  if (!lastComparison && pool.size) {
    const hay = response.toLowerCase();
    const named: ProductCard[] = [];
    for (const c of pool.values()) {
      const title = (c.title ?? "").toLowerCase().trim();
      if (!title) continue;
      // Match full title, or title minus a leading brand word (models often drop it).
      const noBrand = title.replace(/^\S+\s+/, "");
      if (hay.includes(title) || (noBrand.length > 6 && hay.includes(noBrand))) named.push(c);
    }
    if (named.length) {
      const seen = new Set<string>();
      products = [...named, ...lastProducts]
        .filter((c) => c?.productId && !seen.has(c.productId) && seen.add(c.productId))
        .slice(0, 8);
    }
  }

  // Intent-clarifying quick replies (don't block on failure).
  // Store currency: from this turn's tool results, else the session's events
  // (pixel sends the shop currency) — keeps follow-up chips off imaginary dollars.
  const currency =
    products[0]?.currency ??
    session?.recentEvents?.map((e) => e.currency).find(Boolean);
  // Exploring nudge: offer the store's categories as tappable directions instead
  // of LLM follow-ups (and no product cards) — let the shopper pick a lane.
  const followups =
    /^\s*SKIP\b/i.test(response)
      ? []
      : lastCategories.length && products.length === 0
        ? lastCategories.slice(0, 5)
        : await suggestFollowups({ userMessage: message, assistantResponse: response, profile, currency, shop: args.shopId });

  return { response, products, comparison: lastComparison, followups, cartAdd };
}

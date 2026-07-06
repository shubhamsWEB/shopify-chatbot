import { register } from "@shopify/web-pixels-extension";

// Subscribes to standard storefront events and POSTs canonical events (spec §5)
// to our ingestion endpoint. Custom DOM events (filter/scroll/dwell) are emitted
// from the storefront and forwarded too — see chat-widget instrumentation (slice 1+).
register(({ analytics, browser, init }) => {
  // The pixel runs in a sandboxed worker whose location is NOT the storefront,
  // so build the ingest URL from the shop's permanent domain. Posting to the
  // shop's /apps/saleshq/* path routes through the App Proxy: Shopify HMAC-signs
  // it with the real shop, the server derives shopId (can't be spoofed).
  const shopId = init?.data?.shop?.myshopifyDomain;
  if (!shopId) return;
  const ingestUrl = `https://${shopId}/apps/saleshq/ingest`;

  // Stable per-browser session id in a FIRST-PARTY COOKIE so the chat widget
  // (running on the main page, outside this sandbox) reads the same id and the
  // chat can see this session's browsing context. Sliding TTL handled by Redis.
  async function getSessionId() {
    const NAME = "saleshq_sid";
    let sid = await browser.cookie.get(NAME);
    if (!sid) {
      sid = "sid_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      await browser.cookie.set(`${NAME}=${sid}; path=/; max-age=2592000; SameSite=Lax`);
    }
    return sid;
  }

  // Batched delivery: one request per ~4s (or 8 events) instead of one per
  // event. Events keep their creation timestamps so intent timing is exact.
  // High-signal events (cart/checkout/order) flush immediately — the proactive
  // engine reacts to those, and checkout redirects can kill the page.
  const HIGH_SIGNAL = new Set(["add_to_cart", "remove_from_cart", "checkout_started", "order_created", "exit_intent"]);
  let queue = [];
  let timer = null;

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    try {
      // keepalive so batches survive page unload (checkout redirects etc.)
      fetch(ingestUrl, {
        method: "POST",
        // text/plain → "simple" CORS request, no preflight; server JSON-parses the body
        headers: { "Content-Type": "text/plain" },
        keepalive: true,
        body: JSON.stringify({ events: batch }),
      }).catch(() => {});
    } catch (_) {
      // pixel must never throw into the storefront
    }
  }

  // Checkout runs on checkout.shopify.com — storefront cookie is invisible there.
  // Read saleshq_sid from cart attributes (stamped by the widget on the storefront).
  function sidFromCheckout(checkout) {
    if (!checkout) return null;
    const attrs = checkout.attributes || checkout.customAttributes || [];
    for (const a of attrs) {
      const key = a.key ?? a.name;
      if (key === "saleshq_sid" && a.value) return String(a.value);
    }
    return null;
  }

  async function send(partial, sessionOverride) {
    try {
      const sessionId = sessionOverride ?? (await getSessionId());
      queue.push({
        shopId,
        sessionId,
        customerId: init?.data?.customer?.id ? String(init.data.customer.id) : undefined,
        currency: init?.data?.shop?.paymentSettings?.currencyCode,
        ...partial,
      });
      if (partial.type && HIGH_SIGNAL.has(partial.type)) { flush(); return; }
      if (queue.length >= 8) { flush(); return; }
      if (!timer) timer = setTimeout(flush, 4000);
    } catch (_) {
      // pixel must never throw into the storefront
    }
  }

  const base = (e) => ({ eventId: e.id, timestamp: e.timestamp });

  analytics.subscribe("page_viewed", (e) =>
    send({ ...base(e), type: "page_view" }),
  );

  analytics.subscribe("product_viewed", (e) => {
    const v = e.data?.productVariant;
    send({
      ...base(e),
      type: "product_view",
      productId: v?.product?.id,
      variantId: v?.id,
      category: v?.product?.type,
      brand: v?.product?.vendor,
      price: v?.price?.amount != null ? Number(v.price.amount) : undefined,
    });
  });

  analytics.subscribe("collection_viewed", (e) =>
    send({ ...base(e), type: "collection_view", category: e.data?.collection?.title }),
  );

  analytics.subscribe("search_submitted", (e) =>
    send({ ...base(e), type: "search", searchTerm: e.data?.searchResult?.query }),
  );

  analytics.subscribe("product_added_to_cart", (e) => {
    const li = e.data?.cartLine;
    send({
      ...base(e),
      type: "add_to_cart",
      productId: li?.merchandise?.product?.id,
      variantId: li?.merchandise?.id,
      price: li?.merchandise?.price?.amount != null ? Number(li.merchandise.price.amount) : undefined,
      cartValue: li?.cost?.totalAmount?.amount != null ? Number(li.cost.totalAmount.amount) : undefined,
    });
  });

  analytics.subscribe("product_removed_from_cart", (e) => {
    const li = e.data?.cartLine;
    send({
      ...base(e),
      type: "remove_from_cart",
      productId: li?.merchandise?.product?.id,
      variantId: li?.merchandise?.id,
      price: li?.merchandise?.price?.amount != null ? Number(li.merchandise.price.amount) : undefined,
    });
  });

  analytics.subscribe("checkout_started", (e) => {
    const sid = sidFromCheckout(e.data?.checkout);
    send(
      {
        ...base(e),
        type: "checkout_started",
        cartValue: e.data?.checkout?.totalPrice?.amount != null ? Number(e.data.checkout.totalPrice.amount) : undefined,
      },
      sid,
    );
  });

  analytics.subscribe("checkout_completed", (e) => {
    const sid = sidFromCheckout(e.data?.checkout);
    send(
      {
        ...base(e),
        type: "order_created",
        cartValue: e.data?.checkout?.totalPrice?.amount != null ? Number(e.data.checkout.totalPrice.amount) : undefined,
      },
      sid,
    );
  });
});

(function () {
  if (window.__SALESHQ_CHAT__) return;
  window.__SALESHQ_CHAT__ = true;

  const STORAGE_KEY = "saleshq_chat_state";

  // Load persisted state from sessionStorage
  function loadState() {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          open: parsed.open || false,
          history: parsed.history || [],
          lastMessageAt: parsed.lastMessageAt || 0
        };
      }
    } catch (e) {
      // Ignore parse errors
    }
    return { open: false, history: [], lastMessageAt: 0 };
  }

  // Save state to sessionStorage
  function saveState() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // Ignore storage errors
    }
  }

  const state = loadState();

  /* Backend config injected by app-embed.liquid */
  const CONFIG = window.__SALESHQ_CONFIG__ || {};
  // App Proxy path — same-origin, Shopify HMAC-signs the request with the real
  // shop, so the server derives shopId and the client can't spoof it.
  const API_BASE = "/apps/saleshq";
  const SHOP_ID = CONFIG.shopId || location.host; // legacy field; server ignores it

  /* Theme defaults: the embed enables auto-match by default. Prefer explicit
     theme button/accent tokens, then visible theme buttons, then the manual
     setting when auto-match is off. */
  const DEFAULT_PRIMARY = "#1a1a1a";
  function cssColor(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?$/.test(raw)) return `rgb(${raw})`;
    return raw;
  }
  function colorToRgb(value) {
    const probe = document.createElement("span");
    probe.style.color = "";
    probe.style.color = cssColor(value);
    if (!probe.style.color) return null;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.2)) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  }
  function rgbToHex(rgb) {
    return "#" + [rgb.r, rgb.g, rgb.b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("");
  }
  function luminance(rgb) {
    const linear = [rgb.r, rgb.g, rgb.b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }
  function usablePrimary(value) {
    const rgb = colorToRgb(value);
    if (!rgb) return "";
    if (luminance(rgb) > 0.92) return "";
    return rgbToHex(rgb);
  }
  function adjustColor(hex, amount) {
    const rgb = colorToRgb(hex) || colorToRgb(DEFAULT_PRIMARY);
    const adjusted = {
      r: rgb.r + (amount < 0 ? rgb.r : 255 - rgb.r) * amount,
      g: rgb.g + (amount < 0 ? rgb.g : 255 - rgb.g) * amount,
      b: rgb.b + (amount < 0 ? rgb.b : 255 - rgb.b) * amount,
    };
    return rgbToHex(adjusted);
  }
  function resolveTheme() {
    const manual = usablePrimary(CONFIG.primaryColor) || DEFAULT_PRIMARY;
    // A manual color the merchant actually CHANGED from the default wins even
    // with auto-match on — picking a color in the editor is an explicit intent
    // signal; requiring them to also untick auto-match read as "not working"
    // (live bug report, 2026-07-08). Auto-match keeps handling the font either way.
    const manualChosen = manual.toLowerCase() !== DEFAULT_PRIMARY;
    if (CONFIG.autoMatch === false || manualChosen) return { primary: manual, primaryHover: adjustColor(manual, -0.18), onPrimary: luminance(colorToRgb(manual)) > 0.55 ? "#111827" : "#fff" };

    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const vars = [
      "--color-button",
      "--color-primary",
      "--color-accent",
      "--color-link",
      "--color-base-accent-1",
      "--color-foreground",
      "--color-base-text",
    ];
    for (const name of vars) {
      const picked = usablePrimary(root.getPropertyValue(name) || body.getPropertyValue(name));
      if (picked) return { primary: picked, primaryHover: adjustColor(picked, -0.18), onPrimary: luminance(colorToRgb(picked)) > 0.55 ? "#111827" : "#fff" };
    }

    const selectors = [
      "button[name='add']",
      ".product-form__submit",
      ".shopify-payment-button__button",
      "button[type='submit']",
      "a.button",
      ".button",
      ".btn",
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const styles = getComputedStyle(el);
      const picked = usablePrimary(styles.backgroundColor) || usablePrimary(styles.borderColor) || usablePrimary(styles.color);
      if (picked) return { primary: picked, primaryHover: adjustColor(picked, -0.18), onPrimary: luminance(colorToRgb(picked)) > 0.55 ? "#111827" : "#fff" };
    }

    return { primary: manual, primaryHover: adjustColor(manual, -0.18), onPrimary: luminance(colorToRgb(manual)) > 0.55 ? "#111827" : "#fff" };
  }
  const THEME = resolveTheme();

  /* Consent: honor the Shopify Customer Privacy API. When analytics consent is
     not granted we keep the chat working but DON'T persist a tracking cookie,
     run proactive popups, or emit behavioral events. */
  function analyticsAllowed() {
    try {
      const cp = window.Shopify && window.Shopify.customerPrivacy;
      if (cp && typeof cp.analyticsProcessingAllowed === "function") {
        return cp.analyticsProcessingAllowed();
      }
    } catch (e) { /* ignore */ }
    return true; // API absent (store hasn't configured consent) → behave as before
  }

  /* Session id — shared with the Web Pixel via a first-party cookie (only when
     consent allows; otherwise an in-memory id that isn't persisted). */
  function getSessionId() {
    const m = document.cookie.match(/(?:^|;\s*)saleshq_sid=([^;]+)/);
    if (m) return m[1];
    const sid = "sid_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (analyticsAllowed()) {
      document.cookie = `saleshq_sid=${sid}; path=/; max-age=2592000; SameSite=Lax`;
    }
    return sid;
  }
  const SESSION_ID = getSessionId();

  /* Stamp session onto the cart so it survives checkout (checkout.shopify.com
     can't read the storefront cookie) and lands in order note_attributes. */
  function syncSessionToCart() {
    if (!analyticsAllowed()) return;
    fetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: { saleshq_sid: SESSION_ID } }),
    }).catch(function () {});
  }
  syncSessionToCart();

  /* Event batching: one request per ~4s instead of one per event — cuts server
     invocations ~10x at scale. Events keep their creation timestamps, so the
     intent engine's timing math is unaffected by delivery delay. flushEvents()
     runs before every proactive/chat call (no stale-session race) and with
     keepalive on page exit (nothing lost to navigation). */
  let eventQueue = [];
  let flushTimer = null;
  function queueEvent(ev) {
    eventQueue.push(ev);
    if (eventQueue.length >= 8) { flushEvents(); return; }
    if (!flushTimer) flushTimer = setTimeout(() => flushEvents(), 4000);
  }
  function flushEvents(useKeepalive) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!eventQueue.length) return Promise.resolve();
    const batch = eventQueue;
    eventQueue = [];
    try {
      return fetch(`${API_BASE}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        keepalive: !!useKeepalive || batch.length <= 8,
        body: JSON.stringify({ events: batch })
      }).catch(() => {});
    } catch (e) { return Promise.resolve(); }
  }
  window.addEventListener("pagehide", () => flushEvents(true));

  /* Feedback loop (spec §9): log bot_* actions back through ingestion */
  function emitBot(type, product) {
    if (!analyticsAllowed()) return; // behavioral tracking needs consent
    try {
      queueEvent({
        eventId: `${type}_${SESSION_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        shopId: SHOP_ID,
        sessionId: SESSION_ID,
        type,
        timestamp: new Date().toISOString(),
        productId: product?.productId
      });
      if (type === "bot_add_to_cart") syncSessionToCart();
      if (type === "bot_product_clicked" || type === "bot_add_to_cart") flushEvents(true); // may precede navigation
    } catch (e) { /* never throw into storefront */ }
  }

  /* Proactive decision-engine signals (spec §4). */
  function detectSurface() {
    const p = location.pathname;
    if (/\/products\//.test(p)) return "product";
    if (/\/cart/.test(p)) return "cart";
    if (/\/checkouts?\//.test(p)) return "checkout";
    if (/\/collections\//.test(p)) return "category";
    if (/\/search/.test(p)) return "search";
    return "other";
  }
  function activeFormFieldNow() {
    const el = document.activeElement;
    return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }
  // Track rapid scroll-direction reversals (the "scroll thrash" friction signal).
  // Polls scrollY instead of listening for scroll events — some themes swallow
  // scroll events entirely (custom scroll/view-transition scripts), and polling
  // is theme-agnostic. On category/search surfaces the thrash IS the trigger
  // friction, so once it crosses the server threshold we report it (one ping
  // per page) and re-ask the engine.
  let scrollThrash = 0, lastScrollY = window.scrollY, lastDir = 0, thrashReported = false;
  setInterval(() => {
    const y = window.scrollY, dir = Math.sign(y - lastScrollY);
    if (dir !== 0 && lastDir !== 0 && dir !== lastDir) scrollThrash++;
    if (dir !== 0) lastDir = dir;
    lastScrollY = y;
    const surface = detectSurface();
    const threshold = surface === "search" ? 2 : 3;
    if (!thrashReported && (surface === "category" || surface === "search") && scrollThrash >= threshold) {
      thrashReported = true;
      emitFriction("page_view", {});
      setTimeout(() => runProactive(), 1500); // let the friction event ingest first
    }
  }, 400);

  /* Emit a friction event into the intent stream (consent-gated, batched). */
  function emitFriction(type, extra) {
    if (!analyticsAllowed()) return;
    try {
      queueEvent({
        eventId: `${type}_${SESSION_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        shopId: SHOP_ID, sessionId: SESSION_ID, type, timestamp: new Date().toISOString(),
        surface: detectSurface(), scrollThrash, ...extra,
      });
    } catch (e) { /* never throw into storefront */ }
  }

  /* Launcher icon options (theme-editor `launcher_icon` setting). A widget
     rewrite dropped this wiring once — the embed's settings rendered into
     window.__SALESHQ_CONFIG__ but nothing read them (live bug report,
     2026-07-08). Keep every CONFIG.* read below when refactoring. */
  const LAUNCHER_ICONS = {
    chat: `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  `,
    sparkle: `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/>
    </svg>
  `,
    bag: `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  `,
    help: `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  `,
  };
  const chatIconSvg = LAUNCHER_ICONS[CONFIG.launcherIcon] || LAUNCHER_ICONS.chat;
  // Merchant-editable header copy + screen side (theme editor).
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const HEADER_TITLE = esc(CONFIG.headerTitle || "SalesHQ Assistant");
  const HEADER_SUBTITLE = esc(CONFIG.headerSubtitle || "Always here to help");
  const SIDE = CONFIG.position === "left" ? "left" : "right";

  /* Inject CSS animations and styles */
  const styleSheet = document.createElement("style");
  styleSheet.textContent = `
    @keyframes saleshq-fade-in {
      from { opacity: 0; transform: translateY(10px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes saleshq-fade-out {
      from { opacity: 1; transform: translateY(0) scale(1); }
      to { opacity: 0; transform: translateY(10px) scale(0.95); }
    }
    @keyframes saleshq-typing {
      0%, 60%, 100% { opacity: 0.3; }
      30% { opacity: 1; }
    }
    .saleshq-btn:hover {
      transform: scale(1.08) !important;
      box-shadow: 0 8px 25px rgba(0,0,0,0.25) !important;
    }
    @keyframes saleshq-pulse {
      0% { box-shadow: 0 4px 20px rgba(0,0,0,0.2), 0 0 0 0 rgba(220,38,38,0.5); }
      70% { box-shadow: 0 4px 20px rgba(0,0,0,0.2), 0 0 0 14px rgba(220,38,38,0); }
      100% { box-shadow: 0 4px 20px rgba(0,0,0,0.2), 0 0 0 0 rgba(220,38,38,0); }
    }
    .saleshq-btn--attention { animation: saleshq-pulse 1.6s ease-out infinite; }
    .saleshq-badge {
      position: absolute;
      top: -4px;
      right: -4px;
      min-width: 20px;
      height: 20px;
      padding: 0 5px;
      background: #dc2626;
      color: #fff;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      display: none;
      align-items: center;
      justify-content: center;
      box-shadow: 0 1px 4px rgba(0,0,0,0.3);
      pointer-events: none;
    }
    .saleshq-input:focus {
      outline: none;
      border-color: ${THEME.primary} !important;
      background: #fff !important;
    }
    .saleshq-send-btn:hover {
      background: ${THEME.primaryHover} !important;
    }
    .saleshq-send-btn:active {
      transform: scale(0.95);
    }
    .saleshq-msg-enter {
      animation: saleshq-fade-in 0.3s ease-out forwards;
    }
    .saleshq-close-btn:hover {
      background: rgba(255,255,255,0.26) !important;
    }
    #saleshq-messages::-webkit-scrollbar {
      width: 6px;
    }
    #saleshq-messages::-webkit-scrollbar-track {
      background: transparent;
    }
    #saleshq-messages::-webkit-scrollbar-thumb {
      background: #ddd;
      border-radius: 3px;
    }
    #saleshq-messages::-webkit-scrollbar-thumb:hover {
      background: #ccc;
    }
    /* Responsive panel (Claude Design project 8cb384f7: desktop/tablet floating
       panel, mobile full-screen sheet). Positioning lives HERE, not inline
       cssText, so the media queries can own it per breakpoint. Desktop width
       kept at the current 480px per merchant preference (design mock shows 400). */
    .saleshq-chat {
      position: fixed;
      background: #fff;
      display: none;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
      flex-direction: column;
    }
    @media (min-width: 600px) {
      .saleshq-chat {
        top: 24px;
        bottom: 96px;
        ${SIDE}: 24px;
        width: min(480px, calc(100vw - 48px));
        border-radius: 18px;
        box-shadow: 0 24px 64px -16px rgba(15,23,42,0.28), 0 0 0 1px rgba(15,23,42,0.06);
      }
    }
    @media (max-width: 599px) {
      .saleshq-chat {
        inset: 0;
        width: 100%;
        height: 100dvh;
        border-radius: 0;
        box-shadow: none;
      }
      .saleshq-head { padding-top: calc(env(safe-area-inset-top, 0px) + 16px) !important; }
      .saleshq-foot { padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 8px) !important; }
      /* full-screen sheet covers the launcher — hide it while open */
      .saleshq-btn.saleshq-open { display: none !important; }
    }
    /* Carousel Styles */
    .saleshq-carousel {
      position: relative;
      width: 100%;
      margin-bottom: 14px;
    }
    .saleshq-carousel-track {
      display: flex;
      gap: 12px;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      -ms-overflow-style: none;
      padding: 4px 0;
    }
    .saleshq-carousel-track::-webkit-scrollbar {
      display: none;
    }
    .saleshq-product-card {
      flex-shrink: 0;
      width: 75%;
      background: #fff;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 2px 10px rgba(0,0,0,0.08);
      scroll-snap-align: start;
    }
    .saleshq-product-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 14px rgba(0,0,0,0.12);
    }
    .saleshq-product-card img {
      width: 100%;
      height: 100px;
      object-fit: cover;
    }
    .saleshq-product-card-body {
      padding: 10px;
    }
    .saleshq-product-title {
      font-size: 12px;
      font-weight: 600;
      color: #1a1a1a;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin-bottom: 6px;
    }
    .saleshq-product-price {
      font-size: 13px;
      font-weight: 700;
      color: #1a1a1a;
    }
    .saleshq-product-btn {
      display: block;
      width: 100%;
      padding: 8px;
      margin-top: 8px;
      background: ${THEME.primary};
      color: ${THEME.onPrimary};
      border: none;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      transition: background 0.2s;
    }
    .saleshq-product-btn:hover {
      background: ${THEME.primaryHover};
    }
    /* Follow-up Chips Styles */
    .saleshq-followups {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 14px;
    }
    .saleshq-followup-chip {
      background: #f0f0f0;
      border: none;
      border-radius: 14px;
      padding: 6px 12px;
      font-size: 11px;
      color: #555;
      cursor: pointer;
    }
    /* In-Chat Cart Notification */
    .saleshq-cart-toast {
      position: absolute;
      bottom: 80px;
      left: 16px;
      right: 16px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      padding: 14px;
      z-index: 10;
      animation: saleshq-fade-in 0.3s ease-out;
    }
    .saleshq-cart-toast-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .saleshq-cart-toast-icon {
      width: 24px;
      height: 24px;
      background: #16a34a;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .saleshq-cart-toast-title {
      font-size: 13px;
      font-weight: 600;
      color: #1a1a1a;
    }
    .saleshq-cart-toast-product {
      display: flex;
      gap: 10px;
      padding: 10px 0;
      border-top: 1px solid #eee;
      border-bottom: 1px solid #eee;
    }
    .saleshq-cart-toast-img {
      width: 50px;
      height: 50px;
      border-radius: 8px;
      object-fit: cover;
      background: #f5f5f5;
    }
    .saleshq-cart-toast-info {
      flex: 1;
      min-width: 0;
    }
    .saleshq-cart-toast-name {
      font-size: 12px;
      font-weight: 500;
      color: #1a1a1a;
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .saleshq-cart-toast-price {
      font-size: 12px;
      font-weight: 600;
      color: #555;
    }
    .saleshq-cart-toast-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    .saleshq-cart-toast-btn {
      flex: 1;
      padding: 10px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      transition: all 0.2s;
    }
    .saleshq-cart-toast-btn--primary {
      background: ${THEME.primary};
      color: ${THEME.onPrimary};
      border: none;
    }
    .saleshq-cart-toast-btn--primary:hover {
      background: ${THEME.primaryHover};
    }
    .saleshq-cart-toast-btn--secondary {
      background: #fff;
      color: #1a1a1a;
      border: 1px solid #ddd;
    }
    .saleshq-cart-toast-btn--secondary:hover {
      background: #f5f5f5;
      transition: all 0.2s;
      text-align: left;
      line-height: 1.3;
    }
    .saleshq-followup-chip:hover {
      background: #e0e0e0;
      color: #1a1a1a;
    }
  `;
  document.head.appendChild(styleSheet);

  /* Chat icon SVG */

  /* Close icon SVG */
  const closeIconSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  `;

  /* Send icon SVG */
  const sendIconSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  `;

  /* Notification badge + soft chime for auto-popups. WebAudio needs a user
     gesture on most browsers — the chime resumes/queues on first interaction. */
  function chime() {
    if (!CFG.soundEnabled) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const play = () => {
        try {
          const ctx = (window.__saleshqAC = window.__saleshqAC || new AC());
          if (ctx.state === "suspended") return; // no gesture yet — stay silent
          const t = ctx.currentTime;
          [830, 1245].forEach((freq, i) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = "sine"; o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, t + i * 0.12);
            g.gain.exponentialRampToValueAtTime(0.06, t + i * 0.12 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.3);
            o.connect(g); g.connect(ctx.destination);
            o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.35);
          });
        } catch (e) { /* ignore */ }
      };
      play();
    } catch (e) { /* never throw into storefront */ }
  }
  // resume audio on the first real gesture so later chimes are audible
  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    document.addEventListener(evt, () => {
      try { window.__saleshqAC && window.__saleshqAC.resume(); } catch (e) { /* ignore */ }
    }, { once: true, passive: true }));

  function setBadge(n) {
    if (!badgeEl) return;
    if (n > 0 && !CFG.badgeEnabled) return;
    if (n > 0 && !state.open) {
      badgeEl.textContent = String(n);
      badgeEl.style.display = "flex";
      button.classList.add("saleshq-btn--attention");
    } else {
      badgeEl.style.display = "none";
      button.classList.remove("saleshq-btn--attention");
    }
  }

  /* Floating Button */
  const button = document.createElement("div");
  button.className = "saleshq-btn";
  // rgba() of the brand color for the design's brand-tinted launcher shadow.
  const brandRgb = colorToRgb(THEME.primary) || { r: 26, g: 26, b: 26 };
  const brandTint = (a) => `rgba(${brandRgb.r},${brandRgb.g},${brandRgb.b},${a})`;
  button.style.cssText = `
    position: fixed;
    bottom: 24px;
    ${SIDE}: 24px;
    width: 56px;
    height: 56px;
    background: ${THEME.primary};
    color: ${THEME.onPrimary};
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 8px 24px ${brandTint(0.32)}, 0 2px 6px rgba(15,23,42,0.1);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  `;
  const badgeEl = document.createElement("span");
  badgeEl.className = "saleshq-badge";
  // innerHTML writes wipe children, so the badge is re-attached on every icon swap
  function setButtonIcon(svg) {
    button.innerHTML = svg;
    button.appendChild(badgeEl);
  }
  setButtonIcon(chatIconSvg);

  /* Chat Box — full height (pinned top+bottom), wide, responsive on mobile */
  const chat = document.createElement("div");
  chat.className = "saleshq-chat"; // positioning/size in the stylesheet (responsive)

  chat.innerHTML = `
    <div class="saleshq-head" style="
      padding: 16px 18px;
      background: ${THEME.primary};
      color: ${THEME.onPrimary};
      display: flex;
      align-items: center;
      gap: 11px;
    ">
      <span style="
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: rgba(255,255,255,0.18);
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      ">${chatIconSvg.replace('width="26" height="26"', 'width="18" height="18"')}</span>
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 700; font-size: 15px; letter-spacing: -0.2px;">${HEADER_TITLE}</div>
        <div style="font-size: 12px; opacity: 0.85; margin-top: 1px;">${HEADER_SUBTITLE}</div>
      </div>
      <span style="
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #4ade80;
        box-shadow: 0 0 0 3px rgba(74,222,128,0.25);
        flex: 0 0 auto;
      "></span>
      <button id="saleshq-close" class="saleshq-close-btn" style="
        width: 32px;
        height: 32px;
        background: rgba(255,255,255,0.14);
        border: none;
        color: ${THEME.onPrimary};
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: background 0.2s;
        flex: 0 0 auto;
      ">
        ${closeIconSvg}
      </button>
    </div>
    <div id="saleshq-messages" style="
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      overflow-x: hidden;
      background: #f6f7f9;
      scroll-behavior: smooth;
    "></div>
    <div id="saleshq-tips-footer" style="
      text-align: center;
      padding: 2px 0 6px;
      background: #f6f7f9;
    ">
      <button id="saleshq-tips-off" style="
        background: none;
        border: none;
        color: #9ca3af;
        font-size: 11px;
        cursor: pointer;
        text-decoration: underline;
      ">Don't show tips this session</button>
    </div>
    <form id="saleshq-form" style="
      display: flex;
      align-items: center;
      padding: 12px 14px;
      gap: 10px;
      background: #fff;
      border-top: 1px solid #eef0f2;
    ">
      <input
        id="saleshq-input"
        class="saleshq-input"
        placeholder="Type your message..."
        autocomplete="off"
        style="
          flex: 1;
          height: 44px;
          border: 1px solid #e5e7eb;
          padding: 0 16px;
          border-radius: 22px;
          font-size: 14px;
          transition: all 0.2s;
          background: #f7f8fa;
        "
      />
      <button type="submit" class="saleshq-send-btn" style="
        width: 44px;
        height: 44px;
        border: none;
        background: ${THEME.primary};
        color: ${THEME.onPrimary};
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        flex-shrink: 0;
      ">
        ${sendIconSvg}
      </button>
    </form>
    <div class="saleshq-foot" style="
      text-align: center;
      font-size: 10.5px;
      color: #b6bcc6;
      padding: 0 0 8px;
      background: #fff;
    ">Powered by <b style="color:#8b91a0;font-weight:600;">SalesHQ</b></div>
  `;

  function toggleChat() {
    state.open = !state.open;
    saveState();
    if (state.open) {
      chat.style.display = "flex";
      chat.style.animation = "saleshq-fade-in 0.3s ease-out forwards";
      setButtonIcon(closeIconSvg);
      button.classList.add("saleshq-open"); // mobile sheet hides the launcher
      setBadge(0); // opening clears the unread badge
    } else {
      // Closing the widget just closes it — it does NOT silence the session.
      // Nag protection is the per-session cap + per-trigger cooldown, so a shopper
      // who closes one nudge can still get a later, different one (e.g. compare).
      proactiveOpen = false;
      chat.style.animation = "saleshq-fade-out 0.2s ease-out forwards";
      setButtonIcon(chatIconSvg);
      button.classList.remove("saleshq-open"); // mobile: bring the launcher back
      setTimeout(() => {
        chat.style.display = "none";
      }, 200);
    }
  }

  button.onclick = toggleChat;

  button.style.display = "none";
  document.body.appendChild(button);
  document.body.appendChild(chat);

  let proactiveRecheckTimer = null;
  function shutdownWidget() {
    try { button.remove(); chat.remove(); styleSheet.remove(); } catch (e) { /* ignore */ }
    if (proactiveRecheckTimer) clearInterval(proactiveRecheckTimer);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    eventQueue = [];
    window.__SALESHQ_CHAT__ = false;
  }

  const messagesEl = chat.querySelector("#saleshq-messages");
  const form = chat.querySelector("#saleshq-form");
  const input = chat.querySelector("#saleshq-input");
  const closeBtn = chat.querySelector("#saleshq-close");

  // Typing counts as activity — never nudge someone mid-thought.
  input.addEventListener("input", () => { lastInteractionAt = Date.now(); });

  closeBtn.onclick = toggleChat;

  /* Merchant configuration (admin → Bot settings): welcome copy + behavior
     knobs. Cached per session so only the first page pays the round-trip.
     Defaults reproduce shipped behavior when the fetch fails. */
  let WELCOME = "Hi! 👋 I'm your personal shopping assistant. I can:\n- **Find products** that fit your needs and budget\n- **Compare items** side by side\n- **Recommend picks** personalized to what you're browsing\n- **Answer questions** on details, sizing, and stock\n\nWhat are you looking for today?";
  const CFG = {
    botEnabled: true,
    proactiveEnabled: true,
    welcomeEnabled: true,
    welcomeDelayMs: 10_000,
    idleResumeEnabled: true,
    idleResumeMs: 50_000,
    soundEnabled: true,
    badgeEnabled: true,
  };
  function applyCfg(c) {
    if (!c) return;
    if (c.welcome) WELCOME = c.welcome;
    for (const k of Object.keys(CFG)) {
      if (typeof c[k] === typeof CFG[k]) CFG[k] = c[k];
    }
  }
  async function loadConfig() {
    try {
      const r = await fetch(`${API_BASE}/config`, { cache: "no-store" });
      if (r.ok) {
        const c = await r.json();
        applyCfg(c);
        if (c.botEnabled !== false) {
          try { sessionStorage.setItem("saleshq_cfg", JSON.stringify(c)); } catch (e) { /* ignore */ }
        } else {
          try { sessionStorage.removeItem("saleshq_cfg"); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore — defaults keep widget usable until next page */ }
  }

  /* Returning visitor (same saleshq_sid cookie, new tab/day): the tab-local
     cache is empty but the server keeps the transcript — pull it back. */
  async function loadServerHistory() {
    if (state.history.length > 0) return; // local cache wins (fresher)
    try {
      const r = await fetch(`${API_BASE}/history?sessionId=${encodeURIComponent(SESSION_ID)}`);
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.messages) && d.messages.length) {
          state.history = d.messages.slice(-50);
          saveState();
        }
      }
    } catch (e) { /* ignore — worst case, fresh welcome */ }
  }

  /* Restore previous messages or show welcome */
  function restoreMessages() {
    if (state.history.length > 0) {
      // Restore messages without re-saving to state. Product carousels are
      // content — restore all of them; follow-up chips only for the LAST
      // message (older ones were superseded by the conversation moving on).
      state.history.forEach((entry, i) => {
        const msg = document.createElement("div");
        msg.style.cssText = `
          margin-bottom: 14px;
          display: flex;
          justify-content: ${entry.role === "user" ? "flex-end" : "flex-start"};
        `;
        msg.innerHTML = bubbleHtml(entry.role, parseMarkdown(entry.content));
        messagesEl.appendChild(msg);
        if (entry.products && entry.products.length) renderProductCarousel(entry.products);
        if (i === state.history.length - 1 && entry.followups && entry.followups.length) {
          renderFollowups(entry.followups);
        }
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      // Show welcome message + intent-revealing starter CTAs for new conversations
      const starters = [
        "Help me find something",
        "Show your bestsellers",
        "I'm shopping for a gift"
      ];
      addMessage("assistant", WELCOME, { followups: starters });
      renderFollowups(starters);
    }
  }

  /* Restore open state if previously open */
  if (state.open) {
    chat.style.display = "flex";
    setButtonIcon(closeIconSvg);
    button.classList.add("saleshq-open");
  }

  Promise.all([loadConfig(), loadServerHistory()]).finally(() => {
    if (CFG.botEnabled === false) { shutdownWidget(); return; }
    button.style.display = "flex";
    restoreMessages();
    scheduleWelcome();
    syncTipsFooter(); // config may disable proactive → hide the opt-out link
    startProactivePolling();
  });

  /* Proactive popup (spec §7.5): on ANY page, ask the server whether to pop up.
     The server reads the shopper's live intent (built from pixel events) and
     decides the action — comparison, cart help, or a personalized recommendation —
     or declines. Server enforces the frequency cap; we just gate one call per page. */

  // Resolve the current product's Storefront GID (only when on a product page).
  // Fast path: ShopifyAnalytics meta; fallback: /products/<handle> Ajax JSON.
  async function currentProductGid() {
    const m = window.ShopifyAnalytics?.meta?.product || window.meta?.product;
    if (m?.gid) return m.gid;
    if (m?.id) return `gid://shopify/Product/${m.id}`;
    const match = location.pathname.match(/\/products\/([^/?#]+)/);
    if (match) {
      try {
        const res = await fetch(`${getShopifyRoot()}products/${match[1]}.js`);
        if (res.ok) {
          const prod = await res.json();
          if (prod?.id) return `gid://shopify/Product/${prod.id}`;
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  // True when the currently-open widget was opened by a proactive popup (a reply
  // = engagement). proactiveDisabled = the shopper explicitly turned tips off
  // for this session via the popup's control (distinct from just closing).
  let proactiveOpen = false;
  let proactiveDisabled = false;
  try { proactiveDisabled = sessionStorage.getItem("saleshq_tips_off") === "1"; } catch (e) { /* ignore */ }

  // Last time the shopper actively touched the chat (typing counts, not just
  // sending). Combined with state.lastMessageAt to decide "gone quiet".
  let lastInteractionAt = 0;
  function chatIsIdle() {
    if (!CFG.idleResumeEnabled) return false;
    const lastAct = Math.max(state.lastMessageAt || 0, lastInteractionAt || 0);
    return Date.now() - lastAct >= CFG.idleResumeMs;
  }

  async function runProactive(opts) {
    opts = opts || {};
    if (!API_BASE || proactiveDisabled || !CFG.proactiveEnabled || !CFG.botEnabled) return;
    try { await seedDone; } catch (e) { /* seeds are best-effort */ }
    try { await flushEvents(); } catch (e) { /* engine must see this page's events */ }
    // A shopper who is ACTIVELY chatting drives the conversation — but once
    // they've gone quiet for CHAT_IDLE_MS, intent nudges resume (into the open
    // window if it's still open, or as a fresh popup). A window that's merely
    // open because the passive auto-welcome opened it (shopper never typed)
    // does NOT block: the welcome's own auto-add used to bump lastMessageAt,
    // making chatIsIdle() stay false for a full 50s from an event the BOT
    // caused, not the user — silencing every intent nudge for a shopper who
    // never engaged. Found via real-browser testing (2026-07-07): the welcome
    // opened at 10s and no dwell/compare nudge could fire until ~60s, past
    // when a short-attention-span visitor has already left.
    const idle = chatIsIdle();
    const hasChatted = state.history.some((m) => m.role === "user");
    if (hasChatted && !idle) return;
    if (!analyticsAllowed()) return; // proactive targeting is behavioral → needs consent
    let productId = null;
    try { productId = await currentProductGid(); } catch (e) { /* ignore */ }

    const wasOpen = state.open;
    try {
      const res = await fetch(`${API_BASE}/proactive`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({
          shopId: SHOP_ID, sessionId: SESSION_ID,
          productId: productId || undefined,
          surface: detectSurface(),
          exitIntent: !!opts.exitIntent,
          activeFormField: activeFormFieldNow(),
          // "open but idle 50s" counts as not actively engaged for the gate
          widgetOpen: state.open && !idle,
        })
      });
      const data = await res.json();
      if (!data.show) return;
      if (state.open && !wasOpen) return; // user opened it themselves mid-flight
      proactiveOpen = true;
      chime();
      if (!state.open) toggleChat(); // closed → open with the ready-made nudge
      addMessage("assistant", data.response, { products: data.products || [], followups: data.followups || [] });
      if (data.products && data.products.length) renderProductCarousel(data.products);
      if (data.followups && data.followups.length) renderFollowups(data.followups);
    } catch (e) { /* never disrupt the storefront */ }
  }

  // Explicit opt-out: a PERSISTENT footer link inside the chat (was appended per
  // popup, so it appeared inconsistently — gone after refresh/welcome). Plain
  // close keeps popups on; this silences proactive for the rest of THIS session
  // (server /dismiss enforces it server-side too).
  const tipsFooter = chat.querySelector("#saleshq-tips-footer");
  const tipsOffBtn = chat.querySelector("#saleshq-tips-off");
  function syncTipsFooter() {
    if (tipsFooter) tipsFooter.style.display = proactiveDisabled || !CFG.proactiveEnabled ? "none" : "";
  }
  if (tipsOffBtn) {
    tipsOffBtn.onclick = () => {
      proactiveDisabled = true;
      try { sessionStorage.setItem("saleshq_tips_off", "1"); } catch (e) { /* ignore */ }
      try {
        fetch(`${API_BASE}/dismiss`, { method: "POST", headers: { "Content-Type": "text/plain" },
          keepalive: true, body: JSON.stringify({ shopId: SHOP_ID, sessionId: SESSION_ID }) }).catch(() => {});
      } catch (e) { /* ignore */ }
      syncTipsFooter();
      if (state.open) toggleChat();
    };
  }
  syncTipsFooter();

  // Significant-event trigger: exit-intent (cursor leaving toward the top) is the
  // last-chance moment — fire immediately, once per page (spec §10).
  let exitFired = false;
  document.addEventListener("mouseout", (e) => {
    if (exitFired || state.open) return;
    if (e.clientY <= 0 && !e.relatedTarget) {
      exitFired = true;
      emitFriction("exit_intent", {});
      runProactive({ exitIntent: true });
    }
  });

  // Cart-idle signal: on the cart surface, report idle time if they sit still.
  if (detectSurface() === "cart") {
    setTimeout(() => { if (!state.open) emitFriction("page_view", { cartIdleMs: 26_000 }); }, 26_000);
  }

  // Dwell signal: lingering on a product (no comparison loop yet) is friction too.
  // Report dwell once past the baseline (product baseline 5s → ~9s), then re-check.
  if (detectSurface() === "product") {
    const DWELL_MS = 10_000;
    setTimeout(async () => {
      if (state.history.some((m) => m.role === "user") && !chatIsIdle()) return; // only an ACTIVE conversation blocks — see runProactive
      let pid = null;
      try { pid = await currentProductGid(); } catch (e) { /* ignore */ }
      emitFriction("page_view", { dwellMs: DWELL_MS, productId: pid || undefined });
      setTimeout(() => runProactive(), 1500); // let the dwell event ingest first
    }, DWELL_MS);

    // Comparison fast-path: the server's product_compare trigger needs a PDP
    // loop (A → B → back to A). Waiting for the next poll (first at 9s, then
    // every 15s) made the comparison nudge feel late — the shopper is at PEAK
    // comparison intent the instant they land back on a product they've seen.
    // Track visited PDPs client-side; the moment this page completes a loop,
    // ask the engine right away (~1.5s for the view event to ingest). Server
    // gates still decide — this only moves the ASK earlier, never forces a show.
    (async () => {
      let pid = null;
      try { pid = await currentProductGid(); } catch (e) { /* ignore */ }
      if (!pid) return;
      let seen = [];
      try { seen = JSON.parse(sessionStorage.getItem("saleshq_pdp_trail") || "[]"); } catch (e) { /* ignore */ }
      const prevIdx = seen.lastIndexOf(pid);
      // Loop = this product was visited before, with a DIFFERENT product in between.
      const loop = prevIdx !== -1 && seen.slice(prevIdx + 1).some((p) => p !== pid);
      if (seen[seen.length - 1] !== pid) seen.push(pid);
      try { sessionStorage.setItem("saleshq_pdp_trail", JSON.stringify(seen.slice(-20))); } catch (e) { /* ignore */ }
      if (loop) setTimeout(() => runProactive(), 1500);
    })();
  }


  /* Seed the intent stream from the page context. Fallback for stores where the
     sandboxed pixel can't reach the App Proxy (password-protected previews send
     the pixel's fetch through the password wall without cookies). The server
     dedupes these against real pixel events, so on a healthy-pixel store this
     is a no-op. Proactive calls await `seedDone` so the engine never composes
     against a session that's missing this page's events (e.g. a cart removal). */
  const seedDone = (async function seedIntent() {
    if (!analyticsAllowed()) return;
    const surface = detectSurface();
    const seed = (type, extra) => {
      try {
        queueEvent({
          eventId: `seed_${type}_${SESSION_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          shopId: SHOP_ID, sessionId: SESSION_ID, type, source: "widget_seed",
          timestamp: new Date().toISOString(), surface, ...extra,
        });
      } catch (e) { /* never throw into storefront */ }
    };
    if (surface === "product") {
      const match = location.pathname.match(/\/products\/([^/?#]+)/);
      if (!match) return;
      try {
        const res = await fetch(`${getShopifyRoot()}products/${match[1]}.js`);
        if (res.ok) {
          const p = await res.json();
          seed("product_view", {
            productId: `gid://shopify/Product/${p.id}`,
            price: typeof p.price === "number" ? p.price / 100 : undefined,
            category: p.type || undefined,
          });
        }
      } catch (e) { /* ignore */ }
    } else if (surface === "category") {
      const cat = (location.pathname.match(/\/collections\/([^/?#]+)/) || [])[1];
      seed("collection_view", { category: cat ? decodeURIComponent(cat) : undefined });
    } else if (surface === "search") {
      const q = new URLSearchParams(location.search).get("q");
      if (q) seed("search", { searchTerm: q });
    }

    // Cart diff (every page): compare the live cart against the last snapshot and
    // mirror the TRANSITIONS as add_to_cart / remove_from_cart. Removal is a key
    // hesitation signal the sandboxed pixel can't deliver on password-protected
    // stores. Diff fires once per transition, so timestamped eventIds are safe.
    try {
      const cart = await fetch(`${getShopifyRoot()}cart.js`).then((r) => r.json());
      const now = {};
      (cart.items || []).forEach((it) => {
        now[it.variant_id] = { product_id: it.product_id, price: it.price, product_type: it.product_type };
      });
      let prev = {};
      try { prev = JSON.parse(localStorage.getItem("saleshq_cart_snapshot") || "{}"); } catch (e) { /* ignore */ }
      const cartEvent = (type, it) => seed(type, {
        productId: `gid://shopify/Product/${it.product_id}`,
        price: typeof it.price === "number" ? it.price / 100 : undefined,
        category: it.product_type || undefined,
      });
      for (const vid in now) if (!prev[vid]) cartEvent("add_to_cart", now[vid]);
      for (const vid in prev) if (!now[vid]) cartEvent("remove_from_cart", prev[vid]);
      localStorage.setItem("saleshq_cart_snapshot", JSON.stringify(now));
    } catch (e) { /* ignore */ }
  })();

  function startProactivePolling() {
    // First real check lands just past the default min-session-age gate (8s
    // server-side) — the old 4s-then-30s cadence wasted its entire first cycle
    // on a call guaranteed to fail eligibility, then left a 30s gap before the
    // next try. Short visits (per live feedback: shoppers who don't engage
    // quickly leave) need a tighter early cadence.
    setTimeout(() => runProactive(), 9_000);
    proactiveRecheckTimer = setInterval(() => {
      proactiveChecks++;
      if (proactiveChecks > 30 || proactiveDisabled) {
        clearInterval(proactiveRecheckTimer);
        return;
      }
      if (!idlePinged && chatIsIdle() && state.history.some((m) => m.role === "user")) {
        idlePinged = true;
        currentProductGid()
          .catch(() => null)
          .then((pid) => emitFriction("page_view", { dwellMs: CFG.idleResumeMs, productId: pid || undefined }));
        setTimeout(() => runProactive(), 1500);
        return;
      }
      runProactive();
    }, 15_000);
  }

  /* Welcome attention flow: once per browser session — badge + chime teaser,
     then auto-open the chat with the welcome + starter chips at the merchant-
     configured delay. Pure UI, no LLM, no server call. Intent nudges arriving
     later still fire (close ≠ dismiss). Returning sessions with an existing
     conversation get the badge only (never clobber a conversation). Skipped
     after a dismissal or once the shopper has chatted. Scheduled AFTER config
     load so the merchant's delay/enable settings apply. */
  function scheduleWelcome() {
    if (!CFG.welcomeEnabled) return;
    try { if (sessionStorage.getItem("saleshq_welcomed")) return; } catch (e) { /* ignore */ }
    const teaserMs = Math.max(2_000, CFG.welcomeDelayMs - 6_000);
    setTimeout(() => {
      if (state.open || proactiveDisabled || state.history.some((m) => m.role === "user")) return;
      setBadge(1);
      chime();
    }, teaserMs);
    setTimeout(() => {
      if (state.open || proactiveDisabled) return;
      if (state.history.some((m) => m.role === "user")) return;
      try { sessionStorage.setItem("saleshq_welcomed", "1"); } catch (e) { /* ignore */ }
      if (state.history.length > 1) return; // returning conversation → badge stays, no auto-open
      chime();
      toggleChat();
    }, CFG.welcomeDelayMs);
  }

  // Keep offering help while the shopper stays on the page: re-ask the server
  // every 30s (gates run server-side and are cheap — no LLM unless one fires).
  // Stops when the shopper engages the chat, turns tips off, or after 10 checks.
  let proactiveChecks = 0;
  let idlePinged = false;

  /* One clean message bubble. Assistant bubbles are wider so tables/lists stay
     fully readable; user bubbles stay compact. */
  function bubbleHtml(role, html) {
    const isUser = role === "user";
    return `<div style="
      display:inline-block;
      padding:10px 14px;
      border-radius:${isUser ? "16px 16px 5px 16px" : "16px 16px 16px 5px"};
      background:${isUser ? THEME.primary : "#fff"};
      color:${isUser ? THEME.onPrimary : "#1f2937"};
      max-width:${isUser ? "82%" : "96%"};
      font-size:14px;line-height:1.5;letter-spacing:-0.1px;
      box-shadow:${isUser ? "none" : "0 1px 2px rgba(0,0,0,0.08)"};
      border:${isUser ? "none" : "1px solid #eef0f2"};
      word-wrap:break-word;overflow-wrap:anywhere;
    ">${html}</div>`;
  }

  /* Parse markdown → HTML: tables, headings, rules, lists, bold/italic.
     Escapes HTML first (XSS-safe), then renders block + inline elements. */
  function parseMarkdown(text) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const inline = (s) =>
      esc(s)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/__(.+?)__/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+?)\*/g, "$1<em>$2</em>")
        .replace(/(^|[^_])_([^_]+?)_/g, "$1<em>$2</em>");

    const lines = String(text).split("\n");
    const out = [];
    let i = 0;
    let listOpen = false;
    const closeList = () => { if (listOpen) { out.push("</ul>"); listOpen = false; } };

    while (i < lines.length) {
      const line = lines[i];

      // Table: a |...| row followed by a |---| separator row
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        closeList();
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const header = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        // Fixed layout with explicit column widths — WITHOUT this, a narrow
        // widget auto-sizes columns and crushes the leftmost feature column into
        // letter-by-letter vertical wrap ("S/u/p/p/o/r/t"). The first (key)
        // column is wider + sticky so feature names stay readable while data
        // columns scroll horizontally. (Regression re-fix, 2026-07-08.)
        const FIRST_W = 120, DATA_W = 148;
        const dataCols = Math.max(1, header.length - 1);
        const tableW = FIRST_W + DATA_W * dataCols;
        const firstCell = "position:sticky;left:0;z-index:1;";
        let t = '<div style="overflow-x:auto;margin:8px 0;border:1px solid #eef0f2;border-radius:10px;"><table style="border-collapse:collapse;font-size:12px;table-layout:fixed;width:' + tableW + 'px;">';
        t += "<colgroup>" + header.map((_, ci) => `<col style="width:${ci === 0 ? FIRST_W : DATA_W}px;">`).join("") + "</colgroup>";
        t += "<thead><tr>" + header.map((h, ci) => `<th style="padding:7px 10px;text-align:left;background:#f7f8fa;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;word-break:normal;overflow-wrap:break-word;${ci === 0 ? firstCell : ""}">${inline(h)}</th>`).join("") + "</tr></thead><tbody>";
        rows.forEach((r, ri) => {
          const bg = ri % 2 ? "#fbfbfc" : "#fff";
          t += `<tr style="background:${bg};">` + r.map((c, ci) => `<td style="padding:7px 10px;border-bottom:1px solid #f1f2f4;word-break:normal;overflow-wrap:break-word;vertical-align:top;${ci === 0 ? `font-weight:600;color:#374151;background:${bg};${firstCell}` : "color:#4b5563;"}">${inline(c)}</td>`).join("") + "</tr>";
        });
        out.push(t + "</tbody></table></div>");
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); out.push(`<div style="font-weight:700;margin:8px 0 3px;font-size:13.5px;color:#111827;">${inline(h[2])}</div>`); i++; continue; }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push('<hr style="border:none;border-top:1px solid #eee;margin:8px 0;">'); i++; continue; }

      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) { if (!listOpen) { out.push('<ul style="margin:4px 0;padding-left:18px;">'); listOpen = true; } out.push(`<li>${inline(li[1])}</li>`); i++; continue; }

      if (line.trim() === "") { closeList(); out.push("<br>"); i++; continue; }

      closeList(); out.push(inline(line) + "<br>"); i++;
    }
    closeList();
    return out.join("");
  }

  /* extra = { products, followups }: persisted with the message so carousels
     and chips survive page refresh / reopen (they're re-rendered on restore). */
  function addMessage(role, text, extra) {
    const msg = document.createElement("div");
    msg.className = "saleshq-msg-enter";
    msg.style.cssText = `
      margin-bottom: 14px;
      display: flex;
      justify-content: ${role === "user" ? "flex-end" : "flex-start"};
    `;

    msg.innerHTML = bubbleHtml(role, parseMarkdown(text));
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    state.history.push({ role, content: text, ...(extra || {}) });
    state.lastMessageAt = Date.now();
    saveState();
    return msg;
  }

  function renderProductCarousel(products) {
    if (!products || products.length === 0) return;

    // Create carousel container
    const carousel = document.createElement("div");
    carousel.className = "saleshq-carousel saleshq-msg-enter";

    // Create scrollable track
    const track = document.createElement("div");
    track.className = "saleshq-carousel-track";

    // Add cards directly to track for horizontal scroll
    products.forEach((product) => {
      const card = createProductCard(product);
      track.appendChild(card);
    });

    carousel.appendChild(track);
    messagesEl.appendChild(carousel);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function createProductCard(product) {
    const card = document.createElement("div");
    card.className = "saleshq-product-card";
    card.style.cursor = "pointer";

    const placeholderImg = product.imageUrl || "https://via.placeholder.com/200x140/f5f5f5/999?text=Product";
    const priceLabel = `${product.currency || ''} ${product.price ?? '0'}`.trim();
    const outOfStock = product.inStock === false;
    const badgeText = product.badge || (outOfStock ? "Out of stock" : "");
    const badge = badgeText
      ? `<div style="font-size: 10px; font-weight: 600; color: ${/out of stock/i.test(badgeText) ? "#dc2626" : "#b45309"}; margin-bottom: 4px;">${badgeText}</div>`
      : '';

    card.innerHTML = `
      <img
        src="${placeholderImg}"
        alt="${product.title || 'Product'}"
        style="
          width: 100%;
          height: 120px;
          object-fit: cover;
          ${outOfStock ? "filter: grayscale(0.6); opacity: 0.85;" : ""}
        "
      />
      <div style="padding: 12px;">
        ${badge}
        <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px; line-height: 1.3;">
          ${product.title || 'Product'}
        </div>
        <div style="font-weight: 700; font-size: 14px; margin-bottom: 10px;">
          ${priceLabel}
        </div>
        <button
          class="saleshq-add-to-cart"
          style="
            width: 100%;
            padding: 10px;
            border-radius: 8px;
            border: ${outOfStock ? "1px solid #d1d5db" : "none"};
            background: ${outOfStock ? "#fff" : THEME.primary};
            color: ${outOfStock ? "#1a1a1a" : THEME.onPrimary};
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
          "
        >
          ${outOfStock ? "View product" : "Add to Cart"}
        </button>
      </div>
    `;

    const goToProduct = () => {
      emitBot("bot_product_clicked", product); // keepalive — survives navigation
      if (product.handle) window.location.href = `${getShopifyRoot()}products/${product.handle}`;
    };

    const addBtn = card.querySelector(".saleshq-add-to-cart");
    addBtn.onclick = (e) => {
      e.stopPropagation();
      if (outOfStock) { goToProduct(); return; } // can't cart it — show the page
      handleAddToCart(addBtn, product);
      document.dispatchEvent(new Event("cart:build"));
    };

    // Clicking the card opens the product page on the storefront.
    card.addEventListener("click", goToProduct);

    return card;
  }

  // Get locale-aware base URL for Shopify Ajax API
  function getShopifyRoot() {
    return window.Shopify?.routes?.root || '/';
  }

  async function getVariantIdFromHandle(handle) {
    const root = getShopifyRoot();
    const res = await fetch(`${root}products/${handle}.js`);
    if (!res.ok) throw new Error("Product not found");
    const product = await res.json();
    return product.variants[0].id;
  }

  async function handleAddToCart(button, product) {
    if (button.dataset.loading === "true") return;

    const root = getShopifyRoot();

    try {
      button.dataset.loading = "true";
      button.innerText = "Adding…";
      button.disabled = true;
      button.style.opacity = "0.7";

      const variantId = await getVariantIdFromHandle(product.handle);

      const addRes = await fetch(`${root}cart/add.js`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{
            id: variantId,
            quantity: 1
          }]
        })
      });

      if (!addRes.ok) {
        throw new Error("Failed to add to cart");
      }

      const addedItems = await addRes.json();

      // Force cart refresh
      const cartRes = await fetch(`${root}cart.js`);
      const cartData = await cartRes.json();

      // Update cart UI across different themes
      updateCartUI(cartData);

      // Show in-chat notification (always works - 100% reliable)
      showInChatNotification(product, cartData);

      // Also try to show theme's cart notification popup (bonus)
      showCartNotification(addedItems, cartData);

      emitBot("bot_add_to_cart", product);

      button.innerText = "Added ✓";
      button.style.background = "#16a34a";
  
      setTimeout(() => {
        button.innerText = "Add to Cart";
        button.style.background = THEME.primary;
        button.disabled = false;
        button.style.opacity = "1";
        button.dataset.loading = "false";
      }, 1500);
    } catch (err) {
      button.innerText = "Error";
      button.style.background = "#dc2626";
  
      setTimeout(() => {
        button.innerText = "Add to Cart";
        button.style.background = THEME.primary;
        button.disabled = false;
        button.style.opacity = "1";
        button.dataset.loading = "false";
      }, 1500);
    }
  }

  // Real /cart.js contents sent with every chat turn, so the bot can answer
  // "what's in my cart" from ground truth instead of guessing (live bug report:
  // the bot had no way to see the cart at all).
  async function getCartSnapshot() {
    try {
      const res = await fetch(`${getShopifyRoot()}cart.js`);
      const cart = await res.json();
      return {
        items: (cart.items || []).slice(0, 20).map((i) => ({
          title: i.product_title + (i.variant_title ? ` (${i.variant_title})` : ""),
          quantity: i.quantity,
          price: i.price / 100,
        })),
        total: cart.total_price / 100,
        currency: cart.currency,
      };
    } catch (e) {
      return undefined;
    }
  }

  // Executes the bot's conversational add_to_cart tool call (server already
  // resolved productId/variantId/quantity — no handle lookup needed here).
  async function performCartAdd(cartAdd) {
    const root = getShopifyRoot();
    try {
      const addRes = await fetch(`${root}cart/add.js`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ id: cartAdd.variantId, quantity: cartAdd.quantity || 1 }] })
      });
      if (!addRes.ok) throw new Error("cart/add.js failed");
      const cartRes = await fetch(`${root}cart.js`);
      const cartData = await cartRes.json();
      updateCartUI(cartData);
      emitBot("bot_add_to_cart", { productId: cartAdd.productId });
    } catch (err) {
      addMessage("assistant", `Sorry, that didn't actually make it into your cart. Try the "Add to Cart" button on the card instead.`);
    }
  }

  function renderFollowups(followups) {
    if (!followups || followups.length === 0) return;

    const container = document.createElement("div");
    container.className = "saleshq-followups saleshq-msg-enter";

    // Limit to 3 follow-ups
    const limitedFollowups = followups.slice(0, 3);

    limitedFollowups.forEach((question) => {
      const chip = document.createElement("button");
      chip.className = "saleshq-followup-chip";
      chip.textContent = question;

      chip.onclick = () => {
        // Remove the followups container after click
        container.remove();

        // Set input value and trigger submit
        input.value = question;
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      };

      container.appendChild(chip);
    });

    messagesEl.appendChild(container);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTypingIndicator() {
    const typing = document.createElement("div");
    typing.id = "saleshq-typing";
    typing.className = "saleshq-msg-enter";
    typing.style.cssText = `
      margin-bottom: 14px;
      display: flex;
      justify-content: flex-start;
    `;
    typing.innerHTML = `
      <div style="
        display: inline-flex;
        gap: 4px;
        padding: 14px 18px;
        border-radius: 18px 18px 18px 4px;
        background: #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      ">
        <span style="
          width: 8px;
          height: 8px;
          background: #999;
          border-radius: 50%;
          animation: saleshq-typing 1.4s infinite;
          animation-delay: 0s;
        "></span>
        <span style="
          width: 8px;
          height: 8px;
          background: #999;
          border-radius: 50%;
          animation: saleshq-typing 1.4s infinite;
          animation-delay: 0.2s;
        "></span>
        <span style="
          width: 8px;
          height: 8px;
          background: #999;
          border-radius: 50%;
          animation: saleshq-typing 1.4s infinite;
          animation-delay: 0.4s;
        "></span>
      </div>
    `;
    messagesEl.appendChild(typing);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return typing;
  }

  form.onsubmit = async (e) => {
    e.preventDefault();

    const text = input.value.trim();
    if (!text) return;

    // First reply to a proactive popup = engagement; hand off to reactive (§9.3).
    if (proactiveOpen && !state.history.some((m) => m.role === "user")) {
      proactiveOpen = false;
      try {
        fetch(`${API_BASE}/engage`, { method: "POST", headers: { "Content-Type": "text/plain" }, keepalive: true,
          body: JSON.stringify({ shopId: SHOP_ID, sessionId: SESSION_ID }) }).catch(() => {});
      } catch (e) { /* ignore */ }
    }

    addMessage("user", text);
    input.value = "";

    const typingEl = showTypingIndicator();
    try { await flushEvents(); } catch (e) { /* chat context should include queued events */ }
    const cart = await getCartSnapshot();

    const body = JSON.stringify({
      shopId: SHOP_ID,
      sessionId: SESSION_ID,
      message: text,
      cart,
      // strip client-only fields (products/followups) — server wants role+content
      history: state.history.slice(-10).map((m) => ({ role: m.role, content: m.content }))
    });

    try {
      if (!API_BASE) throw new Error("SalesHQ: apiBase not configured in theme settings");
      const streamed = await streamChat(body, typingEl);
      if (streamed) return; // stream handled the whole response (text + extras)

      // Fallback: non-streaming endpoint (older server, or the stream failed).
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      });
      const data = await res.json();
      typingEl.remove();
      if (!res.ok || data.serviceStopped) {
        addMessage("assistant", data.message || data.response || "The assistant is temporarily unavailable. Please check back soon.");
        return;
      }
      addMessage("assistant", data.response, { products: data.products || [], followups: data.followups || [] });
      if (data.cartAdd) performCartAdd(data.cartAdd);
      if (data.products && data.products.length) renderProductCarousel(data.products);
      if (data.followups && data.followups.length) renderFollowups(data.followups);
    } catch (err) {
      typingEl.remove();
      addMessage("assistant", "Sorry, I'm having trouble right now. Please try again.");
    }
  };

  /* Stream the reply token-by-token over SSE from /chat-stream so the shopper
     sees text appear as the LLM emits it (was reverted to a blocking /chat
     call — restored 2026-07-08). Events: {reset} drop interim text before a
     tool turn, {delta,text} append a token, {done,...ChatResult} final extras,
     {error}. Returns true if it fully handled the response; false → caller
     falls back to POST /chat. text/plain body keeps it a simple CORS request. */
  async function streamChat(body, typingEl) {
    let res;
    try {
      res = await fetch(`${API_BASE}/chat-stream`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      });
    } catch (e) {
      return false; // network/route missing → fall back
    }
    if (!res.ok || !res.body || !/text\/event-stream/i.test(res.headers.get("content-type") || "")) {
      return false;
    }

    // Keep the typing animation up until the FIRST token actually arrives —
    // the stream's headers land immediately but internal tool turns can run
    // for seconds first, and an empty bubble reads as broken. The live bubble
    // is created lazily on the first delta.
    let msgEl = null;
    let bubble = null;
    let acc = "";
    let done = null;
    const ensureBubble = () => {
      if (msgEl) return;
      typingEl.remove();
      msgEl = addMessage("assistant", "");
      bubble = msgEl.querySelector("div"); // the bubbleHtml wrapper
    };
    const paint = () => { if (bubble) { bubble.innerHTML = parseMarkdown(acc); messagesEl.scrollTop = messagesEl.scrollHeight; } };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done: rdone } = await reader.read();
        if (rdone) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; each carries `data: {json}`.
        const frames = buf.split("\n\n");
        buf = frames.pop() || "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (evt.type === "reset") { acc = ""; paint(); }
          else if (evt.type === "delta") { acc += evt.text || ""; ensureBubble(); paint(); }
          else if (evt.type === "done") { done = evt; }
          else if (evt.type === "error") { acc = evt.message || "Sorry, I'm having trouble right now. Please try again."; ensureBubble(); paint(); }
        }
      }
    } catch (e) {
      // Mid-stream failure: if nothing arrived, drop the bubble (if one was
      // ever created) + its history entry and signal fallback; else keep text.
      if (!acc && !done) {
        if (msgEl) { msgEl.remove(); state.history.pop(); saveState(); }
        return false;
      }
    }

    // Finalize with the authoritative text + extras from the done frame.
    if (done) {
      if (done.serviceStopped) { acc = done.message || done.response || acc; }
      else if (done.response) { acc = done.response; }
      ensureBubble(); // stream may finish with only a done frame (no deltas)
      paint();
      // Persist so refresh/reopen restores cards + chips (addMessage only stored the shell).
      const last = state.history[state.history.length - 1];
      if (last && last.role === "assistant") {
        last.content = acc;
        last.products = done.products || [];
        last.followups = done.followups || [];
        saveState();
      }
      if (!done.serviceStopped) {
        if (done.cartAdd) performCartAdd(done.cartAdd);
        if (done.products && done.products.length) renderProductCarousel(done.products);
        if (done.followups && done.followups.length) renderFollowups(done.followups);
      }
    } else if (acc) {
      // Stream ended without a done frame but we have text — keep it.
      const last = state.history[state.history.length - 1];
      if (last && last.role === "assistant") { last.content = acc; saveState(); }
    } else {
      // Stream closed without ever sending anything — typing is still up and
      // no bubble exists; signal fallback so the blocking POST takes over.
      return false;
    }
    return true;
  }

  function updateCartUI(cartData) {
    const itemCount = cartData.item_count;

    // 1. Dispatch multiple events that different themes listen to
    const events = [
      "cart:updated",
      "cart:refresh",
      "cart:change",
      "ajaxProduct:added",
      "product:added"
    ];

    events.forEach(eventName => {
      document.dispatchEvent(
        new CustomEvent(eventName, {
          bubbles: true,
          detail: { cart: cartData }
        })
      );
    });

    // 2. Update cart count elements with expanded selectors
    const countSelectors = [
      "[data-cart-count]",
      "[data-cart-item-count]",
      ".cart-count",
      ".cart-count-bubble",
      ".cart-count-bubble span",
      ".cart-item-count",
      ".js-cart-count",
      "#cart-icon-bubble span",
      ".header__cart-count",
      ".site-header__cart-count",
      "[data-header-cart-count]",
      ".cart-link__count",
      ".cart__count"
    ];

    countSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        el.textContent = itemCount;
        // Make sure hidden bubbles are shown when count > 0
        if (itemCount > 0) {
          el.style.display = "";
          el.removeAttribute("hidden");
          el.classList.remove("hidden", "hide", "visually-hidden");
        }
      });
    });

    // 3. Show cart bubble containers that might be hidden when empty
    const bubbleContainers = document.querySelectorAll(
      ".cart-count-bubble, .cart-count-wrapper, [data-cart-bubble]"
    );
    bubbleContainers.forEach(el => {
      if (itemCount > 0) {
        el.style.display = "";
        el.removeAttribute("hidden");
        el.classList.remove("hidden", "hide", "visually-hidden");
      }
    });

    // 4. Try to refresh header section (Dawn and OS 2.0 themes). Some themes'
    // own cart-icon component re-renders itself from its OWN (still-stale at
    // that instant) internal state right after our swap, silently reverting
    // it — observed live: count stayed at the old value after a real add.
    // A second pass a beat later reliably wins that race.
    refreshCartSection();
    setTimeout(refreshCartSection, 900);
  }

  async function refreshCartSection() {
    const root = getShopifyRoot();

    // Section ids are theme/store-generated (e.g. Shopify's newest "Horizon"
    // theme names them "sections--<numeric>__header_section", not "header") —
    // a hardcoded guess list silently matched nothing on this store, so the
    // cart icon/drawer never updated without a reload (live bug report,
    // 2026-07-08). Discover the REAL ids actually rendered on this page instead.
    const sectionIds = Array.from(document.querySelectorAll('[id^="shopify-section-"]'))
      .map((el) => el.id.replace("shopify-section-", ""))
      .filter((id) => /cart|header/i.test(id));
    if (!sectionIds.length) return;

    try {
      // Use Section Rendering API to refresh cart sections
      const sectionsParam = sectionIds.join(",");
      const response = await fetch(`${root}?sections=${sectionsParam}`);

      if (response.ok) {
        const sections = await response.json();
        const parser = new DOMParser();
        // Only swap known cart-icon/bubble sub-elements, never the whole
        // section: this theme's nav/search/logo are built by client JS that
        // doesn't survive a full innerHTML replace (live bug: badge count
        // updated correctly but the entire header nav vanished). Scoped to
        // what the shopper actually looks at — the cart icon/count.
        const CART_SELECTORS = [
          "cart-icon", ".cart-icon", ".cart-bubble", ".cart-count-bubble",
          "[data-cart-icon]", "#cart-icon-bubble",
          // Drawer line items + totals — the badge count updated but the
          // drawer itself kept showing the pre-add items/total until reload
          // (live bug report, 2026-07-08): these live in separate elements
          // from the icon and need their own swap.
          "cart-items-component", ".cart-totals",
        ];

        Object.entries(sections).forEach(([sectionId, html]) => {
          const liveEl = document.getElementById(`shopify-section-${sectionId}`);
          if (!liveEl || !html) return;
          const freshDoc = parser.parseFromString(html, "text/html");
          CART_SELECTORS.forEach((sel) => {
            const freshNodes = freshDoc.querySelectorAll(sel);
            const liveNodes = liveEl.querySelectorAll(sel);
            freshNodes.forEach((freshNode, i) => {
              const liveNode = liveNodes[i];
              if (liveNode && liveNode.parentNode) liveNode.replaceWith(freshNode.cloneNode(true));
            });
          });
        });
      }
    } catch (e) {
      // Silently fail - section refresh is a nice-to-have
    }
  }

  function showInChatNotification(product, cartData) {
    // Remove any existing toast
    const existingToast = chat.querySelector(".saleshq-cart-toast");
    if (existingToast) existingToast.remove();

    const root = getShopifyRoot();
    // Was product.image (undefined — ProductCard's real field is imageUrl) —
    // always fell through to a via.placeholder.com URL, which renders broken
    // (live bug report, 2026-07-08).
    const placeholderImg = product.imageUrl || "https://via.placeholder.com/50x50/f5f5f5/999?text=+";

    const toast = document.createElement("div");
    toast.className = "saleshq-cart-toast";
    toast.innerHTML = `
      <div class="saleshq-cart-toast-header">
        <div class="saleshq-cart-toast-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
        <div class="saleshq-cart-toast-title">Added to cart</div>
      </div>
      <div class="saleshq-cart-toast-product">
        <img class="saleshq-cart-toast-img" src="${placeholderImg}" alt="${product.title || 'Product'}" />
        <div class="saleshq-cart-toast-info">
          <div class="saleshq-cart-toast-name">${product.title || 'Product'}</div>
          <div class="saleshq-cart-toast-price">₹${product.price ?? '0'}</div>
        </div>
      </div>
      <div class="saleshq-cart-toast-actions">
        <button class="saleshq-cart-toast-btn saleshq-cart-toast-btn--secondary" data-dismiss>
          Continue
        </button>
        <a href="${root}cart" class="saleshq-cart-toast-btn saleshq-cart-toast-btn--primary">
          View Cart (${cartData.item_count})
        </a>
      </div>
    `;

    // Add dismiss handler
    const dismissBtn = toast.querySelector("[data-dismiss]");
    dismissBtn.onclick = () => toast.remove();

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.animation = "saleshq-fade-out 0.2s ease-out forwards";
        setTimeout(() => toast.remove(), 200);
      }
    }, 5000);

    chat.appendChild(toast);
  }

  async function showCartNotification(addedItems, cartData) {
    const root = getShopifyRoot();

    // Get the first added item for display
    const addedItem = addedItems.items?.[0] || addedItems;

    // Dispatch events that themes might listen to for showing popup
    const popupEvents = [
      { name: "ajaxCart.itemAdded", detail: { item: addedItem, cart: cartData } },
      { name: "cart:item-added", detail: { item: addedItem, cart: cartData } },
      { name: "product-added-to-cart", detail: { item: addedItem, cart: cartData } },
      { name: "cart-popup:open", detail: { item: addedItem, cart: cartData } }
    ];

    popupEvents.forEach(({ name, detail }) => {
      document.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
      document.body.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
    });

    // 1. Try cart-popup-wrapper (Debut, Brooklyn, and similar themes)
    const cartPopup = document.querySelector(
      ".cart-popup-wrapper, [data-cart-popup-wrapper]"
    );

    if (cartPopup) {
      // Update popup content with added product info
      const titleEl = cartPopup.querySelector("[data-cart-popup-title]");
      const imageEl = cartPopup.querySelector("[data-cart-popup-image]");
      const qtyEl = cartPopup.querySelector("[data-cart-popup-quantity]");
      const cartQtyEl = cartPopup.querySelector("[data-cart-popup-cart-quantity]");

      if (titleEl) titleEl.textContent = addedItem.title || addedItem.product_title || "";
      if (imageEl && addedItem.image) imageEl.src = addedItem.image;
      if (imageEl && addedItem.featured_image?.url) imageEl.src = addedItem.featured_image.url;
      if (qtyEl) qtyEl.textContent = addedItem.quantity || 1;
      if (cartQtyEl) cartQtyEl.textContent = cartData.item_count;

      // Show the popup - remove hidden classes and add active class
      cartPopup.classList.add("is-active");
      cartPopup.classList.remove("cart-popup-wrapper--hidden", "hide", "hidden");
      cartPopup.style.display = "";
      cartPopup.removeAttribute("hidden");
      cartPopup.setAttribute("aria-hidden", "false");

      // Also show the inner popup element
      const innerPopup = cartPopup.querySelector(".cart-popup, [data-cart-popup]");
      if (innerPopup) {
        innerPopup.classList.add("is-active");
        innerPopup.classList.remove("hide", "hidden");
        innerPopup.style.display = "";
      }

      // Focus for accessibility
      cartPopup.focus();

      return;
    }

    // 2. Try Dawn theme cart-notification section
    try {
      const sectionUrl = `${root}?sections=cart-notification`;
      const sectionRes = await fetch(sectionUrl);

      if (sectionRes.ok) {
        const sections = await sectionRes.json();
        const notificationHtml = sections["cart-notification"];

        if (notificationHtml) {
          let notificationSection = document.getElementById("shopify-section-cart-notification");
          
          if (notificationSection) {
            notificationSection.innerHTML = notificationHtml;
          } else {
            notificationSection = document.createElement("div");
            notificationSection.id = "shopify-section-cart-notification";
            notificationSection.className = "shopify-section";
            notificationSection.innerHTML = notificationHtml;
            document.body.appendChild(notificationSection);
          }

          const notification = notificationSection.querySelector("cart-notification") ||
                               notificationSection.querySelector("[data-cart-notification]") ||
                               notificationSection.querySelector(".cart-notification");

          if (notification) {
            if (typeof notification.open === "function") {
              notification.open();
            } else if (notification.classList) {
              notification.classList.add("active", "is-open");
              notification.removeAttribute("hidden");
              notification.style.display = "";
            }
            return;
          }
        }
      }
    } catch (e) {
      // Fall through to fallback methods
    }

    // 3. Fallback: Try to trigger existing cart notification
    const existingNotification = document.querySelector(
      "cart-notification, .cart-notification, [data-cart-notification]"
    );

    if (existingNotification) {
      if (typeof existingNotification.open === "function") {
        existingNotification.open();
        return;
      } else {
        existingNotification.classList.add("active", "is-open");
        existingNotification.removeAttribute("hidden");
        existingNotification.style.display = "";
        return;
      }
    }

    // 4. Fallback: Open cart drawer instead
    openCartDrawer();
  }

  function openCartDrawer() {
    // 1. Dawn & modern themes: cart drawer custom event
    document.dispatchEvent(new CustomEvent("cart:open"));
  
    // 2️⃣ Dawn / Online Store 2.0 drawer toggle
    const cartToggleSelectors = [
      'button[name="cart"]',
      '[aria-controls="cart-drawer"]',
      '.header__icon--cart',
      'a[href="#cart-drawer"]',
      '.cart-drawer-toggle'
    ];
  
    for (const selector of cartToggleSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        el.click();
        return;
      }
    }
  
    // 3️⃣ Theme JS fallback (no redirect)
    if (window.Shopify && window.Shopify.theme && window.Shopify.theme.cartDrawer) {
      window.Shopify.theme.cartDrawer.open();
    }
  }
  
  

})();

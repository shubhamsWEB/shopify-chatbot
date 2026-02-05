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
          history: parsed.history || []
        };
      }
    } catch (e) {
      // Ignore parse errors
    }
    return { open: false, history: [] };
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
    .saleshq-input:focus {
      outline: none;
      border-color: #1a1a1a !important;
      background: #fff !important;
    }
    .saleshq-send-btn:hover {
      background: #333 !important;
    }
    .saleshq-send-btn:active {
      transform: scale(0.95);
    }
    .saleshq-msg-enter {
      animation: saleshq-fade-in 0.3s ease-out forwards;
    }
    .saleshq-close-btn:hover {
      background: rgba(255,255,255,0.1) !important;
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
      background: #1a1a1a;
      color: #fff;
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
      background: #333;
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
      background: #1a1a1a;
      color: #fff;
      border: none;
    }
    .saleshq-cart-toast-btn--primary:hover {
      background: #333;
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
  const chatIconSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  `;

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

  /* Chevron left icon SVG */
  const chevronLeftSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  `;

  /* Chevron right icon SVG */
  const chevronRightSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  `;

  /* Floating Button */
  const button = document.createElement("div");
  button.className = "saleshq-btn";
  button.innerHTML = chatIconSvg;
  button.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 60px;
    height: 60px;
    background: linear-gradient(135deg, #1a1a1a 0%, #333 100%);
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  `;

  /* Chat Box */
  const chat = document.createElement("div");
  chat.style.cssText = `
    position: fixed;
    bottom: 100px;
    right: 24px;
    width: 380px;
    height: 520px;
    background: #fff;
    border-radius: 20px;
    box-shadow: 0 12px 50px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05);
    display: none;
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
    flex-direction: column;
  `;

  chat.innerHTML = `
    <div style="
      padding: 18px 20px;
      background: linear-gradient(135deg, #1a1a1a 0%, #333 100%);
      color: white;
      display: flex;
      align-items: center;
      justify-content: space-between;
    ">
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="
          width: 10px;
          height: 10px;
          background: #4ade80;
          border-radius: 50%;
          box-shadow: 0 0 8px rgba(74, 222, 128, 0.6);
        "></div>
        <div>
          <div style="font-weight: 600; font-size: 15px; letter-spacing: -0.3px;">SalesHQ Assistant</div>
          <div style="font-size: 12px; opacity: 0.8; margin-top: 2px;">Always here to help</div>
        </div>
      </div>
      <button id="saleshq-close" class="saleshq-close-btn" style="
        background: transparent;
        border: none;
        color: white;
        cursor: pointer;
        padding: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        transition: background 0.2s;
      ">
        ${closeIconSvg}
      </button>
    </div>
    <div id="saleshq-messages" style="
      flex: 1;
      padding: 20px;
      overflow-y: auto;
      overflow-x: hidden;
      background: #f8f9fa;
      scroll-behavior: smooth;
    "></div>
    <form id="saleshq-form" style="
      display: flex;
      align-items: center;
      padding: 14px 16px;
      gap: 10px;
      background: #fff;
      border-top: 1px solid #eee;
    ">
      <input
        id="saleshq-input"
        class="saleshq-input"
        placeholder="Type your message..."
        autocomplete="off"
        style="
          flex: 1;
          border: 1px solid #e5e5e5;
          padding: 12px 16px;
          border-radius: 24px;
          font-size: 14px;
          transition: all 0.2s;
          background: #f8f9fa;
        "
      />
      <button type="submit" class="saleshq-send-btn" style="
        width: 42px;
        height: 42px;
        border: none;
        background: #1a1a1a;
        color: white;
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
  `;

  function toggleChat() {
    state.open = !state.open;
    saveState();
    if (state.open) {
      chat.style.display = "flex";
      chat.style.animation = "saleshq-fade-in 0.3s ease-out forwards";
      button.innerHTML = closeIconSvg;
    } else {
      chat.style.animation = "saleshq-fade-out 0.2s ease-out forwards";
      button.innerHTML = chatIconSvg;
      setTimeout(() => {
        chat.style.display = "none";
      }, 200);
    }
  }

  button.onclick = toggleChat;

  document.body.appendChild(button);
  document.body.appendChild(chat);

  const messagesEl = chat.querySelector("#saleshq-messages");
  const form = chat.querySelector("#saleshq-form");
  const input = chat.querySelector("#saleshq-input");
  const closeBtn = chat.querySelector("#saleshq-close");

  closeBtn.onclick = toggleChat;

  /* Restore previous messages or show welcome */
  function restoreMessages() {
    if (state.history.length > 0) {
      // Restore messages without re-saving to state
      state.history.forEach(({ role, content }) => {
        const msg = document.createElement("div");
        msg.style.cssText = `
          margin-bottom: 14px;
          display: flex;
          justify-content: ${role === "user" ? "flex-end" : "flex-start"};
        `;
        const isUser = role === "user";
        const formattedText = parseMarkdown(content);
        msg.innerHTML = `
          <div style="
            display: inline-block;
            padding: 12px 16px;
            border-radius: ${isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px"};
            background: ${isUser ? "linear-gradient(135deg, #1a1a1a 0%, #333 100%)" : "#fff"};
            color: ${isUser ? "#fff" : "#1a1a1a"};
            max-width: 80%;
            font-size: 14px;
            line-height: 1.5;
            box-shadow: ${isUser ? "none" : "0 2px 8px rgba(0,0,0,0.06)"};
            word-wrap: break-word;
          ">
            ${formattedText}
          </div>
        `;
        messagesEl.appendChild(msg);
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      // Show welcome message for new conversations
      addMessage("assistant", "Hi there! How can I help you today?");
    }
  }

  /* Restore open state if previously open */
  if (state.open) {
    chat.style.display = "flex";
    button.innerHTML = closeIconSvg;
  }

  restoreMessages();

  /* Parse markdown to HTML */
  function parseMarkdown(text) {
    return text
      // Escape HTML first to prevent XSS
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // Bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      // Italic: *text* or _text_
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/_(.+?)_/g, "<em>$1</em>")
      // Line breaks
      .replace(/\n/g, "<br>");
  }

  function addMessage(role, text) {
    const msg = document.createElement("div");
    msg.className = "saleshq-msg-enter";
    msg.style.cssText = `
      margin-bottom: 14px;
      display: flex;
      justify-content: ${role === "user" ? "flex-end" : "flex-start"};
    `;

    const isUser = role === "user";
    const formattedText = parseMarkdown(text);
    msg.innerHTML = `
      <div style="
        display: inline-block;
        padding: 12px 16px;
        border-radius: ${isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px"};
        background: ${isUser ? "linear-gradient(135deg, #1a1a1a 0%, #333 100%)" : "#fff"};
        color: ${isUser ? "#fff" : "#1a1a1a"};
        max-width: 80%;
        font-size: 14px;
        line-height: 1.5;
        box-shadow: ${isUser ? "none" : "0 2px 8px rgba(0,0,0,0.06)"};
        word-wrap: break-word;
      ">
        ${formattedText}
      </div>
    `;
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    state.history.push({ role, content: text });
    saveState();
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

    const placeholderImg = product.image || "https://via.placeholder.com/200x140/f5f5f5/999?text=Product";

    card.innerHTML = `
      <img
        src="${placeholderImg}"
        alt="${product.title || 'Product'}"
        style="
          width: 100%;
          height: 120px;
          object-fit: cover;
        "
      />
      <div style="padding: 12px;">
        <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px; line-height: 1.3;">
          ${product.title || 'Product'}
        </div>
        <div style="font-weight: 700; font-size: 14px; margin-bottom: 10px;">
          ₹${product.price?.amount || '0'}
        </div>
        <button
          class="saleshq-add-to-cart"
          style="
            width: 100%;
            padding: 10px;
            border-radius: 8px;
            border: none;
            background: #1a1a1a;
            color: white;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
          "
        >
          Add to Cart
        </button>
      </div>
    `;

    const addBtn = card.querySelector(".saleshq-add-to-cart");
    addBtn.onclick = () => {
      handleAddToCart(addBtn, product);
      document.dispatchEvent(new Event("cart:build"));
    };

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

      button.innerText = "Added ✓";
      button.style.background = "#16a34a";
  
      setTimeout(() => {
        button.innerText = "Add to Cart";
        button.style.background = "#1a1a1a";
        button.disabled = false;
        button.style.opacity = "1";
        button.dataset.loading = "false";
      }, 1500);
    } catch (err) {
      button.innerText = "Error";
      button.style.background = "#dc2626";
  
      setTimeout(() => {
        button.innerText = "Add to Cart";
        button.style.background = "#1a1a1a";
        button.disabled = false;
        button.style.opacity = "1";
        button.dataset.loading = "false";
      }, 1500);
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

    addMessage("user", text);
    input.value = "";

    const typingEl = showTypingIndicator();

    try {
      const res = await fetch(
        "https://replifyai-server.vercel.app/api/customer/query",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            query: text,
            conversationHistory: state.history
          })
        }
      );

      const data = await res.json();

      typingEl.remove();

      addMessage("assistant", data.response);

if (
  data.intent?.type === "product_inquiry" &&
  data.recommendations &&
  data.recommendations.products &&
  data.recommendations.products.length
) {
  renderProductCarousel(data.recommendations.products);
}

// Show suggested follow-up questions
if (data.suggestedFollowups && data.suggestedFollowups.length) {
  renderFollowups(data.suggestedFollowups);
}
    } catch (err) {
      typingEl.remove();
      addMessage(
        "assistant",
        "Sorry, I'm having trouble right now. Please try again."
      );
    }
  };

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

    // 4. Try to refresh header section (Dawn and OS 2.0 themes)
    refreshCartSection();
  }

  async function refreshCartSection() {
    const root = getShopifyRoot();
    
    // Common section IDs for cart in different themes
    const sectionIds = [
      "cart-icon-bubble",
      "cart-drawer",
      "header",
      "cart-notification"
    ];

    try {
      // Use Section Rendering API to refresh cart sections
      const sectionsParam = sectionIds.join(",");
      const response = await fetch(`${root}?sections=${sectionsParam}`);
      
      if (response.ok) {
        const sections = await response.json();
        
        Object.entries(sections).forEach(([sectionId, html]) => {
          const sectionEl = document.getElementById(`shopify-section-${sectionId}`);
          if (sectionEl && html) {
            sectionEl.innerHTML = html;
          }
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
    const placeholderImg = product.image || "https://via.placeholder.com/50x50/f5f5f5/999?text=+";

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
          <div class="saleshq-cart-toast-price">₹${product.price?.amount || '0'}</div>
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

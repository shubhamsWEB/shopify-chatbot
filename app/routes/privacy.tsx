// Public privacy policy (required for the App Store listing). Static content.
export default function PrivacyPolicy() {
  return (
    <main style={{ maxWidth: 760, margin: "40px auto", padding: "0 20px", fontFamily: "Inter, system-ui, sans-serif", lineHeight: 1.6, color: "#1f2937" }}>
      <h1>SalesHQ Chatbot — Privacy Policy</h1>
      <p><em>Last updated: 2026-06-28</em></p>

      <h2>What we collect</h2>
      <p>
        When a merchant installs SalesHQ and a shopper consents to analytics tracking, we collect storefront
        behavioral events (page and product views, searches, cart and checkout activity) and derive shopper-intent
        profiles used to power the chat assistant and product recommendations. We do not collect payment card data.
      </p>

      <h2>Consent</h2>
      <p>
        Tracking runs only when the shopper has granted analytics consent via Shopify’s Customer Privacy API. Without
        consent the chat assistant still answers questions but no behavioral data is stored and no tracking cookie is set.
      </p>

      <h2>How data is used</h2>
      <p>
        Data is used solely to operate the assistant for the merchant whose store it was collected on. Data is isolated
        per shop and is never shared across merchants or sold to third parties. Messages may be processed by our AI
        provider (Anthropic) to generate responses.
      </p>

      <h2>Retention &amp; deletion</h2>
      <p>
        Hot session data expires automatically. All data for a shop is deleted when the app is uninstalled and via
        Shopify’s GDPR webhooks (<code>customers/redact</code>, <code>shop/redact</code>). Merchants can also export or
        erase an individual customer’s data from the app’s Compliance page.
      </p>

      <h2>Contact</h2>
      <p>For privacy requests, contact <a href="mailto:shubhama664@gmail.com">shubhama664@gmail.com</a>.</p>
    </main>
  );
}

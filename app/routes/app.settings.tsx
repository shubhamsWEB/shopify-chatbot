// Bot settings admin page: brand grounding, welcome copy, and every behavior
// knob the merchant can tune — each explained in plain language. Saved per shop
// and enforced server-side (nudge gates) + in the widget (timings, cues).
import type { HeadersFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getSettings, saveSettings, normalizeConfig, normalizeSupportConfig, DEFAULT_WELCOME, type BotConfig, type SupportConfig } from "../intent/settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  return { settings, defaultWelcome: DEFAULT_WELCOME };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const config = normalizeConfig(JSON.parse(String(form.get("config") ?? "{}")));
  const support = normalizeSupportConfig(JSON.parse(String(form.get("support") ?? "{}")));
  const existing = await getSettings(session.shop);
  await saveSettings(session.shop, {
    brandDescription: String(form.get("brandDescription") ?? ""),
    welcomeMessage: String(form.get("welcomeMessage") ?? ""),
    config,
    support,
    backoffice: existing.backoffice, // developer-managed; merchant saves must not clear it
    shopInfo: existing.shopInfo, // synced from Shopify; merchant saves must not clear it
  });
  return { saved: true, at: Date.now() };
};

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px",
  border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, fontFamily: "inherit",
};
const numStyle: React.CSSProperties = { ...inputStyle, width: 110 };

function Row({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return (
    <s-box padding="small-200" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-stack direction="inline" gap="base">
          <s-text>{label}</s-text>
          {children}
        </s-stack>
        <s-text tone="neutral">{help}</s-text>
      </s-stack>
    </s-box>
  );
}

export default function Settings() {
  const { settings, defaultWelcome } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [brand, setBrand] = useState(settings.brandDescription);
  const [welcome, setWelcome] = useState(settings.welcomeMessage);
  const [cfg, setCfg] = useState<BotConfig>(settings.config);
  const [sup, setSup] = useState<SupportConfig>(settings.support);
  const busy = fetcher.state !== "idle";

  const set = (k: keyof BotConfig, v: boolean | number) => setCfg((c) => ({ ...c, [k]: v }));
  const setS = (k: keyof SupportConfig, v: boolean | string) => setSup((s) => ({ ...s, [k]: v }));
  const save = () =>
    fetcher.submit(
      { brandDescription: brand, welcomeMessage: welcome, config: JSON.stringify(cfg), support: JSON.stringify(sup) },
      { method: "post" },
    );

  const Toggle = ({ k }: { k: keyof BotConfig }) => (
    <input type="checkbox" checked={Boolean(cfg[k])} onChange={(e) => set(k, e.currentTarget.checked)} />
  );
  const Num = ({ k, min, max }: { k: keyof BotConfig; min: number; max: number }) => (
    <input
      type="number" min={min} max={max} value={Number(cfg[k])}
      onChange={(e) => set(k, Number(e.currentTarget.value))}
      style={numStyle}
    />
  );

  return (
    <s-page heading="Bot settings">
      <s-section heading="Brand & voice">
        <s-stack direction="block" gap="base">
          <s-text tone="neutral">
            A short description of your brand — voice, values, what you sell, what makes you different.
            Every reply, popup, and suggestion is grounded in this.
          </s-text>
          <textarea
            value={brand} onChange={(e) => setBrand(e.currentTarget.value)} rows={6} maxLength={2000}
            placeholder="e.g. Frido makes ergonomic comfort products — seat cushions, insoles and pillows engineered for pain relief. Friendly, health-first tone; we never oversell."
            style={{ ...inputStyle, resize: "vertical" }}
          />
          <s-text tone="neutral">{`${brand.length}/2000`}</s-text>
          <s-text tone="neutral">
            Welcome message — the chat&apos;s opening line. Leave empty for the built-in intro that lists what the
            assistant can do (find products, compare items, personalized picks, answer questions).
          </s-text>
          <textarea
            value={welcome} onChange={(e) => setWelcome(e.currentTarget.value)} rows={4} maxLength={500}
            placeholder={defaultWelcome} style={{ ...inputStyle, resize: "vertical" }}
          />
        </s-stack>
      </s-section>

      <s-section heading="Welcome popup">
        <s-stack direction="block" gap="small">
          <Row label="Auto-open the welcome" help="For fresh visitors, the chat opens itself with your welcome message and starter suggestions — once per visit, never over an existing conversation.">
            <Toggle k="welcomeEnabled" />
          </Row>
          <Row label="Welcome delay (seconds)" help="How long a new visitor browses before the welcome opens. 0 = instantly on page load; longer gives intent nudges the first word. 0–120s.">
            <Num k="welcomeDelaySec" min={0} max={120} />
          </Row>
        </s-stack>
      </s-section>

      <s-section heading="Intent nudges (auto popups)">
        <s-stack direction="block" gap="small">
          <Row label="Enable intent nudges" help="The master switch. When off, the assistant never pops up on its own — shoppers can still open the chat manually.">
            <Toggle k="proactiveEnabled" />
          </Row>
          <Row label="Grace period (seconds)" help="No nudges until a shopper has been on the site this long — let them orient first. 3–120s.">
            <Num k="minTimeOnSiteSec" min={3} max={120} />
          </Row>
          <Row label="Max popups per session" help="Hard ceiling per browsing session. The bot rarely reaches it because each nudge type also has its own cooldown. 1–99.">
            <Num k="maxPopupsPerSession" min={1} max={99} />
          </Row>
          <Row label="Same-nudge cooldown (minutes)" help="How long before the SAME kind of nudge (e.g. a comparison offer) can repeat. Different kinds can still alternate. 1–120 min.">
            <Num k="sameNudgeCooldownMin" min={1} max={120} />
          </Row>
          <Row label="Re-engage quiet chats" help="If a shopper chatted and then went silent, the assistant may follow up with a relevant nudge instead of staying quiet forever.">
            <Toggle k="idleResumeEnabled" />
          </Row>
          <Row label="Quiet time before re-engaging (seconds)" help="How long a chat must be silent (no messages, no typing) before a follow-up nudge is allowed. 20–600s.">
            <Num k="idleResumeSec" min={20} max={600} />
          </Row>
        </s-stack>
      </s-section>

      <s-section heading="Attention cues">
        <s-stack direction="block" gap="small">
          <Row label="Notification badge" help="A red badge and gentle pulse on the chat bubble when the assistant has something to say.">
            <Toggle k="badgeEnabled" />
          </Row>
          <Row label="Notification sound" help="A soft two-tone chime when a popup opens. Browsers only allow sound after the visitor's first click or scroll.">
            <Toggle k="soundEnabled" />
          </Row>
        </s-stack>
      </s-section>

      <s-section heading="Customer data & orders">
        <s-stack direction="block" gap="small">
          <Row label="Let the assistant help with orders" help="When on, a SIGNED-IN shopper can ask the assistant to track an order, see their order history, or reorder — using only their own account data. When off, the assistant never accesses any customer or order data and will point shoppers to your account page or support instead.">
            <Toggle k="customerDataEnabled" />
          </Row>
        </s-stack>
      </s-section>

      <s-section heading="Human handoff & support">
        <s-stack direction="block" gap="small">
          <Row label="Let shoppers ask for a human" help="When a shopper explicitly asks for a person, or the bot genuinely can't help, it notifies your team and tells the shopper someone will follow up. When off, none of this is offered.">
            <input type="checkbox" checked={Boolean(sup.enabled)} onChange={(e) => setS("enabled", e.currentTarget.checked)} />
          </Row>
          <Row label="Notify email (optional)" help="Where handoff and ticket notifications go. Leave blank to use your Shopify account email.">
            <input type="email" value={sup.notifyEmail ?? ""} placeholder="support@yourstore.com" onChange={(e) => setS("notifyEmail", e.currentTarget.value)} style={inputStyle} />
          </Row>
          <Row label="Generic webhook URL (optional)" help="POST a signed JSON payload of the ticket and transcript here on every handoff — wire up Zapier, Make, n8n, or your own endpoint. This is also how to reach LimeChat, which has no public API of its own.">
            <input type="url" value={sup.webhookUrl ?? ""} placeholder="https://hooks.example.com/…" onChange={(e) => setS("webhookUrl", e.currentTarget.value)} style={inputStyle} />
          </Row>
          <Row label="Webhook secret (optional)" help="Signs the payload (header X-SalesHQ-Signature) so your endpoint can verify it's really from SalesHQ.">
            <input type="text" value={sup.webhookSecret ?? ""} onChange={(e) => setS("webhookSecret", e.currentTarget.value)} style={inputStyle} />
          </Row>
          <Row label="WhatsApp number (optional)" help="Shoppers asking for a human get a WhatsApp link prefilled with their issue. Digits only with country code, e.g. 15551234567.">
            <input type="text" value={sup.whatsappNumber ?? ""} placeholder="15551234567" onChange={(e) => setS("whatsappNumber", e.currentTarget.value)} style={inputStyle} />
          </Row>
        </s-stack>
      </s-section>

      <s-section heading="Freshdesk (optional)">
        <s-stack direction="block" gap="small">
          <Row label="Connect Freshdesk" help="Creates real, trackable tickets in Freshdesk and lets the bot answer 'what's the status of my ticket'. Needs the domain and API key below.">
            <input type="checkbox" checked={Boolean(sup.freshdeskEnabled)} onChange={(e) => setS("freshdeskEnabled", e.currentTarget.checked)} />
          </Row>
          <Row label="Freshdesk domain" help="Just the subdomain — 'acme' for acme.freshdesk.com.">
            <input type="text" value={sup.freshdeskDomain ?? ""} placeholder="acme" onChange={(e) => setS("freshdeskDomain", e.currentTarget.value)} style={inputStyle} />
          </Row>
          <Row label="Freshdesk API key" help="From Freshdesk → Profile settings → Your API Key.">
            <input type="password" value={sup.freshdeskApiKey ?? ""} onChange={(e) => setS("freshdeskApiKey", e.currentTarget.value)} style={inputStyle} />
          </Row>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" onClick={save} {...(busy ? { disabled: true } : {})}>
            {busy ? "Saving…" : "Save settings"}
          </s-button>
          {fetcher.data?.saved && !busy && <s-badge tone="success">Saved</s-badge>}
        </s-stack>
        <s-text tone="neutral">Changes apply to new shopper sessions within a minute — no redeploy needed.</s-text>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
export { EmbeddedErrorBoundary as ErrorBoundary } from "../embedded-boundary";

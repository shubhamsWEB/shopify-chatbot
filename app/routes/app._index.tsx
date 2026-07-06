// D2C Overview: business-facing KPIs only — assistant/popup performance,
// shopper funnel, demand signals, and the AI guardrails/cost panel. Raw event
// plumbing stays out of sight (the analytics assistant can still query it).
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getOverview } from "../intent/analytics.server";
import { TrendChart, FunnelBars, CategoryBars, Donut } from "../components/charts";

// Theme app-embed deep link — opens the theme editor with the SalesHQ widget
// embed pre-activated so the merchant can enable it in one click (App Store
// requirement 5.1.3). UUID = the app's published theme-app-extension UUID
// (from the production asset path cdn.shopify.com/extensions/<UUID>/...), NOT
// the CLI-local `uid` in shopify.extension.toml. handle = app-embed block.
const EMBED_UUID = "019f2871-06a2-7e31-b197-4606606e6272";
const EMBED_HANDLE = "app-embed";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const deepLink = `https://${session.shop}/admin/themes/current/editor?context=apps&activateAppId=${EMBED_UUID}/${EMBED_HANDLE}`;
  return { overview: await getOverview(session.shop), embedDeepLink: deepLink };
};

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-text tone="neutral">{label}</s-text>
      <s-heading>{value}</s-heading>
      {hint ? <s-text tone="neutral">{hint}</s-text> : null}
    </s-box>
  );
}

// Equal-width KPI grid — s-stack inline wraps raggedly with 5 tiles.
function MetricGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
      {children}
    </div>
  );
}

const pct = (num: number, den: number) => (den > 0 ? `${Math.round((num / den) * 100)}%` : "—");
const REASON_LABELS: Record<string, string> = {
  product_dwell: "Lingering on a product",
  product_compare: "Comparing products",
  cart_idle: "Stalled on cart",
  browse_no_addtocart: "Browsing without carting",
  search_refinement: "Refining search",
  exit_intent: "About to leave",
};

function SetupSection({ deepLink }: { deepLink: string }) {
  return (
    <s-section heading="Set up the chat widget">
      <s-paragraph>
        <s-text tone="neutral">
          The SalesHQ assistant runs as a theme app embed. Enable it once and it appears on your storefront — no code changes needed.
        </s-text>
      </s-paragraph>
      <s-stack direction="block" gap="small">
        <s-text><b>1.</b> Click <b>Enable in theme editor</b> below — it opens your theme with the SalesHQ embed pre-selected.</s-text>
        <s-text><b>2.</b> In the theme editor sidebar, toggle <b>SalesHQ Chat Widget</b> on.</s-text>
        <s-text><b>3.</b> Click <b>Save</b>, then visit your storefront — the assistant is live.</s-text>
      </s-stack>
      <s-stack direction="inline" gap="small">
        {/* target=_top breaks out of the embedded iframe into the admin so the theme editor loads. */}
        <a href={deepLink} target="_top" rel="noreferrer" style={{ textDecoration: "none" }}>
          <s-button variant="primary">Enable in theme editor</s-button>
        </a>
      </s-stack>
    </s-section>
  );
}

export default function Overview() {
  const { overview: o, embedDeepLink } = useLoaderData<typeof loader>();
  const empty = o.totalEvents === 0;

  const popupFunnel = [
    { label: "Popups shown", count: o.popup.shown },
    { label: "Shopper replied", count: o.chat.popupReplied },
    { label: "Product clicks", count: o.popup.clicks },
    { label: "Added to cart", count: o.popup.addToCarts },
  ];

  return (
    <s-page heading="Overview">
      <s-section heading="At a glance">
        <MetricGrid>
          <Metric label="Shopper sessions" value={o.totalSessions.toLocaleString()} />
          <Metric label="Conversations" value={o.chat.conversations.toLocaleString()} hint={`${o.chat.popupInitiated} started by a popup`} />
          <Metric label="Popup reply rate" value={pct(o.chat.popupReplied, o.chat.popupInitiated)} hint="popups that turned into a chat" />
        </MetricGrid>
      </s-section>

      {empty ? (
        <>
          <s-section heading="Waiting for traffic">
            <s-paragraph>
              <s-text tone="neutral">
                No storefront activity yet. Enable the chat widget below, then browse the storefront — insights will appear here.
              </s-text>
            </s-paragraph>
          </s-section>
          <SetupSection deepLink={embedDeepLink} />
        </>
      ) : (
        <>
          <s-section heading="Assistant performance">
            <FunnelBars data={popupFunnel} />
            {o.popup.byReason.length > 0 && (
              <s-stack direction="block" gap="small">
                <s-text tone="neutral">Why popups fired:</s-text>
                <CategoryBars data={o.popup.byReason.map((r) => ({ name: REASON_LABELS[r.reason] ?? r.reason, value: r.shown }))} />
                <s-text tone="neutral">
                  {`Opt-out rate: ${pct(o.popup.dismissed, o.popup.shown)} of shoppers who saw a popup turned tips off — your trust health metric.`}
                </s-text>
              </s-stack>
            )}
          </s-section>

          <s-section heading="Store funnel (last 30 days)">
            <FunnelBars data={o.funnel} />
            <s-text tone="neutral">{`Abandoned checkouts: ${o.abandonedCheckouts.toLocaleString()}`}</s-text>
          </s-section>

          <s-section heading="Activity (last 14 days)">
            <TrendChart data={o.eventsByDay} />
          </s-section>

          <s-section heading="What shoppers want">
            <CategoryBars data={o.topCategories} />
          </s-section>

          <s-section heading="Recent conversations">
            {o.recentConversations.length === 0 ? (
              <s-paragraph><s-text tone="neutral">No conversations yet.</s-text></s-paragraph>
            ) : (
              <s-stack direction="block" gap="small">
                {o.recentConversations.map((c) => (
                  <s-box key={c.sessionId} padding="small-200" borderWidth="base" borderRadius="base">
                    <s-stack direction="inline" gap="base">
                      <s-badge tone={c.popupInitiated ? "info" : "success"}>
                        {c.popupInitiated ? "Popup-initiated" : "Shopper-initiated"}
                      </s-badge>
                      <s-badge>{`${c.messages} messages`}</s-badge>
                      <s-text tone="neutral">{new Date(c.lastActivity).toLocaleString()}</s-text>
                    </s-stack>
                    <s-text>{c.firstUserMessage ?? "(no reply yet — nudge shown)"}</s-text>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-section>

          <s-section slot="aside" heading="Top products via assistant">
            {o.topClickedProducts.length === 0 ? (
              <s-paragraph><s-text tone="neutral">No product clicks yet.</s-text></s-paragraph>
            ) : (
              <s-stack direction="block" gap="small">
                {o.topClickedProducts.map((p) => (
                  <s-stack key={p.productId} direction="inline" gap="base">
                    <s-text>{p.title}</s-text>
                    <s-badge>{`${p.clicks} clicks`}</s-badge>
                    {p.carts > 0 ? <s-badge tone="success">{`${p.carts} carted`}</s-badge> : null}
                  </s-stack>
                ))}
              </s-stack>
            )}
          </s-section>

          <s-section slot="aside" heading="Top searches">
            {o.topSearches.length === 0 ? (
              <s-paragraph><s-text tone="neutral">No searches yet.</s-text></s-paragraph>
            ) : (
              <s-stack direction="block" gap="small">
                {o.topSearches.slice(0, 8).map((s) => (
                  <s-stack key={s.name} direction="inline" gap="base">
                    <s-text>{s.name}</s-text>
                    <s-badge>{String(s.value)}</s-badge>
                  </s-stack>
                ))}
              </s-stack>
            )}
          </s-section>

          <s-section slot="aside" heading="Shopper mindset">
            <Donut data={o.queryIntentDist} />
          </s-section>

          <s-section slot="aside" heading="Guardrails & cost controls">
            <s-stack direction="block" gap="small">
              <s-text tone="neutral">Active protections keeping AI spend and shopper trust in check:</s-text>
              <s-text>• Rate limits: 20 msgs/min per shopper, 1,000/hr per store</s-text>
              <s-text>• Popups: never in the first 8s, one per trigger per 5 min, dismissal silences the session</s-text>
              <s-text>• Smooth buyers are never interrupted; popups need real intent + friction</s-text>
              <s-text>• Model tiering: light model for intent, full model only when the shopper sees output</s-text>
              <s-text>• Fail-soft: any AI failure degrades quietly — shoppers never see an error popup</s-text>
              {o.cost.actual ? (
                <s-text tone="neutral">
                  {`Metered AI usage: ${o.cost.actual.calls.toLocaleString()} model calls, ${(o.cost.actual.inputTokens / 1000).toFixed(1)}k in / ${(o.cost.actual.outputTokens / 1000).toFixed(1)}k out tokens, ${Math.round(o.cost.actual.cacheHitPct * 100)}% served from cache — $${o.cost.actual.usd.toFixed(4)} total ($${o.cost.actual.avgUsdPerCall.toFixed(4)}/call)`}
                </s-text>
              ) : (
                <s-text tone="neutral">
                  {`AI usage to date: ${o.cost.chatTurns.toLocaleString()} chat turns, ${o.cost.popupsComposed.toLocaleString()} popups, ${o.cost.profilesEnriched.toLocaleString()} intent profiles (~$${o.cost.estUsd.toFixed(2)} est.)`}
                </s-text>
              )}
            </s-stack>
          </s-section>

          <SetupSection deepLink={embedDeepLink} />
        </>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

// Shopper insights: what groups of shoppers want, and what individual active
// shoppers are trying to do right now — in plain language, no engine jargon.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { intentCohorts } from "../intent/vectors.server";
import type { IntentProfile } from "../intent/events";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const [profileRows, cohorts] = await Promise.all([
    prisma.intentProfile.findMany({ where: { shopId }, orderBy: { lastUpdated: "desc" }, take: 30 }),
    intentCohorts(shopId).catch(() => []),
  ]);
  // Only profiles with an AI-written story read well; signal-only rows are noise here.
  const profiles = profileRows
    .map((r) => ({ p: r.profile as unknown as IntentProfile, at: r.lastUpdated }))
    .filter((x) => (x.p.intentNarrative ?? "").length > 0)
    .slice(0, 12);
  return { profiles, cohorts };
};

// Plain-language labels for engine terms.
const PHASE: Record<string, string> = { browsing: "Just browsing", comparing: "Comparing options", deciding: "Close to buying" };
const MINDSET: Record<string, string> = {
  exploratory: "Exploring the store",
  targeted: "Knows what they want",
  comparing: "Weighing options",
  deal_seeking: "Hunting for a deal",
};
const intentTone = (v: number) => (v >= 0.5 ? "success" : v >= 0.3 ? "warning" : "neutral") as "success" | "warning" | "neutral";

export default function IntentProfiles() {
  const d = useLoaderData<typeof loader>();

  return (
    <s-page heading="Shopper insights">
      <s-section heading="Shopper groups">
        <s-text tone="neutral">
          Shoppers with similar goals, grouped automatically. Use these to spot demand patterns —
          e.g. a cluster of budget cushion hunters is a merchandising signal.
        </s-text>
        {d.cohorts.length === 0 ? (
          <s-paragraph><s-text tone="neutral">Not enough shopper activity yet to form groups.</s-text></s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {d.cohorts.map((c, i) => (
              <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small">
                    <s-badge tone="info">{`${c.size} shopper${c.size === 1 ? "" : "s"}`}</s-badge>
                    {c.focusCategory && <s-badge>{`Interested in ${c.focusCategory}`}</s-badge>}
                    {c.queryIntent && <s-badge>{MINDSET[c.queryIntent] ?? c.queryIntent}</s-badge>}
                    {c.priceCeiling != null && <s-badge>{`Budget ~${Math.round(c.priceCeiling)}`}</s-badge>}
                    {c.avgConversion != null && (
                      <s-badge tone={intentTone(c.avgConversion)}>{`${Math.round(c.avgConversion * 100)}% buying intent`}</s-badge>
                    )}
                  </s-stack>
                  <s-paragraph>{c.narrative}</s-paragraph>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Recent shoppers">
        <s-text tone="neutral">
          What individual shoppers were trying to do, in the assistant's own words, with the action it recommends.
        </s-text>
        {d.profiles.length === 0 ? (
          <s-paragraph><s-text tone="neutral">No shopper stories yet — they appear as visitors browse.</s-text></s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {d.profiles.map(({ p, at }, i) => (
              <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small">
                    {p.conversionScore != null && (
                      <s-badge tone={intentTone(p.conversionScore)}>{`${Math.round(p.conversionScore * 100)}% buying intent`}</s-badge>
                    )}
                    {p.decisionPhase && <s-badge tone="info">{PHASE[p.decisionPhase] ?? p.decisionPhase}</s-badge>}
                    {p.focusCategory && <s-badge>{`Looking at ${p.focusCategory}`}</s-badge>}
                    {p.priceCeiling != null && <s-badge>{`Budget ~${Math.round(p.priceCeiling)}`}</s-badge>}
                    {p.cartHesitation === "high" && <s-badge tone="warning">Hesitating at the cart</s-badge>}
                    <s-text tone="neutral">{new Date(at).toLocaleString()}</s-text>
                  </s-stack>
                  <s-paragraph>{p.intentNarrative}</s-paragraph>
                  {p.nextBestAction && <s-text tone="info">{`Assistant's move: ${p.nextBestAction}`}</s-text>}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

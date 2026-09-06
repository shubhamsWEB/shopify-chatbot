// Shopper insights: what groups of shoppers want, and what individual active
// shoppers are trying to do right now — in plain language, no engine jargon.
// Built to stay usable at 1000s of shoppers: the loader filters/aggregates
// server-side from URL params, charts summarize the filtered set, and the
// list paginates. Every filter is a plain GET param, so views are shareable.
// Charts are hand-rolled SVG donuts + CSS bars (SSR-safe, no truncated
// legends, graceful with 1 data point) rather than recharts.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { intentCohorts } from "../intent/vectors.server";
import { getShopInfo } from "../intent/settings.server";
import type { IntentProfile } from "../intent/events";

const PAGE_SIZE = 10;
// Aggregation window cap — plenty for insight, bounded for a hot loader.
const MAX_PROFILES = 500;

const readinessOf = (s: number | undefined | null) =>
  s == null ? "low" : s >= 0.6 ? "high" : s >= 0.3 ? "medium" : "low";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const url = new URL(request.url);
  const g = (k: string) => url.searchParams.get(k) ?? "";
  const days = ["7", "30", "90", "all"].includes(g("days")) ? g("days") : "30";
  const sort = ["recent", "intent", "budget"].includes(g("sort")) ? g("sort") : "recent";
  const page = Math.max(1, Number(g("page")) || 1);
  const fIntent = g("intent");
  const fPhase = g("phase");
  const fReadiness = g("readiness");
  const fCat = g("cat");
  const fHesitating = g("hesitating") === "1";

  const cutoff = days === "all" ? undefined : new Date(Date.now() - Number(days) * 86400000);
  const [profileRows, cohorts, shopInfo] = await Promise.all([
    prisma.intentProfile.findMany({
      where: { shopId, ...(cutoff ? { lastUpdated: { gte: cutoff } } : {}) },
      orderBy: { lastUpdated: "desc" },
      take: MAX_PROFILES,
    }),
    intentCohorts(shopId).catch(() => []),
    getShopInfo(shopId).catch(() => ({})),
  ]);

  // Only profiles with an AI-written story read well; signal-only rows are noise here.
  const all = profileRows
    .map((r) => ({ p: r.profile as unknown as IntentProfile, at: r.lastUpdated.toISOString() }))
    .filter((x) => (x.p.intentNarrative ?? "").length > 0);

  // Per-option counts over the WHOLE window (not the filtered set) so chips
  // show what's behind them and don't vanish while drilling in.
  const countBy = (vals: Array<string | undefined>) => {
    const m: Record<string, number> = {};
    for (const v of vals) if (v) m[v] = (m[v] ?? 0) + 1;
    return m;
  };
  const counts = {
    intent: countBy(all.map(({ p }) => p.queryIntent)),
    phase: countBy(all.map(({ p }) => p.decisionPhase)),
    readiness: countBy(all.map(({ p }) => readinessOf(p.conversionScore))),
    cat: countBy(all.map(({ p }) => p.focusCategory)),
    hesitating: all.filter(({ p }) => p.cartHesitation === "high").length,
  };
  const catOptions = Object.entries(counts.cat).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);

  const filtered = all.filter(({ p }) => {
    if (fIntent && p.queryIntent !== fIntent) return false;
    if (fPhase && p.decisionPhase !== fPhase) return false;
    if (fReadiness && readinessOf(p.conversionScore) !== fReadiness) return false;
    if (fCat && p.focusCategory !== fCat) return false;
    if (fHesitating && p.cartHesitation !== "high") return false;
    return true;
  });

  // Aggregates over the FILTERED set — charts answer "who are these shoppers".
  const dist = (m: Record<string, number>, labels: Record<string, string>) =>
    Object.entries(m).map(([k, v]) => ({ name: labels[k] ?? k, value: v })).sort((a, b) => b.value - a.value);
  const fCounts = {
    intent: countBy(filtered.map(({ p }) => p.queryIntent)),
    phase: countBy(filtered.map(({ p }) => p.decisionPhase)),
  };
  const budgets = filtered.map(({ p }) => p.priceCeiling).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
  const readiness = { high: 0, medium: 0, low: 0 };
  for (const { p } of filtered) readiness[readinessOf(p.conversionScore)]++;
  const catFiltered = countBy(filtered.map(({ p }) => p.focusCategory));

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "intent") return (b.p.conversionScore ?? 0) - (a.p.conversionScore ?? 0);
    if (sort === "budget") return (b.p.priceCeiling ?? 0) - (a.p.priceCeiling ?? 0);
    return b.at.localeCompare(a.at);
  });
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);

  return {
    cohorts,
    currency: (shopInfo as { currencyCode?: string }).currencyCode ?? "",
    total: all.length,
    matched: sorted.length,
    page: safePage,
    pages,
    profiles: sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    mindsetDist: dist(fCounts.intent, MINDSET),
    phaseDist: dist(fCounts.phase, PHASE),
    readinessDist: [
      { name: "Ready to buy", value: readiness.high },
      { name: "Warming up", value: readiness.medium },
      { name: "Early browsing", value: readiness.low },
    ].filter((x) => x.value > 0),
    topCategories: Object.entries(catFiltered).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, value]) => ({ name, value })),
    stats: {
      highIntent: readiness.high,
      hesitating: filtered.filter(({ p }) => p.cartHesitation === "high").length,
      medianBudget: budgets.length ? budgets[Math.floor(budgets.length / 2)] : null,
    },
    counts,
    catOptions,
  };
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

// Chart palette (CVD-validated) + readiness semantics.
const HUES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
const READY_COLORS: Record<string, string> = { "Ready to buy": "#0ca30c", "Warming up": "#eda100", "Early browsing": "#c9cdd3" };
const INKS = { ink: "#1a1d21", muted: "#6b7178", line: "#e3e5e8", soft: "#f6f6f7" };

/* SSR-safe donut: SVG arcs via stroke-dasharray + an HTML legend that never
   truncates. Renders fine with a single 100% slice. */
function DonutChart({ data, colors }: { data: Array<{ name: string; value: number }>; colors: string[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return <div style={{ color: INKS.muted, fontSize: 12.5, padding: "8px 0" }}>No data in this view.</div>;
  const R = 34, CIRC = 2 * Math.PI * R;
  let offset = 0;
  const gap = data.length > 1 ? 2 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ position: "relative", width: 92, height: 92, flex: "0 0 auto" }}>
        <svg width="92" height="92" viewBox="0 0 92 92" style={{ transform: "rotate(-90deg)" }}>
          {data.map((d, i) => {
            const len = Math.max((d.value / total) * CIRC - gap, 1);
            const el = (
              <circle key={d.name} cx="46" cy="46" r={R} fill="none" stroke={colors[i % colors.length]}
                strokeWidth="13" strokeDasharray={`${len} ${CIRC - len}`} strokeDashoffset={-offset} />
            );
            offset += (d.value / total) * CIRC;
            return el;
          })}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: INKS.ink, lineHeight: 1 }}>{total}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        {data.map((d, i) => (
          <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: colors[i % colors.length], flex: "0 0 auto" }} />
            <span style={{ color: INKS.ink }}>{d.name}</span>
            <span style={{ color: INKS.muted, fontWeight: 600, whiteSpace: "nowrap" }}>{d.value} · {Math.round((d.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* Horizontal labelled bars — graceful from 1 to 8 rows, no axis clutter. */
function HBars({ data }: { data: Array<{ name: string; value: number }> }) {
  if (!data.length) return <div style={{ color: INKS.muted, fontSize: 12.5, padding: "8px 0" }}>No data in this view.</div>;
  const max = data[0].value || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {data.map((d) => (
        <div key={d.name}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
            <span style={{ color: INKS.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
            <span style={{ color: INKS.muted, fontWeight: 600 }}>{d.value}</span>
          </div>
          <div style={{ height: 6, background: INKS.soft, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${Math.max((d.value / max) * 100, 4)}%`, height: "100%", background: HUES[0], borderRadius: 3 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${INKS.line}`, borderRadius: 10, padding: "12px 14px", background: "#fff" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: INKS.muted, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

/* Real chip: pill with border; active = filled dark like Polaris selected chips. */
function Chip({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "5px 12px", borderRadius: 999, cursor: "pointer",
        fontSize: 12.5, fontWeight: 550, fontFamily: "inherit", lineHeight: 1.3,
        border: `1px solid ${active ? "#1a1d21" : INKS.line}`,
        background: active ? "#1a1d21" : "#fff",
        color: active ? "#fff" : INKS.ink,
      }}
    >
      {label}
      {count != null && (
        <span style={{ fontSize: 11, fontWeight: 700, color: active ? "rgba(255,255,255,0.75)" : INKS.muted }}>{count}</span>
      )}
    </button>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <div style={{ width: 76, flex: "0 0 auto", fontSize: 12, fontWeight: 600, color: INKS.muted, paddingTop: 6 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{children}</div>
    </div>
  );
}

export default function IntentProfiles() {
  const d = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const pick = (param: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(param, value); else next.delete(param);
    if (param !== "page") next.delete("page"); // filter change resets pagination
    setParams(next, { preventScrollReset: true });
  };
  const toggle = (param: string, value: string) => pick(param, (params.get(param) ?? "") === value ? "" : value);
  const active = (k: string) => params.get(k) ?? "";
  const hasFilters = ["intent", "phase", "readiness", "cat", "hesitating"].some((k) => params.get(k));

  // Budgets in the store's own currency (₹, €, …) — never a bare number that
  // reads as dollars. Falls back to a plain number when the code is unknown.
  const fmtMoney = (v: number) => {
    try {
      if (d.currency) return new Intl.NumberFormat("en", { style: "currency", currency: d.currency, maximumFractionDigits: 0 }).format(v);
    } catch { /* unknown code → fall through */ }
    return `${d.currency ? `${d.currency} ` : ""}${Math.round(v).toLocaleString()}`;
  };

  const statTile = (label: string, value: string, hint?: string) => (
    <div style={{ border: `1px solid ${INKS.line}`, borderRadius: 10, padding: "12px 14px", background: INKS.soft }}>
      <div style={{ fontSize: 12, color: INKS.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: INKS.ink, marginTop: 4 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: INKS.muted, marginTop: 2 }}>{hint}</div>}
    </div>
  );

  return (
    <s-page heading="Shopper insights">
      {/* Overview: who is in the current view */}
      <s-section heading="Overview">
        <FilterRow label="Window">
          {[{ v: "7", l: "7 days" }, { v: "30", l: "30 days" }, { v: "90", l: "90 days" }, { v: "all", l: "All time" }].map((o) => (
            <Chip key={o.v} label={o.l} active={(active("days") || "30") === o.v} onClick={() => pick("days", o.v)} />
          ))}
        </FilterRow>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 14 }}>
          {statTile("Shoppers analyzed", String(d.matched), hasFilters ? `of ${d.total} in window` : undefined)}
          {statTile("Ready to buy", String(d.stats.highIntent), "60%+ buying intent")}
          {statTile("Hesitating at the cart", String(d.stats.hesitating), "added, then wavered")}
          {statTile("Median budget", d.stats.medianBudget != null ? fmtMoney(d.stats.medianBudget) : "—", "typical spend ceiling")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10, marginTop: 12 }}>
          <ChartCard title="Shopper mindset"><DonutChart data={d.mindsetDist} colors={HUES} /></ChartCard>
          <ChartCard title="Decision phase"><DonutChart data={d.phaseDist} colors={HUES} /></ChartCard>
          <ChartCard title="Purchase readiness">
            <DonutChart data={d.readinessDist} colors={d.readinessDist.map((x) => READY_COLORS[x.name] ?? HUES[0])} />
          </ChartCard>
          <ChartCard title="Most-wanted categories"><HBars data={d.topCategories} /></ChartCard>
        </div>
      </s-section>

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
                    {c.priceCeiling != null && <s-badge>{`Budget ~${fmtMoney(c.priceCeiling)}`}</s-badge>}
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

      <s-section heading="Shoppers">
        <s-text tone="neutral">
          Individual shoppers in the assistant&apos;s own words, with the action it recommends.
          Combine filters to find the ones that matter — e.g. ready-to-buy shoppers hesitating at the cart.
        </s-text>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0 16px" }}>
          <FilterRow label="Mindset">
            {Object.entries(MINDSET).map(([v, l]) => (
              <Chip key={v} label={l} count={d.counts.intent[v] ?? 0} active={active("intent") === v} onClick={() => toggle("intent", v)} />
            ))}
          </FilterRow>
          <FilterRow label="Phase">
            {Object.entries(PHASE).map(([v, l]) => (
              <Chip key={v} label={l} count={d.counts.phase[v] ?? 0} active={active("phase") === v} onClick={() => toggle("phase", v)} />
            ))}
          </FilterRow>
          <FilterRow label="Readiness">
            {[{ v: "high", l: "Ready to buy" }, { v: "medium", l: "Warming up" }, { v: "low", l: "Early browsing" }].map((o) => (
              <Chip key={o.v} label={o.l} count={d.counts.readiness[o.v] ?? 0} active={active("readiness") === o.v} onClick={() => toggle("readiness", o.v)} />
            ))}
            <Chip label="Hesitating at the cart" count={d.counts.hesitating} active={active("hesitating") === "1"} onClick={() => toggle("hesitating", "1")} />
          </FilterRow>
          {d.catOptions.length > 0 && (
            <FilterRow label="Category">
              {d.catOptions.map((c) => (
                <Chip key={c} label={c} count={d.counts.cat[c] ?? 0} active={active("cat") === c} onClick={() => toggle("cat", c)} />
              ))}
            </FilterRow>
          )}
          <FilterRow label="Sort by">
            {[{ v: "recent", l: "Most recent" }, { v: "intent", l: "Highest intent" }, { v: "budget", l: "Highest budget" }].map((o) => (
              <Chip key={o.v} label={o.l} active={(active("sort") || "recent") === o.v} onClick={() => pick("sort", o.v)} />
            ))}
            {hasFilters && (
              <button
                type="button"
                onClick={() => setParams(new URLSearchParams(active("days") ? { days: active("days") } : {}), { preventScrollReset: true })}
                style={{ border: "none", background: "none", color: "#c5280c", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: "5px 6px", fontFamily: "inherit" }}
              >
                Clear filters
              </button>
            )}
          </FilterRow>
        </div>

        {d.profiles.length === 0 ? (
          <s-paragraph>
            <s-text tone="neutral">
              {d.total === 0 ? "No shopper stories yet — they appear as visitors browse." : "No shoppers match these filters."}
            </s-text>
          </s-paragraph>
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
                    {p.priceCeiling != null && <s-badge>{`Budget ~${fmtMoney(p.priceCeiling)}`}</s-badge>}
                    {p.cartHesitation === "high" && <s-badge tone="warning">Hesitating at the cart</s-badge>}
                    <s-text tone="neutral">{new Date(at).toLocaleString()}</s-text>
                  </s-stack>
                  <s-paragraph>{p.intentNarrative}</s-paragraph>
                  {p.nextBestAction && <s-text tone="info">{`Assistant's move: ${p.nextBestAction}`}</s-text>}
                </s-stack>
              </s-box>
            ))}
            {d.pages > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Chip label="Previous" active={false} onClick={() => d.page > 1 && pick("page", String(d.page - 1))} />
                <span style={{ fontSize: 12.5, color: INKS.muted }}>{`Page ${d.page} of ${d.pages} · ${d.matched} shoppers`}</span>
                <Chip label="Next" active={false} onClick={() => d.page < d.pages && pick("page", String(d.page + 1))} />
              </div>
            )}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
export { EmbeddedErrorBoundary as ErrorBoundary } from "../embedded-boundary";

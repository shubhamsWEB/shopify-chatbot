// Analytics assistant — the merchant asks questions about their shopper-intent
// data in natural language; we answer GROUNDED in their store's analytics bundle.
// The model may also pick ONE dataset to chart; we resolve that to real data
// server-side (so the chart is always grounded, never hallucinated).
import { toolCall, SONNET } from "./claude.server";
import { getAnalyticsBundle } from "./analytics.server";
import type { ChartSpec } from "../components/charts";

const DATASETS = ["none", "funnel", "activity", "categories", "searches", "query_intent", "decision_phase", "cohorts"] as const;
type Dataset = (typeof DATASETS)[number];

const SYSTEM = (data: unknown) =>
  `You are an analytics assistant for a Shopify merchant. Answer questions about their store's shopper-intent analytics, using ONLY the data provided below.

RULES:
- Ground every number in the data. Never invent figures. If the data doesn't cover the question, say what's missing.
- Be concise and decisive. Lead with the answer, then 1-2 supporting facts. Surface ACTIONABLE insight (who to target, what converts, where shoppers drop off, price ceilings, contradictions). Short markdown (bold numbers, compact tables/bullets).
- chartDataset: if a chart would strengthen the answer, set it to the most relevant dataset; otherwise "none". funnel=conversion funnel, activity=14-day trend, categories=top categories, searches=top searches, query_intent=intent mix, decision_phase=phase mix, cohorts=cohort sizes.

STORE ANALYTICS DATA (JSON):
${JSON.stringify(data)}`;

type Bundle = Awaited<ReturnType<typeof getAnalyticsBundle>>;

function resolveChart(dataset: Dataset, b: Bundle): ChartSpec | undefined {
  const o = b.overview;
  switch (dataset) {
    case "funnel":
      return { kind: "bar", title: "Conversion funnel", data: o.funnel.map((f) => ({ name: f.label, value: f.count })) };
    case "activity":
      return { kind: "line", title: "Activity (last 14 days)", data: o.eventsByDay, xKey: "day", series: ["events", "carts", "orders"] };
    case "categories":
      return { kind: "bar", title: "Top categories", data: o.topCategories };
    case "searches":
      return { kind: "bar", title: "Top searches", data: o.topSearches };
    case "query_intent":
      return o.queryIntentDist.length ? { kind: "pie", title: "Query intent mix", data: o.queryIntentDist } : undefined;
    case "decision_phase":
      return o.decisionPhaseDist.length ? { kind: "pie", title: "Decision phase mix", data: o.decisionPhaseDist } : undefined;
    case "cohorts":
      return b.cohorts.length
        ? { kind: "bar", title: "Cohort sizes", data: b.cohorts.map((c) => ({ name: c.focusCategory || c.queryIntent || "cohort", value: c.size })) }
        : undefined;
    default:
      return undefined;
  }
}

export async function askAnalyst(
  shopId: string,
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<{ answer: string; chart?: ChartSpec }> {
  const data = await getAnalyticsBundle(shopId);
  const histText = history.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");

  const out = await toolCall<{ answer: string; chartDataset?: Dataset }>({
    model: SONNET,
    system: SYSTEM(data),
    user: `${histText ? `Conversation so far:\n${histText}\n\n` : ""}Merchant question: ${question}`,
    toolName: "answer",
    toolDescription: "Answer the merchant grounded in the analytics, optionally picking a dataset to chart.",
    maxTokens: 1024,
    schema: {
      properties: {
        answer: { type: "string", description: "Concise, actionable markdown answer." },
        chartDataset: { type: "string", enum: [...DATASETS] },
      },
      required: ["answer"],
    },
  });

  const chart = out.chartDataset && out.chartDataset !== "none" ? resolveChart(out.chartDataset, data) : undefined;
  return { answer: out.answer, chart };
}

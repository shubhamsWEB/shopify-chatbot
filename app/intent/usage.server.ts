// Real LLM usage metering: every model call reports response.usage here, and
// the dashboard reads day-level aggregates. Fail-soft — metering must never
// break a shopper turn. Table created lazily (no prod DDL step).
import prisma from "../db.server";

// $ per 1M tokens. Cache: writes bill at 1.25x input, reads at 0.1x input.
// Sonnet 5 intro pricing ($2/$10) runs through 2026-08-31, then $3/$15.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  // Gemini Flash — used for one-off PDF→OKF extraction (knowledge uploads).
  // 3-flash priced as a ceiling until GA pricing is confirmed.
  "gemini-3-flash-preview": { in: 0.5, out: 3 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
};
const priceFor = (model: string) =>
  PRICES[model] ??
  (model.includes("gemini") ? PRICES["gemini-2.5-flash"] : model.includes("haiku") ? PRICES["claude-haiku-4-5"] : PRICES["claude-sonnet-5"]);

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= prisma
    .$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "LlmUsage" (
        "shop" TEXT NOT NULL,
        "day" DATE NOT NULL,
        "model" TEXT NOT NULL,
        "calls" INTEGER NOT NULL DEFAULT 0,
        "inputTokens" INTEGER NOT NULL DEFAULT 0,
        "outputTokens" INTEGER NOT NULL DEFAULT 0,
        "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
        "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
        "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
        PRIMARY KEY ("shop", "day", "model")
      )`,
    )
    .then(() => undefined)
    .catch((e) => {
      tableReady = null;
      throw e;
    });
  return tableReady;
}

export function costOf(model: string, u: UsageLike): number {
  const p = priceFor(model);
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  return (
    (u.input_tokens / 1e6) * p.in +
    (read / 1e6) * p.in * 0.1 +
    (write / 1e6) * p.in * 1.25 +
    (u.output_tokens / 1e6) * p.out
  );
}

/** Fire-and-forget from call sites — never throws into the request. */
export function recordUsage(shop: string, model: string, u: UsageLike): void {
  const cost = costOf(model, u);
  ensureTable()
    .then(() =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "LlmUsage" ("shop", "day", "model", "calls", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd")
         VALUES ($1, CURRENT_DATE, $2, 1, $3, $4, $5, $6, $7)
         ON CONFLICT ("shop", "day", "model") DO UPDATE SET
           "calls" = "LlmUsage"."calls" + 1,
           "inputTokens" = "LlmUsage"."inputTokens" + EXCLUDED."inputTokens",
           "outputTokens" = "LlmUsage"."outputTokens" + EXCLUDED."outputTokens",
           "cacheReadTokens" = "LlmUsage"."cacheReadTokens" + EXCLUDED."cacheReadTokens",
           "cacheWriteTokens" = "LlmUsage"."cacheWriteTokens" + EXCLUDED."cacheWriteTokens",
           "costUsd" = "LlmUsage"."costUsd" + EXCLUDED."costUsd"`,
        shop, model, u.input_tokens, u.output_tokens,
        u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, cost,
      ),
    )
    .catch((e) => console.error("[usage] record failed:", (e as Error).message));
}

/** Total LLM spend (USD) this calendar month for a shop — margin/abuse cap
 * enforcement. Fail-open (0) so metering never blocks a shopper turn. */
export async function monthlyCostUsd(shop: string): Promise<number> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ c: number | null }>>(
      `SELECT sum("costUsd") AS c FROM "LlmUsage"
        WHERE shop = $1 AND "day" >= date_trunc('month', now())::date`,
      shop,
    );
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

export interface UsageSummary {
  totalUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitPct: number; // share of prompt tokens served from cache
  byModel: Array<{ model: string; calls: number; costUsd: number }>;
}

export async function getUsageSummary(shop: string): Promise<UsageSummary | null> {
  try {
    await ensureTable();
    const rows = await prisma.llmUsage.findMany({ where: { shop } });
    if (!rows.length) return null;
    const sum = (f: (r: (typeof rows)[0]) => number) => rows.reduce((s, r) => s + f(r), 0);
    const input = sum((r) => r.inputTokens);
    const read = sum((r) => r.cacheReadTokens);
    const write = sum((r) => r.cacheWriteTokens);
    const byModel = new Map<string, { calls: number; costUsd: number }>();
    for (const r of rows) {
      const cur = byModel.get(r.model) ?? { calls: 0, costUsd: 0 };
      cur.calls += r.calls;
      cur.costUsd += r.costUsd;
      byModel.set(r.model, cur);
    }
    return {
      totalUsd: sum((r) => r.costUsd),
      calls: sum((r) => r.calls),
      inputTokens: input,
      outputTokens: sum((r) => r.outputTokens),
      cacheReadTokens: read,
      cacheWriteTokens: write,
      cacheHitPct: input + read + write > 0 ? read / (input + read + write) : 0,
      byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    };
  } catch (e) {
    console.error("[usage] summary failed:", (e as Error).message);
    return null;
  }
}

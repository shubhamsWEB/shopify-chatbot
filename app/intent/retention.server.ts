// Data retention: keeps the Event table a ROLLING WINDOW instead of unbounded.
// Old events are rolled up into per-day/type aggregates (EventRollup) so the
// dashboard keeps long-term trends, then the raw rows are deleted. The intent
// engine only ever reads a session's recent events, so it is unaffected.
//
// Runs opportunistically inside existing requests (no worker/cron): at most
// once per RUN_EVERY_MS per serverless instance, guarded by a Postgres advisory
// lock so concurrent instances can't double-roll the same rows.
import prisma from "../db.server";

// eslint-disable-next-line no-undef
const env = (k: string, d: number) => (process.env[k] != null ? Number(process.env[k]) : d);
export const EVENT_RETENTION_DAYS = env("EVENT_RETENTION_DAYS", 30);
const TRANSCRIPT_RETENTION_DAYS = env("TRANSCRIPT_RETENTION_DAYS", 60);
const PROFILE_RETENTION_DAYS = env("PROFILE_RETENTION_DAYS", 45);
const RUN_EVERY_MS = 6 * 60 * 60 * 1000; // per instance, per shop

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= prisma
    .$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "EventRollup" (
        "shop" TEXT NOT NULL,
        "day" DATE NOT NULL,
        "type" TEXT NOT NULL,
        "count" INTEGER NOT NULL DEFAULT 0,
        "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
        PRIMARY KEY ("shop", "day", "type")
      )`,
    )
    .then(() => undefined)
    .catch((e) => {
      tableReady = null;
      throw e;
    });
  return tableReady;
}

const lastRun = new Map<string, number>();

/** Fire-and-forget from the ingest path. Never throws into the request. */
export function maybeRollup(shop: string): void {
  const now = Date.now();
  if (now - (lastRun.get(shop) ?? 0) < RUN_EVERY_MS) return;
  lastRun.set(shop, now);
  rollupAndPrune(shop).catch((e) => console.error("[retention] failed:", (e as Error).message));
}

export async function rollupAndPrune(shop: string): Promise<void> {
  await ensureTable();
  // Single transaction + advisory lock: concurrent instances skip instead of
  // double-counting the same rows into the rollup.
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
      `retention:${shop}`,
    );
    if (!locked[0]?.ok) return;

    const cutoff = `now() - interval '${EVENT_RETENTION_DAYS} days'`;
    await tx.$executeRawUnsafe(
      `INSERT INTO "EventRollup" ("shop", "day", "type", "count", "revenue")
       SELECT "shopId", date_trunc('day', "timestamp")::date, type, count(*),
              coalesce(sum((payload->>'cartValue')::float), 0)
         FROM "Event"
        WHERE "shopId" = $1 AND "timestamp" < ${cutoff}
        GROUP BY 1, 2, 3
       ON CONFLICT ("shop", "day", "type")
       DO UPDATE SET "count" = "EventRollup"."count" + EXCLUDED."count",
                     "revenue" = "EventRollup"."revenue" + EXCLUDED."revenue"`,
      shop,
    );
    const deleted = await tx.$executeRawUnsafe(
      `DELETE FROM "Event" WHERE "shopId" = $1 AND "timestamp" < ${cutoff}`,
      shop,
    );
    if (deleted > 0) console.log(`[retention] ${shop}: rolled up + pruned ${deleted} events`);
  });

  // Independent cleanups — safe to run outside the lock, deletes are idempotent.
  await prisma.$executeRawUnsafe(
    `DELETE FROM "IntentProfile" WHERE "shopId" = $1 AND "lastUpdated" < now() - interval '${PROFILE_RETENTION_DAYS} days'`,
    shop,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM "ChatTranscript" WHERE "shop" = $1 AND "updatedAt" < now() - interval '${TRANSCRIPT_RETENTION_DAYS} days'`,
    shop,
  ).catch(() => {});
}

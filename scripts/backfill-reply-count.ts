#!/usr/bin/env npx tsx
/**
 * One-off hygiene: backfill ReplyCount from ChatTranscript history and repair
 * createdAt from the first message timestamp. Safe to re-run — only raises
 * ReplyCount when transcript-derived counts exceed stored counts.
 *
 * Usage: DATABASE_URL=... npm run backfill:reply-count
 */
import prisma from "../app/db.server";

async function ensureTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ReplyCount" (
      "shop" TEXT NOT NULL,
      "day" DATE NOT NULL,
      "count" INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY ("shop", "day")
    )`);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "ChatTranscript" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`);
}

async function backfillReplyCount() {
  const derived = await prisma.$queryRawUnsafe<Array<{ shop: string; day: Date; n: bigint }>>(`
    SELECT t.shop,
           (m->>'at')::date AS day,
           count(*) AS n
      FROM "ChatTranscript" t,
           jsonb_array_elements(t.messages) m
     WHERE m->>'role' = 'assistant'
       AND m->>'at' IS NOT NULL
       AND (m->>'at')::timestamptz IS NOT NULL
     GROUP BY t.shop, (m->>'at')::date`);

  let upserted = 0;
  for (const row of derived) {
    const res = await prisma.$executeRawUnsafe(
      `INSERT INTO "ReplyCount" ("shop", "day", "count") VALUES ($1, $2, $3)
       ON CONFLICT ("shop", "day") DO UPDATE SET "count" = GREATEST("ReplyCount"."count", EXCLUDED."count")
       WHERE "ReplyCount"."count" < EXCLUDED."count"`,
      row.shop, row.day, Number(row.n),
    );
    if (res) upserted++;
  }
  return { days: derived.length, upserted };
}

async function repairCreatedAt() {
  return prisma.$executeRawUnsafe(`
    UPDATE "ChatTranscript" t
       SET "createdAt" = sub.first_at
      FROM (
        SELECT shop, "sessionId",
               min((m->>'at')::timestamptz) AS first_at
          FROM "ChatTranscript",
               jsonb_array_elements(messages) m
         WHERE m->>'at' IS NOT NULL
           AND (m->>'at')::timestamptz IS NOT NULL
         GROUP BY shop, "sessionId"
      ) sub
     WHERE t.shop = sub.shop AND t."sessionId" = sub."sessionId"
       AND sub.first_at IS NOT NULL
       AND t."createdAt" > sub.first_at + interval '1 day'`);
}

(async () => {
  try {
    await ensureTables();
    const reply = await backfillReplyCount();
    const createdAtFixed = await repairCreatedAt();
    console.log(`ReplyCount: scanned ${reply.days} shop-day buckets, updated ${reply.upserted}`);
    console.log(`ChatTranscript createdAt repaired: ${createdAtFixed} rows`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

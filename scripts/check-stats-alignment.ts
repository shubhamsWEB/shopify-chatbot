#!/usr/bin/env npx tsx
/**
 * Assert the canonical ReplyCount monthly query matches what backoffice and
 * billing both use. Also reports shops where the legacy ChatTranscript count
 * still differs (expected until backfill runs on old data).
 *
 * Usage: DATABASE_URL=... npm run check:stats-alignment
 */
import prisma from "../app/db.server";

const MONTH_START = `date_trunc('month', now())::date`;

async function main() {
  const shops = await prisma.$queryRawUnsafe<Array<{ shop: string }>>(
    `SELECT DISTINCT shop FROM (
       SELECT shop FROM "ReplyCount" WHERE day >= ${MONTH_START}
       UNION SELECT shop FROM "ChatTranscript"
     ) s`,
  );

  let legacyMismatches = 0;
  for (const { shop } of shops) {
    const correct = await prisma.$queryRawUnsafe<Array<{ n: bigint | null }>>(
      `SELECT coalesce(sum(count), 0) AS n FROM "ReplyCount"
        WHERE shop = $1 AND day >= ${MONTH_START}`,
      shop,
    );
    const legacy = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "ChatTranscript"
        WHERE shop = $1 AND "createdAt" >= date_trunc('month', now())`,
      shop,
    );
    const replies = Number(correct[0]?.n ?? 0);
    const oldBackoffice = Number(legacy[0]?.n ?? 0);
    if (replies !== oldBackoffice) {
      console.log(`${shop}: ReplyCount=${replies}, legacy transcript count=${oldBackoffice}`);
      legacyMismatches++;
    }
  }

  const backofficeSql = await prisma.$queryRawUnsafe<Array<{ shop: string; n: bigint }>>(
    `SELECT shop, coalesce(sum(count), 0) AS n
       FROM "ReplyCount"
      WHERE day >= ${MONTH_START}
      GROUP BY shop`,
  );
  const billingSql = await prisma.$queryRawUnsafe<Array<{ shop: string; n: bigint | null }>>(
    `SELECT shop, coalesce(sum(count), 0) AS n
       FROM "ReplyCount"
      WHERE day >= ${MONTH_START}
      GROUP BY shop`,
  );

  const a = new Map(backofficeSql.map((r) => [r.shop, Number(r.n)]));
  const b = new Map(billingSql.map((r) => [r.shop, Number(r.n ?? 0)]));
  for (const [shop, n] of a) {
    if (b.get(shop) !== n) {
      console.error(`ReplyCount query mismatch for ${shop}`);
      process.exit(1);
    }
  }
  for (const [shop, n] of b) {
    if (!a.has(shop)) {
      console.error(`Shop ${shop} missing from backoffice aggregation`);
      process.exit(1);
    }
  }

  console.log(`Checked ${shops.length} shops. Legacy transcript mismatches: ${legacyMismatches}`);
  console.log("Backoffice and billing ReplyCount queries align.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

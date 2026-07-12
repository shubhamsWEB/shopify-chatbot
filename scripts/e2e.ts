// End-to-end nudge test against the real (local) DB. Seeds a shop + owner
// session, runs the cron dispatch, checks enrollment/dedupe/timing, then the
// limit series. SENDS REAL EMAILS to TEST_EMAIL.
//   TEST_EMAIL=you@example.com npx tsx --env-file=.env scratchpad/e2e.ts
import prisma from "../app/db.server";
import { dispatchNudges, dispatchCampaign } from "../app/nudges/dispatch.server";

const SHOP = "e2e-test.myshopify.com";
const to = process.env.TEST_EMAIL;
if (!to) throw new Error("set TEST_EMAIL");

const rows = () =>
  prisma.nudgeLog.findMany({ where: { shop: SHOP }, orderBy: { step: "asc" }, select: { campaign: true, step: true } });
const show = async (label: string) => console.log(`  NudgeLog: ${(await rows()).map((r) => `${r.campaign}/${r.step}`).join(", ") || "(none)"}`);

async function main() {
  // --- clean slate ---
  await prisma.nudgeLog.deleteMany({ where: { shop: SHOP } });
  await prisma.session.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.$executeRawUnsafe(`DELETE FROM "ReplyCount" WHERE shop = $1`, SHOP).catch(() => {});

  // --- seed shop + owner ---
  await prisma.shopSettings.create({
    data: {
      shop: SHOP,
      shopInfo: { name: "E2E Test Store", ownerName: "Shubham Agrawal" },
      backoffice: { convoLimit: 100 },
    },
  });
  await prisma.session.create({
    data: { id: `offline_${SHOP}`, shop: SHOP, state: "x", accessToken: "x", accountOwner: true, email: to },
  });

  console.log("\n1) First cron tick — expect welcome sent, anchor + welcome logged");
  console.log("  result:", await dispatchNudges());
  await show("");

  console.log("\n2) Second cron tick — expect 0 sent (dedupe)");
  console.log("  result:", await dispatchNudges());

  console.log("\n3) Back-date enrollment 8 days — expect brand+knowledge+results sent (days 1/3/7)");
  await prisma.nudgeLog.update({
    where: { shop_campaign_step: { shop: SHOP, campaign: "onboarding", step: "__enrolled__" } },
    data: { sentAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
  });
  console.log("  result:", await dispatchNudges());
  await show("");

  console.log("\n4) Limit series — seed 85/100 replies, expect usage-warn only");
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ReplyCount" (shop, day, count) VALUES ($1, current_date, 85)
     ON CONFLICT (shop, day) DO UPDATE SET count = 85`,
    SHOP,
  );
  console.log("  result:", await dispatchCampaign(SHOP, "usage-limit"));

  console.log("\n5) Bump to 100/100 — expect usage-exhausted (warn already sent)");
  await prisma.$executeRawUnsafe(`UPDATE "ReplyCount" SET count = 100 WHERE shop = $1 AND day = current_date`, SHOP);
  console.log("  result:", await dispatchCampaign(SHOP, "usage-limit"));
  await show("");

  console.log("\nDONE — check inbox for 6 emails (welcome, brand, knowledge, results, warn, exhausted)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

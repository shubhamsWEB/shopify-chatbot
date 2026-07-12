// NudgeLog IS the whole state machine: one row per (shop, campaign, step) that
// was sent. Row present = already sent → idempotent. Enrollment anchor is just
// the reserved step "__enrolled__", so onboarding times off it with no extra
// schema. claimStep uses INSERT .. ON CONFLICT DO NOTHING as an atomic guard so
// two concurrent cron instances can't double-send the same step.
import prisma from "../db.server";

const ENROLL_STEP = "__enrolled__";

/** Returns the shop's enrollment anchor for a campaign, creating it now if
 *  absent (first tick). This is what time-based steps measure from. */
export async function getOrCreateAnchor(shop: string, campaign: string, now: Date): Promise<Date> {
  await prisma.nudgeLog.upsert({
    where: { shop_campaign_step: { shop, campaign, step: ENROLL_STEP } },
    create: { shop, campaign, step: ENROLL_STEP, sentAt: now },
    update: {},
  });
  const row = await prisma.nudgeLog.findUnique({
    where: { shop_campaign_step: { shop, campaign, step: ENROLL_STEP } },
  });
  return row?.sentAt ?? now;
}

/** Atomically claim a step. Returns true if THIS caller won the claim (must
 *  now send); false if it was already sent/claimed. */
export async function claimStep(shop: string, campaign: string, step: string, now: Date): Promise<boolean> {
  const res = await prisma.nudgeLog.createMany({
    data: [{ shop, campaign, step, sentAt: now }],
    skipDuplicates: true,
  });
  return res.count === 1;
}

/** Undo a claim when the send fails, so the next tick retries. */
export async function releaseStep(shop: string, campaign: string, step: string): Promise<void> {
  await prisma.nudgeLog
    .delete({ where: { shop_campaign_step: { shop, campaign, step } } })
    .catch(() => {}); // already gone — fine
}

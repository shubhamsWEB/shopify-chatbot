// The generic engine. For every shop × campaign × step, if the step is due and
// not yet sent, claim → render → send → (on failure) release. Adding a series
// changes only the registry; this loop never changes.
import prisma from "../db.server";
import { campaigns } from "./registry.server";
import type { Campaign } from "./types";
import { getOrCreateAnchor, claimStep, releaseStep } from "./log.server";
import { recipientFor, sendTemplate } from "./send.server";
import { isSuppressed } from "./unsub.server";
import type { NudgeContext } from "./types";

export interface DispatchResult {
  sent: number;
  skipped: number;
  errors: number;
}

/** Run one campaign for one shop. Shared by the cron sweep and the inline
 *  trigger. Mutates `result`; never throws. Assumes the shop is not suppressed
 *  (callers check once up front). */
async function runCampaign(shop: string, campaign: Campaign, now: Date, result: DispatchResult): Promise<void> {
  try {
    if (!(await campaign.shouldEnroll(shop))) return;
    const enrolledAt = await getOrCreateAnchor(shop, campaign.key, now);
    const ctx: NudgeContext = { shop, now, enrolledAt };

    for (const step of campaign.steps) {
      if (!(await step.due(ctx))) continue;
      if (!(await claimStep(shop, campaign.key, step.id, now))) {
        result.skipped++;
        continue; // already sent
      }
      try {
        const to = await recipientFor(shop);
        if (!to) {
          // No address — drop the claim so we retry once they surface one.
          await releaseStep(shop, campaign.key, step.id);
          result.skipped++;
          continue;
        }
        const { templateKey, variables } = await step.render(ctx);
        await sendTemplate(shop, to, templateKey, variables);
        result.sent++;
      } catch (err) {
        await releaseStep(shop, campaign.key, step.id);
        result.errors++;
        console.error(`nudge send failed ${shop}/${campaign.key}/${step.id}`, err);
      }
    }
  } catch (err) {
    result.errors++;
    console.error(`nudge campaign failed ${shop}/${campaign.key}`, err);
  }
}

/** Run one pass over all shops and campaigns. Safe to call concurrently
 *  (claimStep is the atomic guard). Never throws — per-step failures are
 *  isolated so one bad shop can't stall the batch. */
export async function dispatchNudges(now = new Date()): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, skipped: 0, errors: 0 };
  const shops = (await prisma.shopSettings.findMany({ select: { shop: true } })).map((r) => r.shop);

  for (const shop of shops) {
    if (await isSuppressed(shop)) {
      result.skipped++;
      continue;
    }
    for (const campaign of campaigns) {
      await runCampaign(shop, campaign, now, result);
    }
  }
  return result;
}

/** Fire a single campaign for one shop immediately (event-driven), instead of
 *  waiting for the daily cron. Idempotent via claimStep, so calling it on every
 *  request while a condition holds only sends once. Fire-and-forget safe. */
export async function dispatchCampaign(shop: string, campaignKey: string, now = new Date()): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, skipped: 0, errors: 0 };
  const campaign = campaigns.find((c) => c.key === campaignKey);
  if (!campaign) return result;
  if (await isSuppressed(shop)) {
    result.skipped++;
    return result;
  }
  await runCampaign(shop, campaign, now, result);
  return result;
}

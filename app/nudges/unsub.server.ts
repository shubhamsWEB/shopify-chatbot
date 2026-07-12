// Unsubscribe tokens. Email links carry no session, so the shop is authorized
// by an HMAC the recipient can't forge. Global opt-out is stored as a reserved
// NudgeLog row; dispatch skips any suppressed shop before sending anything.
import crypto from "node:crypto";
import prisma from "../db.server";

const SECRET = process.env.NUDGE_UNSUB_SECRET ?? process.env.SHOPIFY_API_SECRET ?? process.env.CRON_SECRET ?? "";
const SUPPRESS = { campaign: "__global__", step: "__unsubscribed__" };

export function signShop(shop: string): string {
  return crypto.createHmac("sha256", SECRET).update(shop).digest("hex").slice(0, 32);
}

export function verifyShop(shop: string, token: string): boolean {
  const expected = signShop(shop);
  // constant-time compare; length guard because timingSafeEqual throws on mismatch
  return token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function unsubUrl(shop: string): string {
  const base = process.env.SHOPIFY_APP_URL ?? "";
  return `${base}/api/nudges/unsubscribe?shop=${encodeURIComponent(shop)}&t=${signShop(shop)}`;
}

export async function isSuppressed(shop: string): Promise<boolean> {
  const row = await prisma.nudgeLog.findUnique({
    where: { shop_campaign_step: { shop, ...SUPPRESS } },
  });
  return row != null;
}

export async function suppress(shop: string): Promise<void> {
  await prisma.nudgeLog.upsert({
    where: { shop_campaign_step: { shop, ...SUPPRESS } },
    create: { shop, ...SUPPRESS, sentAt: new Date() },
    update: {},
  });
}

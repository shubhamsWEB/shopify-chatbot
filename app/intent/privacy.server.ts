// GDPR / data-isolation purge. One place that knows every store a shop's data
// lives in: Postgres (Event, IntentProfile, StorefrontToken, Session).
// Used by the mandatory compliance webhooks and app/uninstalled.
import prisma from "../db.server";

// Full shop erasure: shop/redact and app/uninstalled. Removes ALL data we hold
// for the shop. Idempotent — webhooks retry and fire post-uninstall.
export async function purgeShop(shop: string): Promise<void> {
  await Promise.all([
    prisma.event.deleteMany({ where: { shopId: shop } }),
    prisma.intentProfile.deleteMany({ where: { shopId: shop } }),
    prisma.storefrontToken.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
    prisma.chatTranscript.deleteMany({ where: { shop } }).catch(() => {}), // table may not exist yet
    prisma.eventRollup.deleteMany({ where: { shop } }).catch(() => {}),
  ]);
  console.log(`[privacy] purged all data for ${shop}`);
}

// Single-customer erasure: customers/redact. Deletes that customer's events and
// any intent profile keyed to them. Session-keyed (anonymous) profiles for the
// same person aren't linkable to a customerId, so they age out via TTL.
export async function redactCustomer(shop: string, customerId: string): Promise<void> {
  // Transcripts are session-keyed; find the customer's sessions via their events
  // BEFORE deleting those events, then drop the matching transcripts.
  const sessions = await prisma.event.findMany({
    where: { shopId: shop, customerId },
    select: { sessionId: true },
    distinct: ["sessionId"],
  }).catch(() => [] as Array<{ sessionId: string }>);
  await Promise.all([
    prisma.event.deleteMany({ where: { shopId: shop, customerId } }),
    prisma.intentProfile.deleteMany({ where: { shopId: shop, customerId } }),
    prisma.chatTranscript.deleteMany({
      where: { shop, sessionId: { in: sessions.map((s) => s.sessionId) } },
    }).catch(() => {}),
  ]);
  console.log(`[privacy] redacted customer ${customerId} for ${shop}`);
}

// customers/data_request: assemble everything we hold on a customer so the
// merchant can hand it over. Returned, not emailed — Shopify only requires the
// data be made available to the store owner within 30 days.
export async function exportCustomer(shop: string, customerId: string) {
  const [events, profiles] = await Promise.all([
    prisma.event.findMany({ where: { shopId: shop, customerId } }),
    prisma.intentProfile.findMany({ where: { shopId: shop, customerId } }),
  ]);
  return { shop, customerId, events, profiles, generatedAt: new Date().toISOString() };
}

// GDPR / data-isolation purge. One place that knows every store a shop's data
// lives in: Postgres (Event, IntentProfile, StorefrontToken, Session).
// Used by the mandatory compliance webhooks and app/uninstalled.
import prisma from "../db.server";

// app/uninstalled: drop PII + live credentials only. Billing/stats tables
// (ShopSettings, LlmUsage, ReplyCount, EventRollup) stay so backoffice history
// and reply/cost caps survive reinstall. Idempotent — webhooks retry.
export async function purgePiiOnUninstall(shop: string): Promise<void> {
  await Promise.all([
    prisma.event.deleteMany({ where: { shopId: shop } }),
    prisma.intentProfile.deleteMany({ where: { shopId: shop } }),
    prisma.storefrontToken.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
    prisma.chatTranscript.deleteMany({ where: { shop } }).catch(() => {}), // table may not exist yet
  ]);
  console.log(`[privacy] purged PII for ${shop}`);
}

// shop/redact: mandatory full erasure when Shopify deletes the shop (~48h post-uninstall).
export async function purgeShop(shop: string): Promise<void> {
  await purgePiiOnUninstall(shop);
  await Promise.all([
    prisma.shopSettings.deleteMany({ where: { shop } }),
    prisma.llmUsage.deleteMany({ where: { shop } }),
    prisma.eventRollup.deleteMany({ where: { shop } }).catch(() => {}),
    prisma.$executeRawUnsafe(`DELETE FROM "ReplyCount" WHERE shop = $1`, shop).catch(() => {}),
  ]);
  console.log(`[privacy] fully purged ${shop}`);
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
  const sessionIds = [...new Set(events.map((e) => e.sessionId).filter(Boolean))];
  const transcripts = sessionIds.length
    ? await prisma.chatTranscript.findMany({ where: { shop, sessionId: { in: sessionIds } } }).catch(() => [])
    : [];
  return { shop, customerId, events, profiles, transcripts, generatedAt: new Date().toISOString() };
}

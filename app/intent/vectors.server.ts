// pgvector storage + semantic retrieval over intent-narrative embeddings.
// Prisma can't bind the `vector` type natively, so we use raw SQL.
import prisma from "../db.server";
import type { IntentProfile } from "./events";

const toVec = (v: number[]) => `[${v.join(",")}]`;

export async function storeEmbedding(shopId: string, profileKey: string, vec: number[]): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "IntentProfile" SET embedding = $1::vector WHERE "shopId" = $2 AND "profileKey" = $3`,
    toVec(vec),
    shopId,
    profileKey,
  );
}

// Collaborative signal (spec §3.6 + feedback loop §9): find the K shoppers whose
// intent narrative is semantically closest to THIS shopper, then return the
// in-store products those neighbors engaged with most — "shoppers with intent
// like yours gravitated to these". Uses the stored vector (no re-embed).
export async function similarIntentProducts(shopId: string, profileKey: string, k = 6): Promise<string[]> {
  const neighbors = await prisma.$queryRawUnsafe<Array<{ profileKey: string }>>(
    `SELECT "profileKey" FROM "IntentProfile"
       WHERE "shopId" = $1 AND "profileKey" <> $2 AND embedding IS NOT NULL
         AND (SELECT embedding FROM "IntentProfile" WHERE "shopId" = $1 AND "profileKey" = $2) IS NOT NULL
       ORDER BY embedding <=> (SELECT embedding FROM "IntentProfile" WHERE "shopId" = $1 AND "profileKey" = $2)
       LIMIT $3`,
    shopId,
    profileKey,
    k,
  );
  const sessions = neighbors.map((n) => n.profileKey);
  if (!sessions.length) return [];

  const events = await prisma.event.findMany({
    where: {
      shopId,
      sessionId: { in: sessions },
      type: { in: ["product_view", "add_to_cart", "order_created"] },
      productId: { not: null },
    },
    select: { productId: true, type: true, sessionId: true },
  });

  // Weight by engagement depth: order > cart > view.
  const weight: Record<string, number> = { order_created: 3, add_to_cart: 2, product_view: 1 };
  const score = new Map<string, number>();
  const shoppers = new Map<string, Set<string>>(); // productId → distinct neighbor sessions
  for (const e of events) {
    score.set(e.productId!, (score.get(e.productId!) ?? 0) + (weight[e.type] ?? 1));
    (shoppers.get(e.productId!) ?? shoppers.set(e.productId!, new Set()).get(e.productId!)!).add(e.sessionId);
  }
  // Only surface products backed by ≥2 distinct similar shoppers, so the
  // "Popular with similar shoppers" badge is a factual claim (App Store 1.1.4),
  // not a single shopper's single view.
  return [...score.entries()]
    .filter(([pid]) => (shoppers.get(pid)?.size ?? 0) >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([pid]) => pid);
}

// Intent COHORTS (spec §1.1, §12 — the leadership/marketing asset). Greedy
// clustering over the narrative embeddings: seed by recency, group everything
// within a cosine-distance threshold, aggregate the cohort's traits.
export interface IntentCohort {
  size: number;
  narrative: string;          // representative (seed) narrative
  focusCategory?: string;
  queryIntent?: string;
  avgConversion?: number;     // 0..1
  priceCeiling?: number;      // median across members
  contradictions: number;     // members with a stated-vs-revealed gap
}

const mode = (xs: (string | undefined)[]) => {
  const m = new Map<string, number>();
  for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const median = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);

export async function intentCohorts(shopId: string, threshold = 0.35, maxClusters = 8): Promise<IntentCohort[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ profileKey: string; profile: IntentProfile }>>(
    `SELECT "profileKey", profile FROM "IntentProfile"
       WHERE "shopId" = $1 AND embedding IS NOT NULL
       ORDER BY "lastUpdated" DESC LIMIT 200`,
    shopId,
  );
  const byKey = new Map(rows.map((r) => [r.profileKey, r.profile]));
  const assigned = new Set<string>();
  const cohorts: IntentCohort[] = [];

  for (const seed of rows) {
    if (assigned.has(seed.profileKey) || cohorts.length >= maxClusters) continue;
    const neighbors = await prisma.$queryRawUnsafe<Array<{ profileKey: string }>>(
      `SELECT "profileKey" FROM "IntentProfile"
         WHERE "shopId" = $1 AND embedding IS NOT NULL
           AND (embedding <=> (SELECT embedding FROM "IntentProfile" WHERE "shopId" = $1 AND "profileKey" = $2)) < $3`,
      shopId,
      seed.profileKey,
      threshold,
    );
    const members = neighbors.map((n) => n.profileKey).filter((k) => !assigned.has(k));
    if (!members.includes(seed.profileKey)) members.push(seed.profileKey);
    members.forEach((k) => assigned.add(k));

    const profiles = members.map((k) => byKey.get(k)).filter((p): p is IntentProfile => !!p);
    cohorts.push({
      size: profiles.length,
      narrative: seed.profile.intentNarrative,
      focusCategory: mode(profiles.map((p) => p.focusCategory)),
      queryIntent: mode(profiles.map((p) => p.queryIntent)),
      avgConversion: profiles.length
        ? profiles.reduce((s, p) => s + (p.conversionScore ?? 0), 0) / profiles.length
        : undefined,
      priceCeiling: median(profiles.map((p) => p.priceCeiling).filter((x): x is number => x != null)),
      contradictions: profiles.filter((p) => (p.contradictions?.length ?? 0) > 0).length,
    });
  }
  return cohorts.sort((a, b) => b.size - a.size);
}

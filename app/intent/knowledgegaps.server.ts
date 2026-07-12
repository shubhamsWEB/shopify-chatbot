// Knowledge gaps (OKF fast-follow): every time search_knowledge comes up empty
// for a shopper's question, the question is recorded here — "what shoppers
// asked that your docs don't answer". The merchant sees the list on the
// Knowledge page, writes the missing doc, and publishing auto-resolves every
// gap the new content now covers (same rankSections the live bot uses, so
// "resolved" means the bot will actually answer it). Lazy table, fail-soft
// everywhere: gap bookkeeping must never affect a chat turn.
import prisma from "../db.server";
import { rankSections, getPublishedDocs, offerLive } from "./knowledge.server";

export type GapStatus = "open" | "resolved" | "dismissed";

export interface KnowledgeGap {
  id: string;
  query: string; // latest raw phrasing
  count: number;
  status: GapStatus;
  firstAsked: string;
  lastAsked: string;
}

const MAX_ROWS_PER_SHOP = 300;
const MAX_QUERY_CHARS = 300;

/** Normalize a query into a dedup key: lowercase, alphanumeric tokens, sorted-
 * insensitive is too lossy — keep word order but collapse noise so "Return
 * policy?" and "return policy" merge. Pure — covered by the selfcheck. */
export function normalizeGapQuery(query: string): string {
  return (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ").slice(0, 200);
}

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  // Sequential DDL — never Promise.all (Neon pooled-connection race, 42P01).
  tableReady ??= prisma
    .$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KnowledgeGap" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "shop" TEXT NOT NULL,
        "queryKey" TEXT NOT NULL,
        "query" TEXT NOT NULL,
        "count" INTEGER NOT NULL DEFAULT 1,
        "status" TEXT NOT NULL DEFAULT 'open',
        "firstAsked" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "lastAsked" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    )
    .then(() => prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeGap_shop_key" ON "KnowledgeGap" ("shop", "queryKey")`))
    .then(() => undefined)
    .catch((e) => {
      tableReady = null;
      throw e;
    });
  return tableReady;
}

/** Record a zero-hit question. Repeat asks increment the counter and refresh
 * the phrasing. A dismissed gap STAYS dismissed (respect the merchant's call);
 * a resolved gap that misses again re-opens (its doc was edited or deleted).
 * Fire-and-forget from the chat path — never throws. */
export async function recordKnowledgeGap(shop: string, query: string): Promise<void> {
  try {
    const raw = query.trim().slice(0, MAX_QUERY_CHARS);
    const key = normalizeGapQuery(raw);
    if (!key) return;
    await ensureTable();
    const id = `gap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeGap" ("id", "shop", "queryKey", "query")
         VALUES ($1, $2, $3, $4)
       ON CONFLICT ("shop", "queryKey") DO UPDATE SET
         "count" = "KnowledgeGap"."count" + 1,
         "query" = EXCLUDED."query",
         "lastAsked" = now(),
         "status" = CASE WHEN "KnowledgeGap"."status" = 'dismissed' THEN 'dismissed' ELSE 'open' END`,
      id, shop, key, raw,
    );
    // Bound the per-shop footprint: drop the stalest non-open rows first, then
    // the stalest open ones past the cap.
    await prisma.$executeRawUnsafe(
      `DELETE FROM "KnowledgeGap" WHERE "shop" = $1 AND "id" IN (
         SELECT "id" FROM "KnowledgeGap" WHERE "shop" = $1
          ORDER BY ("status" = 'open') ASC, "lastAsked" ASC
          OFFSET ${MAX_ROWS_PER_SHOP})`,
      shop,
    );
  } catch (e) {
    console.error("[gaps] record failed:", (e as Error).message);
  }
}

interface GapRow {
  id: string;
  query: string;
  count: number;
  status: string;
  firstAsked: Date;
  lastAsked: Date;
}

const rowToGap = (r: GapRow): KnowledgeGap => ({
  id: r.id,
  query: r.query,
  count: r.count,
  status: (["open", "resolved", "dismissed"].includes(r.status) ? r.status : "open") as GapStatus,
  firstAsked: r.firstAsked.toISOString(),
  lastAsked: r.lastAsked.toISOString(),
});

/** Open gaps, most-asked first. Fail-soft → []. */
export async function listKnowledgeGaps(shop: string, limit = 50): Promise<KnowledgeGap[]> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<GapRow[]>(
      `SELECT "id", "query", "count", "status", "firstAsked", "lastAsked"
         FROM "KnowledgeGap" WHERE "shop" = $1 AND "status" = 'open'
        ORDER BY "count" DESC, "lastAsked" DESC LIMIT ${Math.min(limit, 200)}`,
      shop,
    );
    return rows.map(rowToGap);
  } catch (e) {
    console.error("[gaps] list failed:", (e as Error).message);
    return [];
  }
}

/** Dismiss one or more gaps (a whole cluster dismisses together). */
export async function dismissKnowledgeGaps(shop: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `UPDATE "KnowledgeGap" SET "status" = 'dismissed' WHERE "shop" = $1 AND "id" = ANY($2)`,
    shop, ids,
  );
}

// ---- clustering --------------------------------------------------------------

export interface GapCluster {
  ids: string[]; // every member gap id (dismiss dismisses all)
  query: string; // representative phrasing (the most-asked member's)
  variants: string[]; // other distinct phrasings in the cluster
  count: number; // summed asks across members
  lastAsked: string; // most recent ask across members
}

const CLUSTER_STOP = new Set(
  "a an the is are do does did to of in on for and or with my your you what how can i have has much any there".split(" "),
);

// Light stemmer so "wrapping"/"wrap", "points"/"point" count as the same
// concept: strip common suffixes, then collapse a trailing doubled consonant
// (wrapping → wrapp → wrap).
function stem(t: string): string {
  let s = t;
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 3 && s[s.length - 1] === s[s.length - 2]) s = s.slice(0, -1);
  return s;
}

const gapTokens = (q: string): Set<string> =>
  new Set(
    normalizeGapQuery(q)
      .split(" ")
      .filter((t) => t.length > 2 && !CLUSTER_STOP.has(t))
      .map(stem),
  );

/** Group near-duplicate questions ("gift wrapping cost" / "gift wrap price")
 * into one cluster via greedy token-overlap: a gap joins the first cluster
 * whose representative shares ≥50% of the smaller token set. Pure — covered
 * by the selfcheck. Input should be sorted most-asked-first (listKnowledgeGaps
 * order) so representatives are the strongest phrasings. */
export function clusterGaps(gaps: KnowledgeGap[]): GapCluster[] {
  const clusters: Array<GapCluster & { tokens: Set<string> }> = [];
  for (const g of gaps) {
    const tokens = gapTokens(g.query);
    const home = clusters.find((c) => {
      if (!tokens.size || !c.tokens.size) return false;
      let shared = 0;
      for (const t of tokens) if (c.tokens.has(t)) shared++;
      return shared / Math.min(tokens.size, c.tokens.size) >= 0.5;
    });
    if (home) {
      home.ids.push(g.id);
      home.variants.push(g.query);
      home.count += g.count;
      if (g.lastAsked > home.lastAsked) home.lastAsked = g.lastAsked;
      for (const t of tokens) home.tokens.add(t); // widen the cluster's vocabulary
    } else {
      clusters.push({ ids: [g.id], query: g.query, variants: [], count: g.count, lastAsked: g.lastAsked, tokens });
    }
  }
  return clusters
    .sort((a, b) => b.count - a.count || b.lastAsked.localeCompare(a.lastAsked))
    .map(({ ids, query, variants, count, lastAsked }) => ({ ids, query, variants, count, lastAsked }));
}

/** Close the loop: re-run every open gap through the SAME ranking the live bot
 * uses; anything the (just-published) docs now answer flips to resolved. Called
 * after a doc publish — corpus and gap list are both small, so this is a few
 * ms of in-memory scoring. Returns how many gaps got resolved. */
export async function resolveCoveredGaps(shop: string): Promise<number> {
  try {
    const [gaps, docs] = await Promise.all([
      listKnowledgeGaps(shop, 200),
      getPublishedDocs(shop).then((d) => d.filter((x) => offerLive(x))),
    ]);
    if (!gaps.length || !docs.length) return 0;
    const covered = gaps.filter((g) => rankSections(g.query, docs).length > 0);
    for (const g of covered) {
      await prisma.$executeRawUnsafe(
        `UPDATE "KnowledgeGap" SET "status" = 'resolved' WHERE "shop" = $1 AND "id" = $2`,
        shop, g.id,
      );
    }
    if (covered.length) console.log(`[gaps] auto-resolved ${covered.length} for ${shop}`);
    return covered.length;
  } catch (e) {
    console.error("[gaps] auto-resolve failed:", (e as Error).message);
    return 0;
  }
}

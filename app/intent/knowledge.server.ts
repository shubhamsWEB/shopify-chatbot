// OKF (Open Knowledge Format) — per-shop merchant knowledge documents the bot
// answers from: FAQs, policies, offers. Markdown body is the source of truth;
// `sections` is derived on save (split on headings) so retrieval works at
// section granularity. No embeddings — Tier-1 awareness index (knowledgeIndex,
// injected into the cached system block) + Tier-2 in-memory keyword ranking
// with retail synonym expansion (searchKnowledge, a bot tool). Table created
// lazily like ShopSettings so production needs no out-of-band `prisma db push`.
import prisma from "../db.server";
import {
  OKF_KINDS, KIND_LABEL, CAPS, deriveSections, offerLive,
  type OkfKind, type OkfSection, type OkfDoc, type KnowledgeHit, type SaveDocInput,
} from "./okf";

export {
  OKF_KINDS, KIND_LABEL, CAPS, deriveSections, offerLive,
  type OkfKind, type OkfSection, type OkfDoc, type KnowledgeHit, type SaveDocInput,
} from "./okf";

// ---- lazy table -------------------------------------------------------------

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  // Sequential chaining — never Promise.all (Neon pooled-connection DDL race,
  // 42P01; same lesson settings.server / transcript.server encode).
  tableReady ??= prisma
    .$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KnowledgeDoc" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "shop" TEXT NOT NULL,
        "kind" TEXT NOT NULL DEFAULT 'general',
        "title" TEXT NOT NULL DEFAULT '',
        "body" TEXT NOT NULL DEFAULT '',
        "sections" JSONB NOT NULL DEFAULT '[]',
        "tags" TEXT[] NOT NULL DEFAULT '{}',
        "effectiveFrom" TIMESTAMPTZ,
        "effectiveTo" TIMESTAMPTZ,
        "status" TEXT NOT NULL DEFAULT 'published',
        "sourceBlobUrl" TEXT,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    )
    .then(() => prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "KnowledgeDoc_shop_idx" ON "KnowledgeDoc" ("shop")`))
    // Retrieval scores sections in-memory over the cached per-shop docs (the
    // corpus is capped tiny), so no full-text / trigram index is needed — the
    // shop index above already scopes the read.
    .then(() => undefined)
    .catch((e) => {
      tableReady = null; // retry on next call
      throw e;
    });
  return tableReady;
}

// ---- row mapping ------------------------------------------------------------

interface KnowledgeRow {
  id: string;
  shop: string;
  kind: string;
  title: string;
  body: string;
  sections: unknown;
  tags: string[];
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  status: string;
  updatedAt: Date;
}

function rowToDoc(r: KnowledgeRow): OkfDoc {
  return {
    id: r.id,
    shop: r.shop,
    kind: (OKF_KINDS.includes(r.kind as OkfKind) ? r.kind : "general") as OkfKind,
    title: r.title,
    body: r.body,
    sections: Array.isArray(r.sections) ? (r.sections as OkfSection[]) : [],
    tags: r.tags ?? [],
    effectiveFrom: r.effectiveFrom ? r.effectiveFrom.toISOString() : null,
    effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString() : null,
    status: r.status === "draft" ? "draft" : "published",
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ---- cache (published docs only, for the always-on Tier-1 read) -------------

const cache = new Map<string, { docs: OkfDoc[]; at: number }>();
const TTL_MS = 60_000;

/** Published docs for a shop, cached 60s. Powers knowledgeIndex (Tier-1) and
 *  is the corpus the bot is allowed to surface. Fail-soft → []. */
export async function getPublishedDocs(shop: string): Promise<OkfDoc[]> {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.docs;
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<KnowledgeRow[]>(
      `SELECT id, shop, kind, title, body, sections, tags, "effectiveFrom", "effectiveTo", status, "updatedAt"
         FROM "KnowledgeDoc" WHERE shop = $1 AND status = 'published' ORDER BY "updatedAt" DESC`,
      shop,
    );
    const docs = rows.map(rowToDoc);
    cache.set(shop, { docs, at: Date.now() });
    return docs;
  } catch (err) {
    console.error("[knowledge] read failed:", (err as Error).message);
    return hit?.docs ?? [];
  }
}

/** Tier-1 awareness index: titles + section headings + live-offer summaries.
 *  Injected into the cached STATIC_SYSTEM block. "" when the shop has no docs —
 *  the assembled prompt is then byte-identical to today. Capped at the token
 *  budget with a truncation notice. */
export async function knowledgeIndex(shop: string): Promise<string> {
  const docs = (await getPublishedDocs(shop)).filter((d) => offerLive(d));
  if (!docs.length) return "";
  const lines: string[] = [];
  for (const d of docs) {
    const headings = d.sections.map((s) => s.heading).filter(Boolean).slice(0, 12);
    const window =
      d.kind === "offer" && (d.effectiveFrom || d.effectiveTo)
        ? ` (valid ${d.effectiveFrom ? new Date(d.effectiveFrom).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "now"}${d.effectiveTo ? "–" + new Date(d.effectiveTo).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""})`
        : "";
    lines.push(`- [${KIND_LABEL[d.kind]}] ${d.title}${window}${headings.length ? ": " + headings.join(", ") : ""}`);
  }
  let body = lines.join("\n");
  const budgetChars = CAPS.indexTokenBudget * 4;
  if (body.length > budgetChars) body = body.slice(0, budgetChars) + "\n- …more available via the search_knowledge tool";
  return (
    `STORE KNOWLEDGE (the merchant's own FAQs / policies / current offers — ` +
    `use the search_knowledge tool to fetch exact text before answering a ` +
    `policy, process, or offer question; never guess these):\n${body}`
  );
}

// ---- Tier-2 retrieval -------------------------------------------------------

const KIND_PRIORITY: Record<OkfKind, number> = { policy: 3, faq: 2, offer: 1, general: 0 };

// Very common words carry no retrieval signal — dropped so an incidental "any"
// or "you" overlap can't outrank a real content-term match.
const STOPWORDS = new Set(
  ("a an the is are was were do does did to of in on for and or but with my your our i you it that this " +
    "how what when where why can could would should will my me we they them there here get got have has had " +
    "any some all no not too so if then than about right now please just from into out up down back")
    .split(" "),
);

// Small retail-domain synonym expansion — the no-embedding way to bridge the
// vocabulary gap between how a shopper asks and how a merchant writes. Each set
// is mutually interchangeable; a query term hitting any member also matches the
// others. Keep tight and high-precision (retail process words only).
const SYNONYM_SETS: string[][] = [
  ["refund", "refunds", "refunded", "money", "moneyback"],
  ["return", "returns", "returning", "send", "sending"],
  ["exchange", "exchanges", "swap", "replace", "replacement"],
  ["discount", "discounts", "off", "sale", "deal", "deals", "offer", "offers", "promo", "promotion", "coupon"],
  ["shipping", "ship", "shipped", "delivery", "deliver", "dispatch", "courier"],
  ["international", "worldwide", "abroad", "overseas", "country", "countries", "global"],
  ["warranty", "warranties", "guarantee", "guaranteed", "defect", "defects"],
  ["cancel", "cancellation", "cancelled"],
  ["track", "tracking", "trace", "status", "where"],
  ["free", "complimentary", "gratis"],
];

// Expand a set of query terms with domain synonyms — a query "discount" also
// searches for "off"/"sale"/"offer", so "20% off" copy is found.
function expandTerms(terms: string[]): Set<string> {
  const out = new Set(terms);
  for (const t of terms) {
    for (const set of SYNONYM_SETS) {
      if (set.includes(t)) set.forEach((s) => out.add(s));
    }
  }
  return out;
}

function meaningfulTerms(query: string): string[] {
  const raw = query.toLowerCase().match(/[a-z0-9]+/gi) ?? [];
  return raw.filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// Score a section: fraction of the query's meaningful content-terms (expanded
// with synonyms) present, with a heading hit weighted higher since a heading is
// the merchant's own label for the topic.
function sectionScore(baseTerms: string[], expanded: Set<string>, section: OkfSection, title: string): number {
  if (!baseTerms.length) return 0;
  const headHay = (title + " " + section.heading).toLowerCase();
  const bodyHay = section.text.toLowerCase();
  // Which base concepts are satisfied (by the term or any of its synonyms)?
  let satisfied = 0;
  let headingBonus = 0;
  for (const bt of baseTerms) {
    const variants = [bt, ...[...expanded].filter((e) => SYNONYM_SETS.some((s) => s.includes(bt) && s.includes(e)))];
    const inHead = variants.some((v) => headHay.includes(v));
    const inBody = variants.some((v) => bodyHay.includes(v));
    if (inHead || inBody) satisfied++;
    if (inHead) headingBonus += 0.25;
  }
  if (satisfied === 0) return 0;
  return satisfied / baseTerms.length + headingBonus;
}

// Floor: need either >1 concept matched, or a single strong (heading) match —
// one incidental body-term hit isn't enough to surface a section.
const SCORE_FLOOR = 0.5;

/** Pure in-memory ranking (no DB) — exported so the self-check can guard it.
 *  Scores every section of the given docs, keeps those above the floor, sorts by
 *  score then kind priority. `docs` should already be the published + live set. */
export function rankSections(query: string, docs: OkfDoc[], limit = 3): KnowledgeHit[] {
  const baseTerms = meaningfulTerms(query);
  if (!baseTerms.length) return [];
  const expanded = expandTerms(baseTerms);
  const scored: Array<{ hit: KnowledgeHit; score: number; kind: OkfKind }> = [];
  for (const d of docs) {
    for (const s of d.sections) {
      const score = sectionScore(baseTerms, expanded, s, d.title);
      if (score < SCORE_FLOOR) continue;
      scored.push({ hit: { docTitle: d.title, kind: d.kind, heading: s.heading, text: s.text, anchor: s.anchor }, score, kind: d.kind });
    }
  }
  scored.sort((a, b) => b.score - a.score || KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind]);
  return scored.slice(0, limit).map((x) => x.hit);
}

/** Tier-2 grounding: return the top matching sections for a shopper's question.
 *  Scores sections in-memory over the shop's already-cached published docs —
 *  the per-shop corpus is capped tiny (§CAPS), so this is both simpler and more
 *  reliable than SQL full-text ranking, and adds no DB hit on the tool call.
 *  Offers filtered to live. Fail-soft → []: a knowledge outage never fails a turn. */
export async function searchKnowledge(shop: string, query: string, limit = 3): Promise<KnowledgeHit[]> {
  if (!meaningfulTerms(query).length) return [];
  try {
    const docs = (await getPublishedDocs(shop)).filter((d) => offerLive(d));
    return rankSections(query, docs, limit);
  } catch (err) {
    console.error("[knowledge] search failed:", (err as Error).message);
    return [];
  }
}

// ---- CRUD (used by the admin route in S1) -----------------------------------

export class CountCapError extends Error {}
export class ConflictError extends Error {}

export async function listDocs(shop: string): Promise<OkfDoc[]> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<KnowledgeRow[]>(
      `SELECT id, shop, kind, title, body, sections, tags, "effectiveFrom", "effectiveTo", status, "updatedAt"
         FROM "KnowledgeDoc" WHERE shop = $1 ORDER BY "updatedAt" DESC`,
      shop,
    );
    return rows.map(rowToDoc);
  } catch (err) {
    console.error("[knowledge] list failed:", (err as Error).message);
    return [];
  }
}

export async function getDoc(shop: string, id: string): Promise<OkfDoc | null> {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe<KnowledgeRow[]>(
    `SELECT id, shop, kind, title, body, sections, tags, "effectiveFrom", "effectiveTo", status, "updatedAt"
       FROM "KnowledgeDoc" WHERE shop = $1 AND id = $2`,
    shop,
    id,
  );
  return rows[0] ? rowToDoc(rows[0]) : null;
}

/** Create or update a document. Derives sections, enforces caps + optimistic
 *  lock, invalidates the cache. Returns the saved doc. */
export async function saveDoc(shop: string, input: SaveDocInput): Promise<OkfDoc> {
  await ensureTable();
  const kind: OkfKind = OKF_KINDS.includes(input.kind) ? input.kind : "general";
  const title = (input.title || "").trim().slice(0, 300) || "Untitled";
  const body = (input.body || "").slice(0, CAPS.bodyChars);
  const tags = (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, CAPS.tagsPerDoc);
  const status = input.status === "draft" ? "draft" : "published";
  const sections = deriveSections(body);
  // Tolerate malformed date strings (drop them) — an unparsable date must not
  // turn into an Invalid Date the driver rejects with an opaque 500.
  const parseDate = (v: string | null | undefined): Date | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const from = kind === "offer" ? parseDate(input.effectiveFrom) : null;
  const to = kind === "offer" ? parseDate(input.effectiveTo) : null;

  if (!input.id) {
    // Create — enforce per-shop doc cap.
    const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "KnowledgeDoc" WHERE shop = $1`,
      shop,
    );
    if (Number(n) >= CAPS.docsPerShop) throw new CountCapError(`This store already has the maximum of ${CAPS.docsPerShop} documents.`);
    const id = `okf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeDoc" (id, shop, kind, title, body, sections, tags, "effectiveFrom", "effectiveTo", status, "sourceBlobUrl", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11, now())`,
      id, shop, kind, title, body, JSON.stringify(sections), tags, from, to, status, input.sourceBlobUrl ?? null,
    );
    cache.delete(shop);
    return (await getDoc(shop, id))!;
  }

  // Update — optimistic lock: reject if the row moved since the editor loaded.
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "KnowledgeDoc"
        SET kind=$3, title=$4, body=$5, sections=$6::jsonb, tags=$7,
            "effectiveFrom"=$8, "effectiveTo"=$9, status=$10,
            "sourceBlobUrl"=COALESCE($11, "sourceBlobUrl"), "updatedAt"=now()
      WHERE shop=$1 AND id=$2
        AND ($12::timestamptz IS NULL
             OR date_trunc('milliseconds', "updatedAt") = date_trunc('milliseconds', $12::timestamptz))`,
    shop, input.id, kind, title, body, JSON.stringify(sections), tags, from, to, status,
    input.sourceBlobUrl ?? null,
    input.expectedUpdatedAt ?? null,
  );
  if (affected === 0) {
    const exists = await getDoc(shop, input.id);
    if (!exists) throw new Error("Document not found.");
    throw new ConflictError("This document changed since you opened it. Reload to see the latest version, then re-apply your edit.");
  }
  cache.delete(shop);
  return (await getDoc(shop, input.id))!;
}

export async function deleteDoc(shop: string, id: string): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(`DELETE FROM "KnowledgeDoc" WHERE shop = $1 AND id = $2`, shop, id);
  cache.delete(shop);
}

/** Test hook: drop the cache (used by the self-check / after external writes). */
export function _clearKnowledgeCache(): void {
  cache.clear();
}

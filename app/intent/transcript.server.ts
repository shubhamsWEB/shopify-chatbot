// Server-side chat transcript per (shop, session): the widget's sessionStorage
// is tab-local, but the saleshq_sid cookie lives 30 days — returning visitors
// restore their conversation from here. Appended during existing chat/proactive
// requests (no extra client round-trips). Table created lazily (no prod DDL step).
import prisma from "../db.server";

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  products?: unknown[];
  followups?: string[];
  at?: string;
}

const MAX_MESSAGES = 80;

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= prisma
    .$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "ChatTranscript" (
        "shop" TEXT NOT NULL,
        "sessionId" TEXT NOT NULL,
        "messages" JSONB NOT NULL DEFAULT '[]',
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("shop", "sessionId")
      )`,
    )
    .then(() =>
      prisma.$executeRawUnsafe(
        `ALTER TABLE "ChatTranscript" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
      ),
    )
    // Maintained per-day reply counter (mirrors LlmUsage's shape) — avoids
    // scanning + JSONB-unnesting every transcript a shop has ever had on every
    // single chat turn (that query was hit on every message AND every 30s
    // proactive poll; cost grew with a shop's total lifetime history).
    .then(() =>
      prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "ReplyCount" (
          "shop" TEXT NOT NULL,
          "day" DATE NOT NULL,
          "count" INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY ("shop", "day")
        )`,
      ),
    )
    .then(() => undefined)
    .catch((e) => {
      tableReady = null;
      throw e;
    });
  return tableReady;
}

export async function getTranscript(shop: string, sessionId: string): Promise<TranscriptMessage[]> {
  try {
    await ensureTable();
    const row = await prisma.chatTranscript.findUnique({ where: { shop_sessionId: { shop, sessionId } } });
    return ((row?.messages as unknown as TranscriptMessage[]) ?? []);
  } catch (err) {
    console.error("[transcript] read failed:", (err as Error).message);
    return [];
  }
}

// Append messages to the session transcript. Fail-soft — losing a transcript
// line must never fail the chat turn itself.
export async function appendTranscript(shop: string, sessionId: string, msgs: TranscriptMessage[]): Promise<void> {
  try {
    await ensureTable();
    const stamped = msgs.map((m) => ({ ...m, at: m.at ?? new Date().toISOString() }));
    const existing = await getTranscript(shop, sessionId);
    const merged = [...existing, ...stamped].slice(-MAX_MESSAGES);
    await prisma.chatTranscript.upsert({
      where: { shop_sessionId: { shop, sessionId } },
      create: { shop, sessionId, messages: merged as object[] },
      update: { messages: merged as object[] },
    });
    const replies = msgs.filter((m) => m.role === "assistant").length;
    if (replies > 0) await bumpReplyCount(shop, replies);
  } catch (err) {
    console.error("[transcript] append failed:", (err as Error).message);
  }
}

async function bumpReplyCount(shop: string, n: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ReplyCount" ("shop", "day", "count") VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT ("shop", "day") DO UPDATE SET "count" = "ReplyCount"."count" + $2`,
    shop, n,
  );
}

/** AI replies (assistant answers) this calendar month — the metered quota unit.
 * Reads the maintained per-day counter (see bumpReplyCount), not the
 * transcripts themselves — cheap regardless of a shop's lifetime history.
 * Fail-open (return 0) so metering never blocks a shopper on a query error. */
export async function monthlyReplies(shop: string): Promise<number> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | null }>>(
      `SELECT sum("count") AS n FROM "ReplyCount"
        WHERE shop = $1 AND day >= date_trunc('month', now())::date`,
      shop,
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

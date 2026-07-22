// Human-handoff notifications and CRM tickets raised from chat. One table backs
// both request_human_handoff (kind='handoff') and create_support_ticket
// (kind='ticket') — same status lifecycle + channel shape so a later
// live-takeover feature attaches replies to either without a schema rewrite.
// Lazy table (no prod `prisma db push`), fail-soft reads, mirrors
// knowledgegaps.server.ts. Raw SQL throughout so the server code needs no
// `prisma generate` for the new model (the schema.prisma block is type-only).
import prisma from "../db.server";
import { recipientFor } from "../nudges/send.server";
import { TEMPLATE_FROM } from "../nudges/templates";
import { dispatchWebhook } from "./connectors/webhook.server";
import type { SupportConfig } from "./settings.server";
import type { TranscriptMessage } from "./transcript.server";

export type TicketKind = "handoff" | "ticket";
export type TicketChannel = "webhook" | "email" | "whatsapp" | "freshdesk" | "none";
export type TicketStatus = "open" | "notified" | "replied" | "resolved" | "closed";

export interface SupportTicket {
  id: string;
  shop: string;
  sessionId: string;
  customerId?: string | null;
  kind: TicketKind;
  channel: TicketChannel;
  status: TicketStatus;
  contactEmail?: string | null;
  contactPhone?: string | null;
  issueSummary: string;
  transcriptSnapshot: TranscriptMessage[];
  externalTicketId?: string | null;
  externalStatus?: string | null;
  channelMeta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const MAX_ROWS_PER_SHOP = 2000;
const STATUSES: TicketStatus[] = ["open", "notified", "replied", "resolved", "closed"];

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  // Sequential DDL — never Promise.all (Neon pooled-connection race, 42P01).
  tableReady ??= prisma
    .$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "SupportTicket" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "shop" TEXT NOT NULL,
        "sessionId" TEXT NOT NULL,
        "customerId" TEXT,
        "kind" TEXT NOT NULL DEFAULT 'handoff',
        "channel" TEXT NOT NULL DEFAULT 'none',
        "status" TEXT NOT NULL DEFAULT 'open',
        "contactEmail" TEXT,
        "contactPhone" TEXT,
        "issueSummary" TEXT NOT NULL DEFAULT '',
        "transcriptSnapshot" JSONB NOT NULL DEFAULT '[]',
        "externalTicketId" TEXT,
        "externalStatus" TEXT,
        "channelMeta" JSONB NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    )
    .then(() => prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SupportTicket_shop_status_idx" ON "SupportTicket" ("shop","status")`))
    .then(() => prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SupportTicket_shop_session_idx" ON "SupportTicket" ("shop","sessionId")`))
    .then(() => undefined)
    .catch((e) => {
      tableReady = null;
      throw e;
    });
  return tableReady;
}

interface TicketRow {
  id: string;
  shop: string;
  sessionId: string;
  customerId: string | null;
  kind: string;
  channel: string;
  status: string;
  contactEmail: string | null;
  contactPhone: string | null;
  issueSummary: string;
  transcriptSnapshot: unknown;
  externalTicketId: string | null;
  externalStatus: string | null;
  channelMeta: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const rowToTicket = (r: TicketRow): SupportTicket => ({
  id: r.id,
  shop: r.shop,
  sessionId: r.sessionId,
  customerId: r.customerId,
  kind: (r.kind === "ticket" ? "ticket" : "handoff") as TicketKind,
  channel: (["webhook", "email", "whatsapp", "freshdesk", "none"].includes(r.channel) ? r.channel : "none") as TicketChannel,
  status: (STATUSES.includes(r.status as TicketStatus) ? r.status : "open") as TicketStatus,
  contactEmail: r.contactEmail,
  contactPhone: r.contactPhone,
  issueSummary: r.issueSummary,
  transcriptSnapshot: (r.transcriptSnapshot as TranscriptMessage[]) ?? [],
  externalTicketId: r.externalTicketId,
  externalStatus: r.externalStatus,
  channelMeta: (r.channelMeta as Record<string, unknown>) ?? {},
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export interface CreateSupportCaseInput {
  sessionId: string;
  customerId?: string;
  kind: TicketKind;
  channel?: TicketChannel;
  status?: TicketStatus;
  contactEmail?: string;
  contactPhone?: string;
  issueSummary: string;
  transcriptSnapshot: TranscriptMessage[];
  externalTicketId?: string;
  externalStatus?: string;
  channelMeta?: Record<string, unknown>;
}

/** Insert a new case. Throws on DB error (the chat branch catches → tool_result
 * is_error, so the model recovers gracefully). */
export async function createSupportCase(shop: string, input: CreateSupportCaseInput): Promise<SupportTicket> {
  await ensureTable();
  const id = `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const rows = await prisma.$queryRawUnsafe<TicketRow[]>(
    `INSERT INTO "SupportTicket"
       ("id","shop","sessionId","customerId","kind","channel","status","contactEmail","contactPhone","issueSummary","transcriptSnapshot","externalTicketId","externalStatus","channelMeta")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb)
     RETURNING *`,
    id, shop, input.sessionId, input.customerId ?? null,
    input.kind, input.channel ?? "none", input.status ?? "open",
    input.contactEmail ?? null, input.contactPhone ?? null,
    input.issueSummary.slice(0, 2000),
    JSON.stringify(input.transcriptSnapshot ?? []),
    input.externalTicketId ?? null, input.externalStatus ?? null,
    JSON.stringify(input.channelMeta ?? {}),
  );
  // Bound per-shop footprint: drop the oldest closed rows past the cap.
  prisma.$executeRawUnsafe(
    `DELETE FROM "SupportTicket" WHERE "shop" = $1 AND "id" IN (
       SELECT "id" FROM "SupportTicket" WHERE "shop" = $1
        ORDER BY ("status" = 'closed') DESC, "createdAt" ASC
        OFFSET ${MAX_ROWS_PER_SHOP})`,
    shop,
  ).catch(() => {});
  return rowToTicket(rows[0]);
}

/** Look up one case by its id (internal tk_… or the external CRM id), scoped to
 * this shopper's session/customer so a shopper can only see their own. */
export async function findSupportCase(shop: string, ticketId: string, sessionId: string, customerId?: string): Promise<SupportTicket | null> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<TicketRow[]>(
      `SELECT * FROM "SupportTicket"
        WHERE "shop" = $1 AND ("id" = $2 OR "externalTicketId" = $2)
          AND ("sessionId" = $3 OR ("customerId" IS NOT NULL AND "customerId" = $4))
        ORDER BY "createdAt" DESC LIMIT 1`,
      shop, ticketId, sessionId, customerId ?? null,
    );
    return rows[0] ? rowToTicket(rows[0]) : null;
  } catch (e) {
    console.error("[tickets] find failed:", (e as Error).message);
    return null;
  }
}

export async function findMostRecentForSession(shop: string, sessionId: string, customerId?: string): Promise<SupportTicket | null> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<TicketRow[]>(
      `SELECT * FROM "SupportTicket"
        WHERE "shop" = $1 AND "kind" = 'ticket'
          AND ("sessionId" = $2 OR ("customerId" IS NOT NULL AND "customerId" = $3))
        ORDER BY "createdAt" DESC LIMIT 1`,
      shop, sessionId, customerId ?? null,
    );
    return rows[0] ? rowToTicket(rows[0]) : null;
  } catch (e) {
    console.error("[tickets] findRecent failed:", (e as Error).message);
    return null;
  }
}

/** Admin-scoped lookup by internal id (no session gate — the caller is the
 * authenticated merchant). Fail-soft → null. */
export async function getSupportCaseById(shop: string, id: string): Promise<SupportTicket | null> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<TicketRow[]>(
      `SELECT * FROM "SupportTicket" WHERE "shop" = $1 AND "id" = $2 LIMIT 1`,
      shop, id,
    );
    return rows[0] ? rowToTicket(rows[0]) : null;
  } catch (e) {
    console.error("[tickets] getById failed:", (e as Error).message);
    return null;
  }
}

export async function updateSupportCaseStatus(shop: string, id: string, status: TicketStatus): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `UPDATE "SupportTicket" SET "status" = $3, "updatedAt" = now() WHERE "shop" = $1 AND "id" = $2`,
    shop, id, status,
  );
}

export async function updateSupportCaseExternalStatus(shop: string, id: string, externalStatus: string): Promise<void> {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `UPDATE "SupportTicket" SET "externalStatus" = $3, "updatedAt" = now() WHERE "shop" = $1 AND "id" = $2`,
    shop, id, externalStatus,
  );
}

/** Admin list: recent cases, optionally filtered by status. Fail-soft → []. */
export async function listSupportCases(shop: string, opts: { status?: TicketStatus; limit?: number } = {}): Promise<SupportTicket[]> {
  try {
    await ensureTable();
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = opts.status
      ? await prisma.$queryRawUnsafe<TicketRow[]>(
          `SELECT * FROM "SupportTicket" WHERE "shop" = $1 AND "status" = $2 ORDER BY "createdAt" DESC LIMIT ${limit}`,
          shop, opts.status,
        )
      : await prisma.$queryRawUnsafe<TicketRow[]>(
          `SELECT * FROM "SupportTicket" WHERE "shop" = $1 ORDER BY "createdAt" DESC LIMIT ${limit}`,
          shop,
        );
    return rows.map(rowToTicket);
  } catch (e) {
    console.error("[tickets] list failed:", (e as Error).message);
    return [];
  }
}

// ---- Channel dispatch ------------------------------------------------------

/** wa.me deep link prefilled with the issue so the shopper can continue on
 * WhatsApp. Number is already digits-only (normalizeSupportConfig strips it). */
export function buildWhatsappLink(number: string, issueSummary: string): string {
  const text = encodeURIComponent(`Hi, I need help: ${issueSummary}`.slice(0, 900));
  return `https://wa.me/${number}?text=${text}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function transcriptHtml(msgs: TranscriptMessage[]): string {
  return msgs
    .slice(-40)
    .map((m) => `<p style="margin:4px 0;"><strong>${m.role === "user" ? "Shopper" : "Bot"}:</strong> ${esc(m.content).slice(0, 1000)}</p>`)
    .join("");
}

/** Raw Resend HTML email (not a hosted template — ticket content is dynamic and
 * structured, not marketing copy). Returns delivery result; never throws. */
export async function sendSupportEmail(
  shop: string,
  ticket: SupportTicket,
  to: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const API_KEY = process.env.RESEND_API_KEY;
  if (!API_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  const label = ticket.kind === "ticket" ? "New support ticket" : "Shopper wants a human";
  const contact = [ticket.contactEmail, ticket.contactPhone].filter(Boolean).join(" · ") || "not provided";
  const html = `
    <div style="font-family:system-ui,sans-serif;font-size:14px;color:#1a1a1a;">
      <h2 style="margin:0 0 8px;">${esc(label)}</h2>
      <p style="margin:2px 0;"><strong>Store:</strong> ${esc(shop)}</p>
      <p style="margin:2px 0;"><strong>Contact:</strong> ${esc(contact)}</p>
      <p style="margin:2px 0;"><strong>Reference:</strong> ${esc(ticket.externalTicketId ?? ticket.id)}</p>
      <p style="margin:8px 0 2px;"><strong>Issue:</strong> ${esc(ticket.issueSummary)}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:12px 0;" />
      <p style="margin:0 0 6px;color:#666;">Conversation:</p>
      ${transcriptHtml(ticket.transcriptSnapshot)}
    </div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: TEMPLATE_FROM, to, subject: `${label} — ${shop}`, html }),
    });
    if (!res.ok) return { ok: false, error: `resend ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, messageId: body.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface DispatchResult {
  notified: boolean;
  channel: TicketChannel;
  whatsappLink?: string;
  meta: Record<string, unknown>;
}

/** Fan out a handoff to every configured channel in parallel: signed webhook,
 * email to the merchant, and a WhatsApp continuation link for the shopper.
 * `notified` = at least one channel accepted the handoff. */
export async function dispatchHandoffNotifications(shop: string, ticket: SupportTicket, support: SupportConfig): Promise<DispatchResult> {
  const meta: Record<string, unknown> = {};
  const payload = {
    event: "handoff",
    shop,
    ticketId: ticket.id,
    kind: ticket.kind,
    contactEmail: ticket.contactEmail,
    contactPhone: ticket.contactPhone,
    issueSummary: ticket.issueSummary,
    transcript: ticket.transcriptSnapshot,
    createdAt: ticket.createdAt,
  };

  const jobs: Array<Promise<void>> = [];
  let webhookOk = false;
  let emailOk = false;

  if (support.webhookUrl) {
    jobs.push(
      dispatchWebhook(support.webhookUrl, support.webhookSecret, "handoff", payload).then((r) => {
        meta.webhook = { ok: r.ok, statusCode: r.statusCode, error: r.error };
        webhookOk = r.ok;
      }),
    );
  }

  jobs.push(
    (async () => {
      const to = support.notifyEmail ?? (await recipientFor(shop));
      if (!to) {
        meta.email = { ok: false, error: "no recipient" };
        return;
      }
      const r = await sendSupportEmail(shop, ticket, to);
      meta.email = { ok: r.ok, messageId: r.messageId, error: r.error };
      emailOk = r.ok;
    })(),
  );

  await Promise.allSettled(jobs);

  const whatsappLink = support.whatsappNumber ? buildWhatsappLink(support.whatsappNumber, ticket.issueSummary) : undefined;
  // Channel reported to the widget: prefer webhook, else email, else whatsapp
  // (link-only), else none.
  const channel: TicketChannel = webhookOk ? "webhook" : emailOk ? "email" : whatsappLink ? "whatsapp" : "none";
  const notified = webhookOk || emailOk || !!whatsappLink;

  if (notified) await updateSupportCaseStatus(shop, ticket.id, "notified").catch(() => {});
  await prisma.$executeRawUnsafe(
    `UPDATE "SupportTicket" SET "channel" = $3, "channelMeta" = $4::jsonb, "updatedAt" = now() WHERE "shop" = $1 AND "id" = $2`,
    shop, ticket.id, channel, JSON.stringify(meta),
  ).catch(() => {});

  return { notified, channel, whatsappLink, meta };
}

export interface OpenTicketInput {
  issueSummary: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface OpenTicketResult {
  ok: boolean;
  channel: TicketChannel;
  externalId?: string;
  externalStatus?: string;
  meta: Record<string, unknown>;
}

/** Create a trackable ticket on the chosen channel. Phase 1 = webhook or email;
 * Phase 2 adds Freshdesk (loaded lazily so its absence never breaks Phase 1). */
export async function openTicketOnChannel(
  shop: string,
  channel: TicketChannel,
  support: SupportConfig,
  input: OpenTicketInput,
): Promise<OpenTicketResult> {
  if (channel === "freshdesk") {
    try {
      const { createFreshdeskTicket } = await import("./connectors/freshdesk.server");
      const r = await createFreshdeskTicket(support, {
        subject: input.issueSummary.slice(0, 120) || "Support request",
        description: input.issueSummary,
        email: input.contactEmail,
        phone: input.contactPhone,
      });
      return { ok: r.ok, channel, externalId: r.ticketId, externalStatus: r.status, meta: { freshdesk: r } };
    } catch (e) {
      return { ok: false, channel, meta: { error: (e as Error).message } };
    }
  }
  if (channel === "webhook" && support.webhookUrl) {
    const r = await dispatchWebhook(support.webhookUrl, support.webhookSecret, "ticket", { event: "ticket", shop, ...input });
    return { ok: r.ok, channel, meta: { webhook: { ok: r.ok, statusCode: r.statusCode, error: r.error } } };
  }
  // email fallback
  const to = support.notifyEmail ?? (await recipientFor(shop));
  if (!to) return { ok: false, channel: "email", meta: { error: "no recipient" } };
  // Build a minimal ticket-shaped object for the email body.
  const r = await sendSupportEmail(
    shop,
    {
      id: "", shop, sessionId: "", kind: "ticket", channel: "email", status: "notified",
      contactEmail: input.contactEmail, contactPhone: input.contactPhone,
      issueSummary: input.issueSummary, transcriptSnapshot: [], channelMeta: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    to,
  );
  return { ok: r.ok, channel: "email", meta: { email: { ok: r.ok, messageId: r.messageId, error: r.error } } };
}

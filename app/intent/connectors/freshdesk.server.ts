// Freshdesk adapter — the first real two-way CRM connector: create a trackable
// ticket and read its status back so the bot can answer "what's the status of
// my ticket". Basic auth = base64(apiKey + ":X") (Freshdesk ignores the
// password). Loaded lazily by tickets.server / chat.server so its absence never
// breaks the Phase 1 webhook/email channels.
import type { SupportConfig } from "../settings.server";

const TIMEOUT_MS = 8000;

// Freshdesk numeric ticket status → display string.
const STATUS_MAP: Record<number, string> = { 2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed" };
export function mapFreshdeskStatus(n: number | undefined): string {
  return (n != null && STATUS_MAP[n]) || "Open";
}

function authHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`${apiKey}:X`).toString("base64");
}

async function freshdeskFetch(cfg: SupportConfig, path: string, init: RequestInit): Promise<Response> {
  if (!cfg.freshdeskDomain || !cfg.freshdeskApiKey) throw new Error("freshdesk not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`https://${cfg.freshdeskDomain}.freshdesk.com${path}`, {
      ...init,
      headers: { authorization: authHeader(cfg.freshdeskApiKey), "content-type": "application/json", ...(init.headers ?? {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface CreateTicketInput {
  subject: string;
  description: string;
  email?: string;
  phone?: string;
}

export interface FreshdeskCreateResult {
  ok: boolean;
  ticketId?: string;
  status?: string;
  error?: string;
}

/** Create a ticket. Freshdesk requires an email (or phone/twitter_id/…); we send
 * a placeholder when the shopper gave neither so the call still succeeds. */
export async function createFreshdeskTicket(cfg: SupportConfig, input: CreateTicketInput): Promise<FreshdeskCreateResult> {
  try {
    const body: Record<string, unknown> = {
      subject: input.subject,
      description: input.description,
      email: input.email || "noreply@saleshq.ai",
      priority: 1,
      status: 2, // Open
    };
    if (input.phone) body.phone = input.phone;
    const res = await freshdeskFetch(cfg, "/api/v2/tickets", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) return { ok: false, error: `freshdesk ${res.status}` };
    const json = (await res.json()) as { id?: number; status?: number };
    return { ok: true, ticketId: json.id != null ? String(json.id) : undefined, status: mapFreshdeskStatus(json.status) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Read a ticket's current status. Returns null on any failure (caller falls
 * back to the last recorded status). */
export async function getFreshdeskTicketStatus(cfg: SupportConfig, ticketId: string): Promise<{ status: string } | null> {
  try {
    const res = await freshdeskFetch(cfg, `/api/v2/tickets/${encodeURIComponent(ticketId)}`, { method: "GET" });
    if (!res.ok) return null;
    const json = (await res.json()) as { status?: number };
    return { status: mapFreshdeskStatus(json.status) };
  } catch {
    return null;
  }
}

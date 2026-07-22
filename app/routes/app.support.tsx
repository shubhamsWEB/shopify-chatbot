// Merchant support queue: every human-handoff and CRM ticket the bot raised,
// newest first. Since the webhook/email channels have no inbound path, the
// merchant advances the lifecycle here (mark replied/resolved/closed); Freshdesk
// tickets can be refreshed to re-pull their live status. Mirrors the knowledge
// route's loader/action shape.
import type { HeadersFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getSettings } from "../intent/settings.server";
import {
  listSupportCases, updateSupportCaseStatus, updateSupportCaseExternalStatus, getSupportCaseById,
  type SupportTicket, type TicketStatus,
} from "../intent/tickets.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const tickets = await listSupportCases(session.shop, { limit: 200 });
  return { tickets, freshdeskDomain: settings.support.freshdeskDomain ?? null };
};

const STATUSES: TicketStatus[] = ["open", "notified", "replied", "resolved", "closed"];

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  try {
    if (intent === "updateStatus") {
      const status = String(form.get("status") ?? "") as TicketStatus;
      if (!STATUSES.includes(status)) return { ok: false, error: "bad status" };
      await updateSupportCaseStatus(shop, id, status);
      return { ok: true, at: Date.now() };
    }
    if (intent === "refresh") {
      const ticket = await getSupportCaseById(shop, id);
      if (!ticket || ticket.channel !== "freshdesk" || !ticket.externalTicketId) {
        return { ok: false, error: "not a Freshdesk ticket" };
      }
      const settings = await getSettings(shop);
      const { getFreshdeskTicketStatus } = await import("../intent/connectors/freshdesk.server");
      const fresh = await getFreshdeskTicketStatus(settings.support, ticket.externalTicketId);
      if (fresh?.status) await updateSupportCaseExternalStatus(shop, ticket.id, fresh.status);
      return { ok: true, status: fresh?.status ?? null, at: Date.now() };
    }
    return { ok: false, error: "unknown action" };
  } catch (err) {
    console.error("[support] action failed:", (err as Error).message);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
};

const cellStyle: React.CSSProperties = { padding: "8px 10px", verticalAlign: "top", fontSize: 13, borderBottom: "1px solid #eef0f2" };
const statusTone: Record<TicketStatus, "info" | "warning" | "success" | "neutral"> = {
  open: "warning", notified: "info", replied: "info", resolved: "success", closed: "neutral",
};

function TicketRow({ t, freshdeskDomain }: { t: SupportTicket; freshdeskDomain: string | null }) {
  const fetcher = useFetcher<typeof action>();
  const contact = [t.contactEmail, t.contactPhone].filter(Boolean).join(" · ") || "—";
  const ref = t.externalTicketId ?? t.id;
  const fdLink = t.channel === "freshdesk" && freshdeskDomain && t.externalTicketId
    ? `https://${freshdeskDomain}.freshdesk.com/a/tickets/${t.externalTicketId}` : null;
  return (
    <tr>
      <td style={cellStyle}>{new Date(t.createdAt).toLocaleString()}</td>
      <td style={cellStyle}>
        <s-badge tone="neutral">{t.kind}</s-badge> <s-badge tone="neutral">{t.channel}</s-badge>
      </td>
      <td style={cellStyle}>{contact}</td>
      <td style={{ ...cellStyle, maxWidth: 320 }}>{t.issueSummary || "—"}</td>
      <td style={cellStyle}>
        <s-badge tone={statusTone[t.status]}>{t.externalStatus ?? t.status}</s-badge>
        {fdLink && <div><s-link href={fdLink} target="_blank">{ref}</s-link></div>}
      </td>
      <td style={cellStyle}>
        <select
          value={t.status}
          onChange={(e) => fetcher.submit({ intent: "updateStatus", id: t.id, status: e.currentTarget.value }, { method: "post" })}
          style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {t.channel === "freshdesk" && (
          <s-button onClick={() => fetcher.submit({ intent: "refresh", id: t.id }, { method: "post" })}>Refresh</s-button>
        )}
      </td>
    </tr>
  );
}

export default function Support() {
  const { tickets, freshdeskDomain } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Support tickets">
      <s-section heading={`${tickets.length} handoff${tickets.length === 1 ? "" : "s"} & tickets`}>
        {tickets.length === 0 ? (
          <s-text tone="neutral">No handoffs or tickets yet. When a shopper asks the assistant for a human, they'll appear here.</s-text>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["When", "Type", "Contact", "Issue", "Status", "Action"].map((h) => (
                    <th key={h} style={{ ...cellStyle, textAlign: "left", fontWeight: 600, color: "#6b7280" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => <TicketRow key={t.id} t={t} freshdeskDomain={freshdeskDomain} />)}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
export { EmbeddedErrorBoundary as ErrorBoundary } from "../embedded-boundary";

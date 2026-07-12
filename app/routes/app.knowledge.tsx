// Merchant knowledge manager: create / edit / draft / delete the OKF documents
// (FAQs, policies, offers) the storefront assistant answers from. Markdown body
// is the source of truth; the live preview shows exactly how it splits into the
// sections the bot retrieves. Saved per shop, enforced server-side.
import type { HeadersFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useMemo, useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listDocs, saveDoc, deleteDoc, CountCapError, ConflictError } from "../intent/knowledge.server";
import { geminiConfigured, monthlyPdfPages, type ParsedOkf } from "../intent/pdfparse.server";
import type { action as parseAction } from "./app.knowledge.parse";
import { getBackofficeMeta } from "../intent/settings.server";
import { listKnowledgeGaps, dismissKnowledgeGaps, resolveCoveredGaps, clusterGaps, type GapCluster } from "../intent/knowledgegaps.server";
import { pdfPageCapFor, TRIAL_PDF_PAGE_CAP } from "../intent/plans";
import {
  OKF_KINDS, KIND_LABEL, CAPS, deriveSections, offerState,
  type OkfKind, type OkfDoc,
} from "../intent/okf";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [docs, meta, pdfPagesUsed, gaps] = await Promise.all([
    listDocs(shop),
    getBackofficeMeta(shop),
    monthlyPdfPages(shop),
    listKnowledgeGaps(shop),
  ]);
  // meta.pdfPageLimit is synced by ensureBillingState (parent app.tsx loader,
  // runs before every child route) — falls back to the trial cap only if that
  // sync hasn't happened yet (e.g. a very first request).
  const pdfPageCap = meta.pdfPageLimit !== undefined ? meta.pdfPageLimit : pdfPageCapFor(meta.plan) ?? TRIAL_PDF_PAGE_CAP;
  return { docs, caps: CAPS, pdfEnabled: geminiConfigured(), pdfPagesUsed, pdfPageCap, pdfPageBalance: meta.pdfPageBalance ?? 0, gapClusters: clusterGaps(gaps) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "delete") {
      await deleteDoc(shop, String(form.get("id") ?? ""));
      return { ok: true, deleted: true, at: Date.now() };
    }
    if (intent === "dismissGap") {
      const ids = String(form.get("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      await dismissKnowledgeGaps(shop, ids);
      return { ok: true, gapDismissed: true, at: Date.now() };
    }
    if (intent === "save") {
      const id = String(form.get("id") ?? "").trim();
      const kind = String(form.get("kind") ?? "general") as OkfKind;
      const tags = String(form.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const doc = await saveDoc(shop, {
        id: id || undefined,
        kind: OKF_KINDS.includes(kind) ? kind : "general",
        title: String(form.get("title") ?? ""),
        body: String(form.get("body") ?? ""),
        tags,
        effectiveFrom: (String(form.get("effectiveFrom") ?? "") || null),
        effectiveTo: (String(form.get("effectiveTo") ?? "") || null),
        status: form.get("status") === "draft" ? "draft" : "published",
        expectedUpdatedAt: (String(form.get("expectedUpdatedAt") ?? "") || null),
      });
      // Close the loop: anything the just-published content now answers drops
      // off the knowledge-gaps list automatically (same ranking the bot uses).
      if (doc.status === "published") await resolveCoveredGaps(shop);
      return { ok: true, saved: true, doc, at: Date.now() };
    }
    return { ok: false, error: "Unknown action." };
  } catch (err) {
    if (err instanceof CountCapError || err instanceof ConflictError) {
      // Merchant-safe message, but still log it — a silent ok:false made the
      // first prod PDF-upload failure undiagnosable from logs (2026-07-09).
      console.error(`[knowledge] ${intent} rejected:`, err.message);
      return { ok: false, error: err.message };
    }
    console.error("[knowledge] action failed:", (err as Error).message);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
};

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px",
  border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, fontFamily: "inherit",
};

type Editing = { doc: OkfDoc | null; prefill?: ParsedOkf; prefillSource?: "pdf" | "gap" } | null; // {doc:null} = creating new

function toDateInput(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10); // yyyy-mm-dd
}

export default function Knowledge() {
  const { docs, caps, pdfEnabled, pdfPagesUsed, pdfPageCap, pdfPageBalance, gapClusters } = useLoaderData<typeof loader>();
  const pdfAtCap = pdfPageCap != null && pdfPagesUsed >= pdfPageCap + pdfPageBalance;
  // Union with the parse resource route's action — the upload input posts there.
  const fetcher = useFetcher<typeof action | typeof parseAction>();
  const [editing, setEditing] = useState<Editing>(null);
  const [tab, setTab] = useState<"docs" | "gaps">("docs");
  const busy = fetcher.state !== "idle";

  // React to a completed round-trip: a parse result opens the editor prefilled;
  // a save/delete closes it. (Both return ok:true — distinguished by `parsed`.)
  const lastAt = fetcher.data?.at;
  const [seenAt, setSeenAt] = useState<number | undefined>(undefined);
  if (lastAt && lastAt !== seenAt && fetcher.data?.ok) {
    setSeenAt(lastAt);
    if ("parsed" in fetcher.data && fetcher.data.parsed) {
      setEditing({ doc: null, prefill: fetcher.data.parsed, prefillSource: "pdf" });
    } else if (editing) {
      setEditing(null);
    }
  }

  if (editing) {
    return (
      <Editor
        key={editing.doc?.id ?? "new"}
        doc={editing.doc}
        prefill={editing.prefill}
        prefillSource={editing.prefillSource}
        caps={caps}
        busy={busy}
        error={fetcher.data && !fetcher.data.ok ? fetcher.data.error : undefined}
        onCancel={() => setEditing(null)}
        onSave={(fd) => fetcher.submit(fd, { method: "post" })}
      />
    );
  }

  const grouped = OKF_KINDS.map((k) => ({ kind: k, items: docs.filter((d) => d.kind === k) }));
  const gapTotal = gapClusters.reduce((n, c) => n + c.count, 0);

  const tabStyle = (on: boolean): React.CSSProperties => ({
    padding: "9px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer",
    border: "none", background: "none", color: on ? "#111" : "#6d7175",
    borderBottom: on ? "2.5px solid #111" : "2.5px solid transparent", marginBottom: -1,
  });

  return (
    <s-page heading="Knowledge">
      {/* Tabs: Documents | Unanswered questions */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #e5e7eb" }}>
        <button style={tabStyle(tab === "docs")} onClick={() => setTab("docs")}>
          Documents ({docs.length})
        </button>
        <button style={tabStyle(tab === "gaps")} onClick={() => setTab("gaps")}>
          Unanswered questions ({gapClusters.length})
        </button>
      </div>

      {tab === "gaps" && (
        <s-section>
          <s-stack direction="block" gap="base">
            <s-text tone="neutral">
              Real questions shoppers asked where the assistant had nothing documented to answer from — similar
              phrasings are grouped together. Write the missing answer and the group disappears automatically the
              moment your published docs cover it.
            </s-text>
            {fetcher.data && !fetcher.data.ok && (
              <s-banner tone="critical" heading="Couldn't complete that">{fetcher.data.error}</s-banner>
            )}
            {gapClusters.length === 0 ? (
              <s-text tone="neutral">No unanswered questions — everything shoppers have asked is covered.</s-text>
            ) : (
              <s-stack direction="block" gap="small">
                {gapClusters.slice(0, 15).map((c: GapCluster) => (
                  <s-box key={c.ids[0]} padding="small-200" borderWidth="base" borderRadius="base">
                    <s-stack direction="inline" gap="base">
                      <s-stack direction="block" gap="small-500">
                        <s-text><b>&ldquo;{c.query}&rdquo;</b></s-text>
                        <s-text tone="neutral">
                          Asked {c.count} time{c.count === 1 ? "" : "s"}
                          {c.variants.length > 0 ? ` · ${c.variants.length} similar phrasing${c.variants.length === 1 ? "" : "s"}` : ""}
                          {` · last ${new Date(c.lastAsked).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                        </s-text>
                        {c.variants.length > 0 && (
                          <s-text tone="neutral">
                            Also asked as: {c.variants.slice(0, 3).map((v) => `“${v}”`).join(", ")}{c.variants.length > 3 ? "…" : ""}
                          </s-text>
                        )}
                      </s-stack>
                      <s-stack direction="inline" gap="small">
                        <s-button
                          variant="primary"
                          onClick={() =>
                            setEditing({
                              doc: null,
                              prefillSource: "gap",
                              prefill: {
                                title: c.query.charAt(0).toUpperCase() + c.query.slice(1),
                                kind: "faq",
                                markdown: `## ${c.query.charAt(0).toUpperCase() + c.query.slice(1)}\n\n`,
                                effectiveFrom: null,
                                effectiveTo: null,
                              },
                            })
                          }
                          {...(busy || docs.length >= caps.docsPerShop ? { disabled: true } : {})}
                        >
                          Write an answer
                        </s-button>
                        <s-button
                          onClick={() => {
                            const fd = new FormData();
                            fd.set("intent", "dismissGap");
                            fd.set("ids", c.ids.join(","));
                            fetcher.submit(fd, { method: "post" });
                          }}
                          {...(busy ? { disabled: true } : {})}
                        >
                          Dismiss
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </s-box>
                ))}
                {gapClusters.length > 15 && (
                  <s-text tone="neutral">Showing the 15 most-asked of {gapClusters.length} groups ({gapTotal} total asks).</s-text>
                )}
              </s-stack>
            )}
          </s-stack>
        </s-section>
      )}

      {tab === "docs" && (
      <>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-text tone="neutral">
            Give the assistant your store&apos;s own answers — return &amp; shipping policies, FAQs, and current
            offers. Shoppers get grounded answers pulled straight from what you write here, and offers turn
            themselves off when they expire. {docs.length}/{caps.docsPerShop} documents used.
          </s-text>
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              onClick={() => setEditing({ doc: null })}
              {...(docs.length >= caps.docsPerShop ? { disabled: true } : {})}
            >
              Add document
            </s-button>
            {pdfEnabled && docs.length < caps.docsPerShop && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 14, cursor: busy || pdfAtCap ? "default" : "pointer", opacity: busy || pdfAtCap ? 0.5 : 1 }}>
                {busy ? "Reading PDF…" : "Import from PDF"}
                <input
                  type="file" accept="application/pdf" style={{ display: "none" }} disabled={busy || pdfAtCap}
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    if (!file) return;
                    const fd = new FormData();
                    fd.set("intent", "parse");
                    fd.set("file", file);
                    fetcher.submit(fd, { method: "post", encType: "multipart/form-data", action: "/app/knowledge/parse" });
                    e.currentTarget.value = ""; // allow re-selecting the same file
                  }}
                />
              </label>
            )}
            {pdfEnabled && pdfPageCap != null && (
              <s-text tone={pdfAtCap ? "critical" : "neutral"}>
                {pdfPagesUsed}/{pdfPageCap} PDF pages this cycle{pdfPageBalance > 0 ? ` (+${pdfPageBalance.toLocaleString()} top-up)` : ""}
              </s-text>
            )}
            {docs.length >= caps.docsPerShop && <s-text tone="neutral">Document limit reached — delete one to add another.</s-text>}
          </s-stack>
          {pdfAtCap && (
            <s-banner tone="warning" heading="Monthly PDF import limit reached">
              You&apos;ve used {pdfPagesUsed}/{pdfPageCap} pages this cycle. Buy a top-up pack on the Plan &amp; usage page
              (every pack includes extra PDF pages), upgrade your plan, wait for the next cycle, or keep adding
              documents with the Markdown editor above — that has no page limit.
            </s-banner>
          )}
          {fetcher.data && !fetcher.data.ok && !editing && (
            <s-banner tone="critical" heading="Couldn't import">{fetcher.data.error}</s-banner>
          )}
        </s-stack>
      </s-section>

      {docs.length === 0 ? (
        <s-section>
          <s-text tone="neutral">No documents yet. Add your return policy or a few FAQs to get started.</s-text>
        </s-section>
      ) : (
        grouped.filter((g) => g.items.length > 0).map((g) => (
          <s-section key={g.kind} heading={`${KIND_LABEL[g.kind]} (${g.items.length})`}>
            <s-stack direction="block" gap="small">
              {g.items.map((d) => (
                <DocRow key={d.id} doc={d} onEdit={() => setEditing({ doc: d })} onDelete={() => {
                  const fd = new FormData();
                  fd.set("intent", "delete");
                  fd.set("id", d.id);
                  fetcher.submit(fd, { method: "post" });
                }} busy={busy} />
              ))}
            </s-stack>
          </s-section>
        ))
      )}
      </>
      )}
    </s-page>
  );
}

function DocRow({ doc, onEdit, onDelete, busy }: { doc: OkfDoc; onEdit: () => void; onDelete: () => void; busy: boolean }) {
  const state = offerState(doc);
  return (
    <s-box padding="small-200" borderWidth="base" borderRadius="base">
      <s-stack direction="inline" gap="base">
        <s-stack direction="block" gap="small-500">
          <s-stack direction="inline" gap="small">
            <s-text><b>{doc.title}</b></s-text>
            {doc.status === "draft" && <s-badge>Draft</s-badge>}
            {state === "live" && <s-badge tone="success">Live</s-badge>}
            {state === "scheduled" && <s-badge tone="info">Scheduled</s-badge>}
            {state === "expired" && <s-badge tone="neutral">Expired</s-badge>}
          </s-stack>
          <s-text tone="neutral">
            {doc.sections.length} section{doc.sections.length === 1 ? "" : "s"}
            {doc.tags.length ? ` · ${doc.tags.join(", ")}` : ""}
            {` · updated ${new Date(doc.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
          </s-text>
        </s-stack>
        <s-stack direction="inline" gap="small">
          <s-button onClick={onEdit} {...(busy ? { disabled: true } : {})}>Edit</s-button>
          <s-button tone="critical" onClick={onDelete} {...(busy ? { disabled: true } : {})}>Delete</s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

function Editor({
  doc, prefill, prefillSource, caps, busy, error, onCancel, onSave,
}: {
  doc: OkfDoc | null;
  prefill?: ParsedOkf;
  prefillSource?: "pdf" | "gap";
  caps: typeof CAPS;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onSave: (fd: FormData) => void;
}) {
  const [kind, setKind] = useState<OkfKind>(doc?.kind ?? prefill?.kind ?? "faq");
  const [title, setTitle] = useState(doc?.title ?? prefill?.title ?? "");
  const [body, setBody] = useState(doc?.body ?? prefill?.markdown ?? "");
  const [tags, setTags] = useState(doc?.tags.join(", ") ?? "");
  const [from, setFrom] = useState(toDateInput(doc?.effectiveFrom ?? prefill?.effectiveFrom ?? null));
  const [to, setTo] = useState(toDateInput(doc?.effectiveTo ?? prefill?.effectiveTo ?? null));

  // Live preview: the exact split the bot will retrieve. Pure, client-side.
  const sections = useMemo(() => deriveSections(body), [body]);

  const submit = (status: "published" | "draft") => {
    const fd = new FormData();
    fd.set("intent", "save");
    if (doc) {
      fd.set("id", doc.id);
      fd.set("expectedUpdatedAt", doc.updatedAt);
    }
    fd.set("kind", kind);
    fd.set("title", title);
    fd.set("body", body);
    fd.set("tags", tags);
    fd.set("status", status);
    if (kind === "offer") {
      fd.set("effectiveFrom", from);
      fd.set("effectiveTo", to);
    }
    onSave(fd);
  };

  return (
    <s-page heading={doc ? "Edit document" : prefillSource === "gap" ? "Answer a shopper question" : prefill ? "Review imported document" : "New document"}>
      {error && (
        <s-banner tone="critical" heading="Couldn't save">{error}</s-banner>
      )}
      {prefill && !error && prefillSource === "gap" && (
        <s-banner tone="info" heading="Answering an unanswered question">
          Shoppers asked this and the assistant had nothing to answer from. Write the answer under the heading below,
          then publish — the question drops off the unanswered list automatically once your published docs cover it.
        </s-banner>
      )}
      {prefill && !error && prefillSource !== "gap" && (
        <s-banner tone="info" heading="Imported from your PDF">
          We converted your PDF below. Check the title, type, and sections, fix anything that looks off, then publish. Nothing reaches the assistant until you publish.
        </s-banner>
      )}
      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small-300">
            <s-text>Type</s-text>
            <select value={kind} onChange={(e) => setKind(e.currentTarget.value as OkfKind)} style={{ ...inputStyle, width: 220 }}>
              {OKF_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <s-text tone="neutral">
              {kind === "faq" && "Each heading is a question the assistant can answer."}
              {kind === "policy" && "Returns, shipping, warranty — always in scope for the bot."}
              {kind === "offer" && "A promotion. Set dates below; it hides itself automatically when it expires."}
              {kind === "general" && "Brand story, sizing guide, care instructions — anything else."}
            </s-text>
          </s-stack>

          <s-stack direction="block" gap="small-300">
            <s-text>Title</s-text>
            <input value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={300}
              placeholder="e.g. Return & Refund Policy" style={inputStyle} />
          </s-stack>

          {kind === "offer" && (
            <s-stack direction="inline" gap="base">
              <s-stack direction="block" gap="small-300">
                <s-text>Starts</s-text>
                <input type="date" value={from} onChange={(e) => setFrom(e.currentTarget.value)} style={{ ...inputStyle, width: 180 }} />
              </s-stack>
              <s-stack direction="block" gap="small-300">
                <s-text>Ends</s-text>
                <input type="date" value={to} onChange={(e) => setTo(e.currentTarget.value)} style={{ ...inputStyle, width: 180 }} />
              </s-stack>
            </s-stack>
          )}

          <s-stack direction="block" gap="small-300">
            <s-text>Content (Markdown)</s-text>
            <s-text tone="neutral">Use <b># headings</b> to break the document into sections. Each section becomes a retrievable answer.</s-text>
            <textarea value={body} onChange={(e) => setBody(e.currentTarget.value)} rows={16} maxLength={caps.bodyChars}
              placeholder={"## Returns\nYou can return any item within 30 days for a full refund.\n\n## Exchanges\n..."}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "ui-monospace, monospace" }} />
            <s-text tone="neutral">{body.length}/{caps.bodyChars}</s-text>
          </s-stack>

          <s-stack direction="block" gap="small-300">
            <s-text>Tags (optional, comma-separated)</s-text>
            <input value={tags} onChange={(e) => setTags(e.currentTarget.value)}
              placeholder="shipping, international" style={inputStyle} />
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading={`Preview — ${sections.length} section${sections.length === 1 ? "" : "s"} the assistant will read`}>
        {sections.length === 0 ? (
          <s-text tone="neutral">Nothing yet. Start typing above; add # headings to create sections.</s-text>
        ) : (
          <s-stack direction="block" gap="small">
            {sections.map((s, i) => (
              <s-box key={i} padding="small-200" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-500">
                  <s-text><b>{s.heading || "(intro)"}</b></s-text>
                  {/* Full section text — this is exactly what the assistant reads,
                      so the merchant must be able to review every word of it. */}
                  <div style={{ maxHeight: 260, overflowY: "auto", fontSize: 13, lineHeight: 1.55, color: "#6d7175", whiteSpace: "pre-wrap" }}>
                    {s.text}
                  </div>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section>
        <s-stack direction="inline" gap="base">
          <s-button variant="primary" onClick={() => submit("published")} {...(busy || !title.trim() || !body.trim() ? { disabled: true } : {})}>
            {busy ? "Saving…" : "Publish"}
          </s-button>
          <s-button onClick={() => submit("draft")} {...(busy || !title.trim() ? { disabled: true } : {})}>
            Save as draft
          </s-button>
          <s-button onClick={onCancel} {...(busy ? { disabled: true } : {})}>Cancel</s-button>
        </s-stack>
        <s-text tone="neutral">Published documents reach the assistant within a minute. Drafts stay hidden from shoppers.</s-text>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
export { EmbeddedErrorBoundary as ErrorBoundary } from "../embedded-boundary";

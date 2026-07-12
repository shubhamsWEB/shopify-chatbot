// OKF (Open Knowledge Format) — pure, isomorphic helpers shared by the server
// module (knowledge.server.ts) and the merchant editor UI (app.knowledge.tsx).
// No prisma / no server imports here, so the client bundle can use section
// derivation for the live preview.

export type OkfKind = "faq" | "policy" | "offer" | "general";
export const OKF_KINDS: OkfKind[] = ["faq", "policy", "offer", "general"];
export const KIND_LABEL: Record<OkfKind, string> = { faq: "FAQ", policy: "Policy", offer: "Offer", general: "Info" };

export interface OkfSection {
  heading: string; // "" for the lede before the first heading
  text: string; // plain-text projection of the section body
  anchor: string; // slug of the heading — stable id for citations
}

export interface OkfDoc {
  id: string;
  shop: string;
  kind: OkfKind;
  title: string;
  body: string; // markdown — editable source of truth
  sections: OkfSection[]; // derived from body on save
  tags: string[];
  effectiveFrom: string | null; // ISO — offers only
  effectiveTo: string | null; // ISO — offers only
  status: "published" | "draft"; // draft = invisible to the bot
  updatedAt: string;
}

export interface KnowledgeHit {
  docTitle: string;
  kind: OkfKind;
  heading: string;
  text: string;
  anchor: string;
}

export interface SaveDocInput {
  id?: string; // absent = create
  kind: OkfKind;
  title: string;
  body: string;
  tags?: string[];
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  status?: "published" | "draft";
  sourceBlobUrl?: string | null;
  expectedUpdatedAt?: string | null; // optimistic lock on edit
}

// Hard caps (plan §09) — a giant paste can't blow the prompt budget, and the
// per-shop corpus stays bounded so all-in-memory scoring is cheap.
export const CAPS = {
  docsPerShop: 30,
  sectionsPerDoc: 60,
  charsPerSection: 3000,
  tagsPerDoc: 10,
  bodyChars: 60_000,
  indexTokenBudget: 1500, // Tier-1 index ceiling (approx via chars/4)
};

export const slugify = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// Strip markdown to a plain-text projection for search + prompt injection:
// unwrap links/images to their text, drop emphasis/heading/list/code markers.
export function toPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/^[>\s]*#{1,6}\s+/gm, "") // heading markers
    .replace(/^[-*+]\s+/gm, "") // bullet markers
    .replace(/^\d+\.\s+/gm, "") // ordered markers
    .replace(/[*_~]{1,3}/g, "") // emphasis
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Split a markdown body into sections on ATX headings (# .. ######). Text
// before the first heading becomes a leading section with heading "". Empty
// sections dropped; count + per-section length capped.
export function deriveSections(body: string): OkfSection[] {
  const lines = body.split(/\r?\n/);
  const chunks: Array<{ heading: string; lines: string[] }> = [{ heading: "", lines: [] }];
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) chunks.push({ heading: m[2].trim(), lines: [] });
    else chunks[chunks.length - 1].lines.push(line);
  }
  const out: OkfSection[] = [];
  const seen = new Map<string, number>();
  for (const c of chunks) {
    const text = toPlainText(c.lines.join("\n")).slice(0, CAPS.charsPerSection);
    if (!text) continue; // empty lede or heading with no body — nothing to retrieve
    let anchor = slugify(c.heading) || "section";
    const n = seen.get(anchor) ?? 0; // de-dupe repeated headings
    seen.set(anchor, n + 1);
    if (n > 0) anchor = `${anchor}-${n}`;
    out.push({ heading: c.heading, text, anchor });
    if (out.length >= CAPS.sectionsPerDoc) break;
  }
  return out;
}

// An offer is live now iff within its window (unset bound = open). Non-offers
// are always in scope.
export function offerLive(d: Pick<OkfDoc, "kind" | "effectiveFrom" | "effectiveTo">, now = Date.now()): boolean {
  if (d.kind !== "offer") return true;
  if (d.effectiveFrom && Date.parse(d.effectiveFrom) > now) return false;
  if (d.effectiveTo && Date.parse(d.effectiveTo) < now) return false;
  return true;
}

// Offer scheduling state for a merchant-facing badge.
export function offerState(d: Pick<OkfDoc, "kind" | "effectiveFrom" | "effectiveTo">, now = Date.now()): "live" | "scheduled" | "expired" | null {
  if (d.kind !== "offer") return null;
  if (d.effectiveFrom && Date.parse(d.effectiveFrom) > now) return "scheduled";
  if (d.effectiveTo && Date.parse(d.effectiveTo) < now) return "expired";
  return "live";
}

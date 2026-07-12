// Resource route for PDF → OKF parsing, POSTed to by the Knowledge page's
// upload input. Lives apart from app.knowledge so the long maxDuration only
// applies HERE: a per-route config makes Vercel build the route into its own
// serverless function, and keeping that split off the NAVIGATED knowledge
// route keeps its deployment shape identical to every other admin page
// (settings/billing) — no special-casing on the page merchants click to.
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  parsePdfToOkf, PdfParseError, geminiConfigured, allowParse,
  countPdfPages, bumpPdfPageCount, monthlyPdfPages, spendPdfPageBalance,
} from "../intent/pdfparse.server";
import { getBackofficeMeta } from "../intent/settings.server";
import { pdfPageCapFor, TRIAL_PDF_PAGE_CAP } from "../intent/plans";

// Gemini parse of a multi-page PDF can take tens of seconds even with
// thinking disabled — rare merchant action, give it the full window.
export const config = { maxDuration: 300 };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  try {
    if (!geminiConfigured()) return { ok: false as const, error: "PDF import isn't set up for this store yet." };
    if (!allowParse(shop)) return { ok: false as const, error: "You've hit today's PDF import limit. Try again tomorrow, or paste the content in manually." };
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false as const, error: "No file received. Please choose a PDF." };
    const buf = new Uint8Array(await file.arrayBuffer());
    const pages = countPdfPages(buf);

    // Plan-limit gate: check BEFORE spending on the Gemini call. The monthly
    // cap spends first; the non-expiring top-up page balance (bundled with
    // reply top-up packs) covers whatever a parse needs beyond it.
    const [meta, usedPages] = await Promise.all([getBackofficeMeta(shop), monthlyPdfPages(shop)]);
    const cap = meta.pdfPageLimit !== undefined ? meta.pdfPageLimit : pdfPageCapFor(meta.plan) ?? TRIAL_PDF_PAGE_CAP;
    const balance = meta.pdfPageBalance ?? 0;
    let fromBalance = 0;
    if (cap != null) {
      const remainingCap = Math.max(0, cap - usedPages);
      fromBalance = Math.max(0, pages - remainingCap);
      if (fromBalance > balance) {
        return {
          ok: false as const,
          error: `This PDF is ${pages} page${pages === 1 ? "" : "s"} and would go over your monthly import limit (${usedPages}/${cap} pages used this cycle${balance > 0 ? `, +${balance} top-up pages left` : ""}). Buy a top-up pack, upgrade your plan, wait for next cycle, or paste the content in manually.`,
        };
      }
    }

    console.log("[knowledge] parse start", JSON.stringify({ shop, name: file.name, bytes: buf.byteLength, pages, fromBalance }));
    const parsed = await parsePdfToOkf(shop, buf);
    await bumpPdfPageCount(shop, pages);
    if (fromBalance > 0) await spendPdfPageBalance(shop, fromBalance);
    console.log("[knowledge] parse ok", JSON.stringify({ shop, title: parsed.title, kind: parsed.kind, chars: parsed.markdown.length, pages, fromBalance }));
    return { ok: true as const, parsed, at: Date.now() };
  } catch (err) {
    if (err instanceof PdfParseError) {
      console.error("[knowledge] parse rejected:", err.message);
      return { ok: false as const, error: err.message };
    }
    console.error("[knowledge] parse failed:", (err as Error).message);
    return { ok: false as const, error: "Something went wrong reading that PDF. Please try again." };
  }
};

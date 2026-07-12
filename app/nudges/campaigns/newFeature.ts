// Broadcast announcements. Each entry = one feature, sent once ever to every
// shop after its release date. All use the reusable "announcement" Resend
// template — content is passed as variables, so a new announcement is just a
// new entry here (no new template needed).
import type { Campaign, Step } from "../types";

const APP_URL = process.env.SHOPIFY_APP_URL ?? "https://admin.shopify.com";

function announcement(opts: {
  id: string;
  releaseAt: string; // ISO date
  subject: string;
  preheader: string;
  heading: string;
  bodyHtml: string; // raw HTML, injected into the template's BODY_HTML var
  cta?: { label: string; url: string };
}): Step {
  const releaseMs = Date.parse(opts.releaseAt);
  return {
    id: opts.id,
    due: (ctx) => ctx.now.getTime() >= releaseMs,
    render: (ctx) => ({
      templateKey: "announcement",
      variables: {
        SUBJECT: opts.subject,
        PREHEADER: opts.preheader,
        HEADING: opts.heading,
        BODY_HTML: opts.bodyHtml,
        CTA_LABEL: opts.cta?.label ?? "Open SalesHQ",
        // ?shop= routes the merchant through auth into their own admin.
        CTA_URL: `${opts.cta?.url ?? `${APP_URL}/app`}?shop=${ctx.shop}`,
      },
    }),
  };
}

export const newFeature: Campaign = {
  key: "announcements",
  shouldEnroll: () => true, // narrow later, e.g. paid plans only
  steps: [
    announcement({
      id: "intent-engine-v2",
      releaseAt: "2026-07-15",
      subject: "New: your assistant now spots buying intent earlier",
      preheader: "Smarter intent detection is live on your store — already on, nothing to configure.",
      heading: "Your assistant just got sharper",
      bodyHtml:
        "<p style='margin:0 0 16px;font-size:16px;line-height:1.6;color:#4a4a63'>Our new intent engine reads buying signals earlier in the visit and prompts shoppers at the moment they’re most likely to act. It’s already running on your store — no setup, no settings to change.</p>",
      cta: { label: "See it in action", url: `${APP_URL}/app` },
    }),
  ],
};

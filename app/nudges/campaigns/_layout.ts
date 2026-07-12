// Branded email shell. Email clients are hostile: no external CSS, flaky fl​ex,
// Outlook uses Word's renderer. So: table-based layout, everything inline,
// bulletproof (VML) CTA button, 600px card, hidden preheader. Tune the brand in
// THEME — that's the one place to change colours/wordmark.
export const THEME = {
  wordmark: "SalesHQ",
  logoUrl: "https://www.saleshq.ai/logo.png",
  accent: "#2f6bf6", // primary brand / buttons / links — matches the logo blue
  ink: "#1a1a2e", // headings
  body: "#4a4a63", // paragraph text
  muted: "#9494a8", // footer / secondary
  pageBg: "#f4f3fb", // outer canvas
  cardBg: "#ffffff",
  border: "#ececf4",
  warn: "#e8590c", // limit-reaching accent
  danger: "#d6336c", // limit-exhausted accent
  founder: {
    name: "Shubham Agrawal",
    title: "Founder, SalesHQ",
    // Served from the app's public/ dir (public/founder.jpg).
    photoUrl: `${process.env.SHOPIFY_APP_URL ?? "https://saleshq-chatbot.vercel.app"}/founder.jpg`,
  },
};

export interface EmailParts {
  /** Inbox preview line (hidden in body). */
  preheader: string;
  heading: string;
  /** Body HTML — use `p()`, `bullets()`, `callout()`, `usageBar()` helpers. */
  body: string;
  cta?: { label: string; url: string };
  /** Overrides the accent for this email (limit emails use warn/danger). */
  accent?: string;
}

export const p = (html: string): string =>
  `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${THEME.body}">${html}</p>`;

export const bullets = (items: string[]): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px">${items
    .map(
      (it) =>
        `<tr><td style="padding:4px 10px 4px 0;vertical-align:top;color:${THEME.accent};font-size:16px">●</td>
         <td style="padding:4px 0;font-size:15px;line-height:1.5;color:${THEME.body}">${it}</td></tr>`,
    )
    .join("")}</table>`;

export const callout = (html: string, color = THEME.accent): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
    <tr><td style="border-left:4px solid ${color};background:${color}0d;padding:14px 18px;border-radius:6px;font-size:15px;line-height:1.5;color:${THEME.ink}">${html}</td></tr>
  </table>`;

/** Visual usage meter for the limit emails. pct 0..100. */
export const usageBar = (used: number, limit: number, color = THEME.warn): string => {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
    <tr><td style="font-size:13px;color:${THEME.muted};padding-bottom:6px">${used.toLocaleString()} of ${limit.toLocaleString()} conversations · ${pct}%</td></tr>
    <tr><td style="background:${THEME.border};border-radius:999px;height:10px;line-height:10px;font-size:0">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:${pct}%;min-width:8px"><tr>
        <td style="background:${color};border-radius:999px;height:10px;line-height:10px;font-size:0">&nbsp;</td>
      </tr></table>
    </td></tr>
  </table>`;
};

function button(label: string, url: string, accent: string): string {
  // Bulletproof: VML rect for Outlook, padded anchor for everyone else.
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr><td>
    <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${url}" style="height:46px;v-text-anchor:middle;width:220px" arcsize="18%" fillcolor="${accent}" stroke="f"><center style="color:#ffffff;font-family:sans-serif;font-size:16px;font-weight:bold">${label}</center></v:roundrect><![endif]-->
    <!--[if !mso]><!--><a href="${url}" style="display:inline-block;background:${accent};color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:13px 28px;border-radius:8px">${label}</a><!--<![endif]-->
  </td></tr></table>`;
}

export function layout(parts: EmailParts): string {
  const accent = parts.accent ?? THEME.accent;
  const cta = parts.cta ? button(parts.cta.label, parts.cta.url, accent) : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${THEME.pageBg}">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${parts.preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${THEME.pageBg};padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
        <tr><td style="padding:4px 8px 20px">
          <img src="${THEME.logoUrl}" alt="${THEME.wordmark}" height="30" style="height:30px;width:auto;display:block;border:0">
        </td></tr>
        <tr><td style="background:${THEME.cardBg};border:1px solid ${THEME.border};border-radius:14px;padding:36px 34px">
          <h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;font-weight:700;color:${THEME.ink}">${parts.heading}</h1>
          ${parts.body}
          ${cta}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;border-top:1px solid ${THEME.border};width:100%">
            <tr>
              <td style="padding-top:20px;width:56px;vertical-align:middle">
                <img src="${THEME.founder.photoUrl}" alt="${THEME.founder.name}" width="48" height="48" style="width:48px;height:48px;border-radius:50%;display:block;border:0">
              </td>
              <td style="padding-top:20px;vertical-align:middle">
                <div style="font-size:15px;font-weight:600;color:${THEME.ink}">${THEME.founder.name}</div>
                <div style="font-size:13px;color:${THEME.muted}">${THEME.founder.title}</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:22px 8px 8px;font-size:12px;line-height:1.5;color:${THEME.muted}">
          Questions? Reply to this email — a real person reads every message.<br>
          You’re receiving this because your store uses ${THEME.wordmark}.
          &nbsp;·&nbsp;<a href="{{UNSUB_URL}}" style="color:${THEME.muted};text-decoration:underline">Unsubscribe</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Single source for the Resend-hosted templates. scripts/resend-templates.ts
// creates + publishes these in your Resend account (once — skip-if-exists, so
// UI edits win afterward). Campaigns reference them by `key`; send.server maps
// key → Resend template id via template-ids.json.
//
// Dynamic content is Resend's triple-brace {{{VAR}}}. UNSUB_URL is filled
// per-shop in send.server. Avoid Resend's reserved names (FIRST_NAME, EMAIL,
// RESEND_UNSUBSCRIBE_URL, contact, this).
import { layout, p, bullets, callout, THEME } from "./campaigns/_layout";

const FROM = process.env.NUDGE_FROM ?? "SalesHQ <hello@saleshq.ai>";
const APP_URL = process.env.SHOPIFY_APP_URL ?? "https://saleshq-chatbot.vercel.app";

export interface TemplateVar {
  key: string;
  type: "string";
  fallback_value: string;
}
export interface TemplateDef {
  key: string;
  name: string;
  subject: string;
  variables: TemplateVar[];
  html: string;
}

// Turn our {{UNSUB_URL}} placeholder into Resend's triple-brace form.
const toResend = (html: string): string => html.replace(/\{\{UNSUB_URL\}\}/g, "{{{UNSUB_URL}}}");
const v = (key: string, fallback = ""): TemplateVar => ({ key, type: "string", fallback_value: fallback });

// Injected into EVERY send by send.server, so every template must declare them.
// SHOP_DOMAIN rides on CTA links (?shop=...) so Shopify's auth flow lands the
// merchant inside their own admin instead of a bare login page.
const BASE_VARS: TemplateVar[] = [
  v("UNSUB_URL"),
  v("STORE_NAME", "your store"),
  v("OWNER_NAME", "there"),
  v("SHOP_DOMAIN"),
];
const vars = (...extra: TemplateVar[]): TemplateVar[] => [...BASE_VARS, ...extra];

// App link with the shop attached — use for every CTA.
const appLink = (path: string) => `${APP_URL}${path}?shop={{{SHOP_DOMAIN}}}`;

// Bar with a Resend-variable width — {{{PCT}}} is injected unescaped into the style.
function varUsageBar(color: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
    <tr><td style="font-size:13px;color:${THEME.muted};padding-bottom:6px">{{{USED}}} of {{{LIMIT}}} conversations · {{{PCT}}}%</td></tr>
    <tr><td style="background:${THEME.border};border-radius:999px;height:10px;line-height:10px;font-size:0">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:{{{PCT}}}%;min-width:8px"><tr>
        <td style="background:${color};border-radius:999px;height:10px;line-height:10px;font-size:0">&nbsp;</td>
      </tr></table>
    </td></tr>
  </table>`;
}

export const TEMPLATE_DEFS: TemplateDef[] = [
  {
    key: "onboarding-welcome",
    name: "onboarding-welcome",
    subject: "Your AI assistant is now live on {{{STORE_NAME}}}",
    variables: vars(),
    html: toResend(
      layout({
        preheader: "It’s already answering shoppers. One quick way to see it in action.",
        heading: "You’re live, {{{OWNER_NAME}}}",
        body:
          p("Hi {{{OWNER_NAME}}}, I’m Shubham — I built SalesHQ. Thanks for installing it on <strong>{{{STORE_NAME}}}</strong>.") +
          p("Your assistant is already on your storefront answering questions about your products, shipping, and returns. There’s nothing to switch on.") +
          p("If you do one thing today, do this: open your store, click the chat bubble, and ask it something a customer would — “what’s your return policy?” is a good test. You’ll see exactly what your shoppers see, and you’ll immediately spot anything you want to change.") +
          p("I’ll send you three short emails this week, one setup step each. None takes more than five minutes, and they’re the difference between a decent assistant and a great one."),
        cta: { label: "Open your dashboard", url: appLink("/app") },
      }),
    ),
  },
  {
    key: "onboarding-brand",
    name: "onboarding-brand",
    subject: "Step 1 of 3: make it sound like {{{STORE_NAME}}}",
    variables: vars(),
    html: toResend(
      layout({
        preheader: "Two fields in Settings decide how your assistant talks. Takes about two minutes.",
        heading: "Right now it sounds like everyone else’s store",
        body:
          p("Hi {{{OWNER_NAME}}} — quick one today.") +
          p("Your assistant answers accurately, but in a neutral voice. Two fields in <strong>Settings</strong> fix that: the <strong>brand description</strong> (what you sell, how you talk to customers) and the <strong>welcome message</strong> (the first line shoppers see when the chat opens).") +
          callout(
            "Here’s a brand description that works: “We’re a family-run coffee roastery. Keep answers warm and brief, mention that every batch ships within 48 hours of roasting, and never oversell.”",
          ) +
          p("Two or three sentences is plenty. Specific beats long, and you can change it whenever — the assistant picks it up right away."),
        cta: { label: "Open Settings", url: appLink("/app/settings") },
      }),
    ),
  },
  {
    key: "onboarding-knowledge",
    name: "onboarding-knowledge",
    subject: "Step 2 of 3: the answers only you know",
    variables: vars(),
    html: toResend(
      layout({
        preheader: "Your assistant knows your catalog. It can’t know your policies until you add them.",
        heading: "Teach it the things only you know",
        body:
          p("Hi {{{OWNER_NAME}}} — your assistant already knows your product catalog. What it can’t know is your policies: shipping costs and times, how returns work, sizing quirks. And those are the questions shoppers ask most.") +
          p("Adding them is quick. Go to the <strong>Knowledge</strong> page, upload a PDF or just paste the text. It’s indexed in seconds, and from then on the assistant quotes your actual policy instead of giving a careful generic answer.") +
          p("Not sure what to add first? Open the <strong>Gaps</strong> tab on that same page — it collects the questions your assistant couldn’t answer confidently, ranked by how often shoppers asked. It’s literally a to-do list written by your customers."),
        cta: { label: "Add your first document", url: appLink("/app/knowledge") },
      }),
    ),
  },
  {
    key: "onboarding-results",
    name: "onboarding-results",
    subject: "Step 3 of 3: your first week’s numbers",
    variables: vars(),
    html: toResend(
      layout({
        preheader: "A week of data is in your dashboard. One habit is worth keeping from here.",
        heading: "One week in",
        body:
          p("Hi {{{OWNER_NAME}}} — {{{STORE_NAME}}} has had a week of shoppers talking to the assistant, so your dashboard is worth a look now: conversations handled, carts recovered, revenue influenced.") +
          p("If I could get every store owner to keep one habit, it’s this: once a week, open the Gaps tab and add one missing answer. Each one permanently turns a lost shopper into an answered one. It compounds faster than you’d think.") +
          p("That’s the last setup email from me. From here on, we’ll only email you when something actually needs your attention — like your plan running low. If anything’s unclear or not working the way you expected, just reply. I read these."),
        cta: { label: "See your results", url: appLink("/app") },
      }),
    ),
  },
  {
    key: "usage-warn",
    name: "usage-warn",
    subject: "{{{STORE_NAME}}} has used {{{PCT}}}% of this month’s conversations",
    variables: vars(v("USED", "0"), v("LIMIT", "0"), v("PCT", "80")),
    html: toResend(
      layout({
        preheader: "{{{USED}}} of {{{LIMIT}}} used. Nothing is paused — just wanted you to know before it matters.",
        heading: "Heads up: {{{PCT}}}% of your monthly limit used",
        accent: THEME.warn,
        body:
          p("Hi {{{OWNER_NAME}}} — nothing is wrong and nothing is paused. I just don’t want the limit to catch you by surprise. <strong>{{{STORE_NAME}}}</strong> has used {{{USED}}} of its {{{LIMIT}}} included conversations this month:") +
          varUsageBar(THEME.warn) +
          p("If you hit the limit, the assistant pauses new replies until your quota resets, and shoppers see it as unavailable. Three ways to handle it:") +
          bullets([
            "<strong>Do nothing</strong> — your quota resets automatically on the 1st of next month",
            "<strong>Add a top-up pack</strong> — covers the rest of this month, no plan change",
            "<strong>Upgrade your plan</strong> — higher monthly limit, kicks in immediately",
          ]) +
          p("For what it’s worth: a busy month like this usually means more shoppers are actually talking to your store. That’s the good problem."),
        cta: { label: "Review your plan", url: appLink("/app/billing") },
      }),
    ),
  },
  {
    key: "usage-exhausted",
    name: "usage-exhausted",
    subject: "Action needed: your assistant has paused replies",
    variables: vars(v("USED", "0"), v("LIMIT", "0"), v("PCT", "100")),
    html: toResend(
      layout({
        preheader: "{{{STORE_NAME}}} reached its monthly limit. Resume instantly, or wait for the reset on the 1st.",
        heading: "{{{STORE_NAME}}} hit its monthly limit",
        accent: THEME.danger,
        body:
          p("Hi {{{OWNER_NAME}}} — <strong>{{{STORE_NAME}}}</strong> has used all {{{LIMIT}}} conversations in your plan this month:") +
          varUsageBar(THEME.danger) +
          p("Here’s where that leaves you: if you have top-up balance, the assistant is still replying and will keep going until that runs out. If not, new replies are paused, and shoppers currently see the assistant as unavailable. I’d rather tell you plainly than have you find out from a customer.") +
          p("Three ways forward:") +
          bullets([
            "<strong>Upgrade your plan</strong> — replies resume the moment you confirm",
            "<strong>Add a top-up pack</strong> — resumes instantly, no plan change",
            "<strong>Wait it out</strong> — your quota renews automatically on the 1st of next month",
          ]) +
          p("Whichever you pick, your settings, knowledge and history are untouched — this only affects new replies. And if the limit keeps getting in your way, reply and tell me; plan sizes aren’t set in stone."),
        cta: { label: "Resume replies now", url: appLink("/app/billing") },
      }),
    ),
  },
  {
    // Reusable shell for all feature announcements — pass content as variables.
    key: "announcement",
    name: "announcement",
    subject: "{{{SUBJECT}}}",
    variables: vars(
      v("SUBJECT", "News from SalesHQ"),
      v("PREHEADER"),
      v("HEADING"),
      v("BODY_HTML"),
      v("CTA_LABEL", "Open SalesHQ"),
      v("CTA_URL", APP_URL),
    ),
    html: toResend(
      layout({
        preheader: "{{{PREHEADER}}}",
        heading: "{{{HEADING}}}",
        body: "{{{BODY_HTML}}}",
        cta: { label: "{{{CTA_LABEL}}}", url: "{{{CTA_URL}}}" },
      }),
    ),
  },
];

export { FROM as TEMPLATE_FROM };

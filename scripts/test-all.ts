// Send one of every hosted template to TEST_EMAIL to eyeball them all.
//   TEST_EMAIL=you@example.com npx tsx --env-file=.env scripts/test-all.ts
import { sendTemplate } from "../app/nudges/send.server";
import { TEMPLATE_IDS } from "../app/nudges/template-ids";

const to = process.env.TEST_EMAIL;
if (!to) throw new Error("set TEST_EMAIL=you@example.com");

// Per-template variables (STORE_NAME/OWNER_NAME/UNSUB_URL are injected by send.server).
const varsFor: Record<string, Record<string, string | number>> = {
  "usage-warn": { USED: 850, LIMIT: 1000, PCT: 85 },
  "usage-exhausted": { USED: 1000, LIMIT: 1000, PCT: 100 },
  announcement: {
    SUBJECT: "New: smarter intent detection is live",
    PREHEADER: "Your bot now spots buying signals earlier.",
    HEADING: "Your bot just got sharper 🧠",
    BODY_HTML:
      "<p style='margin:0 0 16px;font-size:16px;line-height:1.6;color:#4a4a63'>Our new intent engine spots buying signals earlier and nudges shoppers at the right moment — already on, nothing to configure.</p>",
    CTA_LABEL: "See it in action",
    CTA_URL: "https://admin.shopify.com",
  },
};

for (const key of Object.keys(TEMPLATE_IDS)) {
  try {
    await sendTemplate("demo-store.myshopify.com", to, key, varsFor[key] ?? {});
    console.log(`sent ✓ ${key}`);
  } catch (err) {
    console.error(`FAIL ✗ ${key}: ${(err as Error).message}`);
  }
}
console.log("\ndone — check the inbox for 7 emails");

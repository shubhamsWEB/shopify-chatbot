// Manual delivery test — sends a chosen hosted template to TEST_EMAIL via the
// real send path (Resend template id + variables + unsub). Run AFTER
// scripts/resend-templates.ts has populated template-ids.ts.
//   TEST_EMAIL=you@example.com [KEY=onboarding-welcome] npx tsx --env-file=.env scripts/test-welcome.ts
import { sendTemplate } from "../app/nudges/send.server";

const to = process.env.TEST_EMAIL;
const key = process.env.KEY ?? "onboarding-welcome";
if (!to) throw new Error("set TEST_EMAIL=you@example.com");

// Limit templates need usage vars; harmless for the others.
const vars = { USED: 850, LIMIT: 1000, PCT: 85 };
console.log(`sending "${key}" → ${to}`);
await sendTemplate("test.myshopify.com", to, key, vars);
console.log("sent ✓ — check the inbox");

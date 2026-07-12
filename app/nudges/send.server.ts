// Delivery + recipient resolution. Sends via Resend-hosted templates: we pass
// only the template id + variables; subject/HTML live in Resend. Recipient =
// the shop's account owner email (Session.accountOwner), shopInfo email as
// fallback. UNSUB_URL is injected here so campaigns never build it.
import prisma from "../db.server";
import { unsubUrl } from "./unsub.server";
import { TEMPLATE_IDS } from "./template-ids";
import { TEMPLATE_FROM } from "./templates";

const API_KEY = process.env.RESEND_API_KEY;

/** Personalization pulled from the DB (shopInfo synced from Shopify). Falls
 *  back to friendly generics so an unsynced shop still reads fine. */
async function identity(shop: string): Promise<{ STORE_NAME: string; OWNER_NAME: string }> {
  const row = await prisma.shopSettings.findUnique({ where: { shop }, select: { shopInfo: true } });
  const info = (row?.shopInfo as { name?: string; ownerName?: string } | null) ?? {};
  const store = info.name || shop.replace(/\.myshopify\.com$/, "");
  const first = info.ownerName?.trim().split(/\s+/)[0] || "there";
  return { STORE_NAME: store, OWNER_NAME: first };
}

/** Resolve the notification email for a shop, or null if none known. */
export async function recipientFor(shop: string): Promise<string | null> {
  const owner = await prisma.session.findFirst({
    where: { shop, accountOwner: true, email: { not: null } },
    select: { email: true },
  });
  if (owner?.email) return owner.email;
  // shopinfo.server stores the shop's contact address as `contactEmail`.
  const settings = await prisma.shopSettings.findUnique({ where: { shop }, select: { shopInfo: true } });
  const info = (settings?.shopInfo as { contactEmail?: string; email?: string } | null) ?? {};
  return info.contactEmail ?? info.email ?? null;
}

/** Send one templated email. Throws on failure so the caller can release the
 *  claim. */
export async function sendTemplate(
  shop: string,
  to: string,
  templateKey: string,
  variables: Record<string, string | number> = {},
): Promise<void> {
  if (!API_KEY) throw new Error("RESEND_API_KEY not set");
  const id = TEMPLATE_IDS[templateKey];
  if (!id) throw new Error(`no Resend template id for "${templateKey}" — run scripts/resend-templates.ts`);
  // Resend variables are typed `string` — coerce numbers so callers can pass raw values.
  // Every template gets UNSUB_URL + store personalization (BASE_VARS) injected here.
  const vars: Record<string, string> = { UNSUB_URL: unsubUrl(shop), SHOP_DOMAIN: shop, ...(await identity(shop)) };
  for (const [k, val] of Object.entries(variables)) vars[k] = String(val);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: TEMPLATE_FROM,
      to,
      template: { id, variables: vars },
      headers: {
        "List-Unsubscribe": `<${unsubUrl(shop)}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text().catch(() => "")}`);
}

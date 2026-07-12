// AI-reply top-up packs are one-time purchases (spec: app/intent/plans.ts
// TOPUP_PACKS). Crediting happens HERE, off the webhook — not on the
// merchant's browser redirect back to /app/billing — because the redirect
// isn't guaranteed (closed tab, dropped connection) and Shopify's own docs
// recommend the webhook as the authoritative confirmation for one-time
// charges. Idempotent: each AppPurchaseOneTime id is credited at most once.
import type { ActionFunctionArgs } from "react-router";
import { validateWebhookOnly } from "../shopify.server";
import { getBackofficeMeta, saveBackoffice } from "../intent/settings.server";
import { topUpPackByName } from "../intent/plans";

interface PurchaseWebhookPayload {
  app_purchase_one_time?: {
    admin_graphql_api_id: string;
    name: string;
    status: string;
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await validateWebhookOnly(request);
  const purchase = (payload as PurchaseWebhookPayload).app_purchase_one_time;
  if (!purchase) return new Response();

  const pack = topUpPackByName(purchase.name);
  if (!pack || purchase.status !== "ACTIVE") return new Response();

  try {
    const meta = await getBackofficeMeta(shop);
    const processed = meta.topUpPurchaseIds ?? [];
    if (processed.includes(purchase.admin_graphql_api_id)) return new Response(); // already credited

    await saveBackoffice(shop, {
      ...meta,
      topUpBalance: (meta.topUpBalance ?? 0) + pack.replies,
      // Bundled PDF pages ride along on every pack (plans.ts) — same
      // non-expiring-balance semantics as the replies.
      pdfPageBalance: (meta.pdfPageBalance ?? 0) + pack.pdfPages,
      topUpPurchaseIds: [...processed, purchase.admin_graphql_api_id].slice(-50),
    });
    console.log(`[topup] credited ${pack.replies} replies + ${pack.pdfPages} PDF pages to ${shop} (${purchase.name}, ${purchase.admin_graphql_api_id})`);
  } catch (err) {
    console.error("[topup] credit failed:", (err as Error).message);
  }
  return new Response();
};

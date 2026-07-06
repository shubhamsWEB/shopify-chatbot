// Pulls merchant/business info from Shopify's own Shop object so the
// backoffice can see who to contact without a manual lookup. Called from the
// app.tsx loader on each admin load (mirrors billing.server.ts's syncBilling).
// Deliberately avoids Shop.accountOwner — that needs the read_users scope,
// gated to Plus/Advanced stores; shopOwnerName + contactEmail need no extra
// scope and work on every plan.
import type { authenticate } from "../shopify.server";
import { getShopInfo, saveShopInfo, type ShopInfo } from "./settings.server";

type AdminCtx = Awaited<ReturnType<typeof authenticate.admin>>;
type Admin = AdminCtx["admin"];

const SHOP_QUERY = `#graphql
  query ShopInfo {
    shop {
      name
      shopOwnerName
      contactEmail
      myshopifyDomain
      primaryDomain { url }
      plan { displayName }
      currencyCode
      createdAt
    }
  }`;

interface ShopQueryResult {
  data?: {
    shop?: {
      name?: string;
      shopOwnerName?: string;
      contactEmail?: string;
      myshopifyDomain?: string;
      primaryDomain?: { url?: string };
      plan?: { displayName?: string };
      currencyCode?: string;
      createdAt?: string;
    };
  };
}

/** Fail-soft, change-detected sync — never throws into the admin loader. */
export async function syncShopInfo(shop: string, admin: Admin): Promise<void> {
  try {
    const resp = await admin.graphql(SHOP_QUERY);
    const body = (await resp.json()) as ShopQueryResult;
    const s = body.data?.shop;
    if (!s) return;

    const info: ShopInfo = {
      name: s.name,
      ownerName: s.shopOwnerName,
      contactEmail: s.contactEmail,
      domain: s.primaryDomain?.url || `https://${s.myshopifyDomain}`,
      planName: s.plan?.displayName,
      currencyCode: s.currencyCode,
      shopCreatedAt: s.createdAt,
    };

    const cur = await getShopInfo(shop);
    const changed = (Object.keys(info) as Array<keyof ShopInfo>).some((k) => cur[k] !== info[k]);
    if (!changed) return;

    await saveShopInfo(shop, info);
  } catch (err) {
    console.error("[shopinfo] sync failed:", (err as Error).message);
  }
}

// Per-shop Storefront API token lifecycle (spec §4.4 app scaffolding).
// Minted via the Admin API `storefrontAccessTokenCreate` at install, stored per
// shop, and recreated when the Storefront API rejects it. The Admin client used
// to mint it comes from `unauthenticated.admin(shop)`, which transparently
// refreshes the expiring offline access token.
import prisma from "../db.server";

export interface AdminGraphql {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

const MUTATION = `#graphql
  mutation CreateStorefrontToken($input: StorefrontAccessTokenInput!) {
    storefrontAccessTokenCreate(input: $input) {
      storefrontAccessToken { accessToken }
      userErrors { field message }
    }
  }`;

// Create a Storefront token using an in-hand Admin client and persist it.
export async function createAndStoreStorefrontToken(admin: AdminGraphql, shop: string): Promise<string> {
  const res = await admin.graphql(MUTATION, { variables: { input: { title: "saleshq-chatbot" } } });
  const body = (await res.json()) as {
    data?: {
      storefrontAccessTokenCreate?: {
        storefrontAccessToken?: { accessToken?: string };
        userErrors?: unknown[];
      };
    };
  };
  const errs = body.data?.storefrontAccessTokenCreate?.userErrors;
  const token = body.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
  if (!token) throw new Error(`storefrontAccessTokenCreate failed: ${JSON.stringify(errs ?? body)}`);
  await prisma.storefrontToken.upsert({
    where: { shop },
    create: { shop, token },
    update: { token },
  });
  return token;
}

// Request-time accessor: DB → mint via offline Admin session → env fallback (dev).
export async function getStorefrontToken(shop: string): Promise<string> {
  const row = await prisma.storefrontToken.findUnique({ where: { shop } });
  if (row) return row.token;
  return mint(shop);
}

// Force a fresh token (refresh on Storefront 401/403).
export async function refreshStorefrontToken(shop: string): Promise<string> {
  await prisma.storefrontToken.deleteMany({ where: { shop } });
  return mint(shop);
}

async function mint(shop: string): Promise<string> {
  try {
    // Lazy import avoids a load-time cycle (shopify.server has no static dep on this file).
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    return await createAndStoreStorefrontToken(admin as unknown as AdminGraphql, shop);
  } catch (err) {
    // Dev fallback: a token pasted into env so local testing works pre-install.
    if (process.env.SHOPIFY_STOREFRONT_TOKEN) return process.env.SHOPIFY_STOREFRONT_TOKEN;
    throw err;
  }
}

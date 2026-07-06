// Live product data via Shopify Storefront API (spec §4.2, §7.4 grounding).
// Every product fact the chatbot states comes from here at request time — never
// from model memory. ponytail: token from env for the dev store; multi-tenant
// per-shop token storage is slice-6 app scaffolding.
const API_VERSION = "2025-10";

export interface ProductCard {
  productId: string;
  title: string;
  handle: string;
  price: number;
  currency: string;
  imageUrl: string;
  inStock: boolean;
  variantId?: string;
  badge?: string;
}

import { getStorefrontToken, refreshStorefrontToken } from "./storefront-token.server";

async function call(shop: string, token: string, query: string, variables: Record<string, unknown>) {
  return fetch(`https://${shop}/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
}

async function graphql<T>(shop: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let token = await getStorefrontToken(shop);
  let res = await call(shop, token, query, variables);
  // Token rejected → recreate once and retry (refresh logic).
  if (res.status === 401 || res.status === 403) {
    token = await refreshStorefrontToken(shop);
    res = await call(shop, token, query, variables);
  }
  if (!res.ok) throw new Error(`Storefront API ${res.status}`);
  const json = (await res.json()) as { data: T; errors?: unknown };
  if (json.errors) throw new Error(`Storefront errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const PRODUCT_FIELDS = `
  id
  title
  handle
  availableForSale
  featuredImage { url }
  priceRange { minVariantPrice { amount currencyCode } }
  variants(first: 1) { nodes { id } }
`;

interface RawProduct {
  id: string;
  title: string;
  handle: string;
  availableForSale: boolean;
  featuredImage?: { url: string } | null;
  priceRange: { minVariantPrice: { amount: string; currencyCode: string } };
  variants: { nodes: Array<{ id: string }> };
}

function toCard(p: RawProduct, badge?: string): ProductCard {
  return {
    productId: p.id,
    title: p.title,
    handle: p.handle,
    price: Number(p.priceRange.minVariantPrice.amount),
    currency: p.priceRange.minVariantPrice.currencyCode,
    imageUrl: p.featuredImage?.url ?? "",
    inStock: p.availableForSale,
    variantId: p.variants.nodes[0]?.id,
    badge,
  };
}

export interface SearchInput {
  query?: string;
  category?: string;
  priceMin?: number;
  priceMax?: number;
  attributes?: string[];
  inStockOnly?: boolean;
  excludeProductIds?: string[];
  limit?: number;
}

// Build a Storefront search query string from structured filters.
function buildQuery(input: SearchInput): string {
  const parts: string[] = [];
  if (input.query) parts.push(input.query);
  if (input.attributes?.length) parts.push(input.attributes.join(" "));
  if (input.category) parts.push(`product_type:${JSON.stringify(input.category)}`);
  if (input.priceMin != null) parts.push(`variants.price:>=${input.priceMin}`);
  if (input.priceMax != null) parts.push(`variants.price:<=${input.priceMax}`);
  if (input.inStockOnly) parts.push("available_for_sale:true");
  return parts.join(" ").trim();
}

export async function searchProducts(shop: string, input: SearchInput): Promise<ProductCard[]> {
  // No text query (broad/"bestsellers" asks) → rank by actual sales instead of
  // catalog order; with a query, relevance wins.
  const sortKey = input.query?.trim() ? "RELEVANCE" : "BEST_SELLING";
  const data = await graphql<{ products: { nodes: RawProduct[] } }>(
    shop,
    `query Search($q: String, $n: Int!, $sk: ProductSortKeys!) {
      products(first: $n, query: $q, sortKey: $sk) { nodes { ${PRODUCT_FIELDS} } }
    }`,
    { q: buildQuery(input) || null, n: Math.min((input.limit ?? 6) + (input.excludeProductIds?.length ?? 0), 20), sk: sortKey },
  );
  const exclude = new Set(input.excludeProductIds ?? []);
  // Gift cards fit every budget so intent ranking loves them, but they're almost
  // never what the shopper is browsing for — only surface them on an explicit ask.
  const giftAsked = /gift/i.test(input.query ?? "");
  return data.products.nodes
    .filter((p) => !exclude.has(p.id))
    .filter((p) => giftAsked || !/gift ?card/i.test(p.title))
    .slice(0, input.limit ?? 6)
    .map((p) => toCard(p, !p.availableForSale ? "Out of stock" : undefined));
}

export interface ProductDetail extends ProductCard {
  description: string;
  variants: Array<{ id: string; title: string; price: number; available: boolean }>;
  attributes: Record<string, string>; // from options + metafields
}

export async function getProductDetails(shop: string, productId: string): Promise<ProductDetail> {
  const data = await graphql<{ product: any }>(
    shop,
    // ponytail: no metafields — Storefront API requires explicit {namespace,key}
    // identifiers (can't list-all like Admin). Attributes come from product
    // options; per-shop metafield identifiers are a later config step.
    `query Details($id: ID!) {
      product(id: $id) {
        ${PRODUCT_FIELDS}
        description
        productType
        vendor
        options { name values }
        allVariants: variants(first: 20) { nodes { id title availableForSale price { amount } } }
      }
    }`,
    { id: productId },
  );
  const p = data.product;
  const attributes: Record<string, string> = {};
  if (p.vendor) attributes["Brand"] = p.vendor;
  if (p.productType) attributes["Type"] = p.productType;
  for (const o of p.options ?? []) attributes[o.name] = (o.values ?? []).join(", ");
  return {
    ...toCard(p),
    description: p.description ?? "",
    variants: (p.allVariants?.nodes ?? []).map((v: any) => ({
      id: v.id,
      title: v.title,
      price: Number(v.price.amount),
      available: v.availableForSale,
    })),
    attributes,
  };
}

export interface ComparisonMatrix {
  products: ProductCard[];
  attributes: string[]; // union of attribute keys (rows)
  rows: Record<string, string[]>; // attribute → value per product (column order = products)
  // Per-product description excerpts (column order = products). The options-based
  // matrix alone is thin (price/stock/color); the real feature differences live in
  // the merchant's descriptions — the model synthesizes the table from these.
  descriptions: string[];
}

// Fetch each product live, assemble a comparable matrix (spec §8.2).
// ponytail: raw attribute union — Haiku attribute-normalization is the upgrade path.
export async function compareProducts(shop: string, productIds: string[]): Promise<ComparisonMatrix> {
  const details = await Promise.all(productIds.slice(0, 4).map((id) => getProductDetails(shop, id)));
  const attrKeys = [...new Set(details.flatMap((d) => Object.keys(d.attributes)))];
  const rows: Record<string, string[]> = {};
  for (const k of attrKeys) rows[k] = details.map((d) => d.attributes[k] ?? "—");
  // always include price/stock rows
  rows["Price"] = details.map((d) => `${d.currency} ${d.price}`);
  rows["In stock"] = details.map((d) => (d.inStock ? "Yes" : "No"));
  // ProductDetail is a superset of ProductCard — strip to the card fields.
  const cards: ProductCard[] = details.map((d) => ({
    productId: d.productId,
    title: d.title,
    handle: d.handle,
    price: d.price,
    currency: d.currency,
    imageUrl: d.imageUrl,
    inStock: d.inStock,
    variantId: d.variantId,
  }));
  const descriptions = details.map((d) => (d.description || "").replace(/\s+/g, " ").trim().slice(0, 900));
  return { products: cards, attributes: ["Price", "In stock", ...attrKeys], rows, descriptions };
}

// Store's category directions for exploring shoppers — real collections, so a
// "not sure what I want" nudge offers concrete browsing lanes, not one product.
export async function getCategories(shop: string, limit = 8): Promise<Array<{ title: string; handle: string }>> {
  const data = await graphql<{ collections: { nodes: Array<{ title: string; handle: string }> } }>(
    shop,
    `query($n:Int!){ collections(first:$n, sortKey:UPDATED_AT, reverse:true){ nodes { title handle } } }`,
    { n: Math.min(Math.max(limit, 1), 20) },
  );
  return (data.collections?.nodes ?? []).filter((c) => c.title && c.handle);
}

// Intent-driven ranking (spec §8.1; conversational-recommender literature —
// Jannach/Gao surveys, Koniew). Intent must DRIVE which products surface, not
// just describe the shopper. Rule-based MVP: price-fit vs the discovered ceiling/
// band, attribute match, in-stock. Pure, no deps.
import type { ProductCard } from "./storefront.server";

export interface RankIntent {
  priceCeiling?: number;
  priceBand?: { low: number; high: number };
  attributePriorities?: string[];
  // products favored by semantically-similar-intent shoppers (pgvector neighbors)
  boostIds?: Set<string>;
}

export function rankByIntent(cards: ProductCard[], intent: RankIntent): ProductCard[] {
  const scored = cards.map((c) => {
    let s = 0;
    s += c.inStock ? 1 : -3; // never surface OOS above available

    if (intent.priceCeiling != null) {
      if (c.price <= intent.priceCeiling) s += 1.5;
      else s -= Math.min(2.5, (c.price - intent.priceCeiling) / intent.priceCeiling); // over-budget penalty scales with overshoot
    }
    if (intent.priceBand && c.price >= intent.priceBand.low && c.price <= intent.priceBand.high) s += 1;

    const title = c.title.toLowerCase();
    for (const a of intent.attributePriorities ?? []) if (a && title.includes(a.toLowerCase())) s += 0.6;

    if (intent.boostIds?.has(c.productId)) s += 1.2; // similar-intent shoppers engaged this

    return { c, s };
  });

  scored.sort((a, b) => b.s - a.s);

  return scored.map(({ c, s }, i) => {
    let badge = c.badge;
    if (!badge && intent.boostIds?.has(c.productId) && c.inStock) badge = "Popular with similar shoppers";
    else if (!badge && i === 0 && scored.length > 1 && s > 0.5) badge = "Best match";
    else if (!badge && intent.priceCeiling != null && c.inStock && c.price <= intent.priceCeiling) badge = "In budget";
    return { ...c, badge };
  });
}

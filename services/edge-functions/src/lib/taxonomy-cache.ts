// eBay category suggestions, cached (US-3026).
//
// THE MOMENT THIS IS FOR is the one comps-cache.ts already describes: a reseller
// working a rack of six similar jackets. That story cached the Browse call and
// left the Taxonomy call in front of it uncached, so every scan on the rack
// still paid a full eBay round trip to be told, again, that a flannel shirt is
// category 57990.
//
// This is safer to cache than comps and so is cached for far longer. Comps are
// a price, and a price shown to a seller has to be current; a category tree is
// a published taxonomy that eBay revises a few times a year. Twelve hours is
// well inside that and well outside a store run.
//
// The key is the QUERY and nothing else - no tenant, same as comps. Two sellers
// asking where a flannel shirt goes are asking one question.

import { createSharedJsonCache } from "./coherent-cache.ts";
import { type CategorySuggestion, suggestCategories } from "./ebay-client.ts";

export const TAXONOMY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const cache = createSharedJsonCache<CategorySuggestion[]>({
  namespace: "taxonomy-suggest",
  ttlMs: TAXONOMY_CACHE_TTL_MS,
});

/** Case- and whitespace-insensitive: "Flannel Shirt" and "flannel  shirt" are one query. */
export function taxonomyCacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * `suggestCategories`, served from the shared cache.
 *
 * A wrapper rather than caching inside `suggestCategories` itself, for the same
 * reason comps-cache gives: that function is the eBay client's plain door and
 * several callers want it live. The scan surfaces opt in because they are the
 * ones standing in a shop.
 *
 * An empty query never reaches eBay - it would be a round trip guaranteed to
 * return nothing - and never enters the cache either.
 */
export async function cachedSuggestCategories(
  query: string,
): Promise<{ result: CategorySuggestion[]; hit: boolean }> {
  const key = taxonomyCacheKey(query);
  if (!key) return { result: [], hit: false };
  const { value, hit } = await cache.get(key, () => suggestCategories(query));
  return { result: value, hit };
}

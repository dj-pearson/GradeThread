// Links INTO the Sourcing host's Scout tabs, built in one place so the
// parameter names Scout reads and the ones other pages write cannot drift.

/**
 * SRC-8: where a facet sends the seller. This used to be /scout?q=, which
 * nothing read. A brand prefills Scout's brand field; a category term prefills
 * its search words.
 */
export function scoutHrefForFacet(term: string, kind: "brand" | "category"): string {
  const params = new URLSearchParams({ tab: "scout" });
  params.set(kind === "brand" ? "brand" : "q", term);
  return `/dashboard/flipdesk/sourcing?${params.toString()}`;
}

/**
 * SRC-12: where a just-bought item lives. The item canvas is /items/<id>;
 * /inventory/<id> is not a route.
 */
export function inventoryItemHref(id: string): string {
  return `/dashboard/flipdesk/items/${encodeURIComponent(id)}`;
}

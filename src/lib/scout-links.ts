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

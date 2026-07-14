// US-1893: leaf-category guard helpers. eBay only lets you LIST against a LEAF
// category; a non-leaf (or unknown) id fails publish with an opaque error. The
// audit found publish trusted get_category_suggestions to return leaf-first but
// never validated a platform_category_id that arrived from other paths (manual
// entry, CSV import, older rows). These helpers are PURE (no imports) so the
// preflight route and ebay-client can share them and they're fully unit-testable.

/**
 * True when a cached `ebay_category_aspects.aspects` value proves the id is a
 * LEAF. eBay's get_item_aspects_for_category (the only writer of non-empty
 * aspects) succeeds ONLY on leaf categories, so a non-empty aspects object is
 * proof of leaf-ness — the cache-hit fast path that costs no live Taxonomy call.
 * NOTE getCategoryName also writes rows for display but with an EMPTY `{}` aspects
 * object, so emptiness proves nothing (fall through to a live subtree check).
 */
export function cachedAspectsProveLeaf(aspects: unknown): boolean {
  return (
    typeof aspects === "object" &&
    aspects !== null &&
    !Array.isArray(aspects) &&
    Object.keys(aspects as Record<string, unknown>).length > 0
  );
}

/** Minimal shape of eBay's get_category_subtree response we read. */
export interface SubtreeResponse {
  categorySubtreeNode?: {
    leafCategoryTreeNode?: boolean;
    childCategoryTreeNodes?: unknown[];
    category?: { categoryId?: string };
  };
}

/**
 * Parse a get_category_subtree response into leaf-ness. A leaf node carries
 * `leafCategoryTreeNode: true` (and no childCategoryTreeNodes). Returns:
 *   • true / false — the node resolved and is / isn't a leaf;
 *   • null — the shape is unrecognizable (e.g. an error body): treat as unknown.
 */
export function parseSubtreeIsLeaf(payload: SubtreeResponse): boolean | null {
  const node = payload?.categorySubtreeNode;
  if (!node || !node.category?.categoryId) return null;
  if (typeof node.leafCategoryTreeNode === "boolean") {
    return node.leafCategoryTreeNode;
  }
  // Fall back to child presence when the explicit flag is absent.
  if (Array.isArray(node.childCategoryTreeNodes)) {
    return node.childCategoryTreeNodes.length === 0;
  }
  return null;
}

export interface SuggestedLeaf {
  categoryId: string;
  categoryName: string;
  categoryTreePath: string;
}

/**
 * Turn a non-leaf / unknown category id into a fixable publish blocker, naming
 * the top suggested LEAF as a one-click fix when one is available. Returns null
 * when the id is a confirmed leaf (isLeaf === true) so publish proceeds.
 *   • isLeaf === false → the id resolved but is a parent/branch category;
 *   • isLeaf === null  → eBay couldn't resolve the id (invalid/unknown).
 */
export function leafCategoryBlocker(
  isLeaf: boolean | null,
  categoryId: string,
  suggestion: SuggestedLeaf | null,
): string | null {
  if (isLeaf === true) return null;
  const problem = isLeaf === false
    ? `eBay category ${categoryId} isn't a specific (leaf) category`
    : `eBay category ${categoryId} could not be verified on eBay`;
  if (suggestion) {
    return (
      `${problem}, so eBay would reject this listing. ` +
      `Use "${suggestion.categoryTreePath}" (${suggestion.categoryId}) instead.`
    );
  }
  return (
    `${problem}, so eBay would reject this listing. ` +
    `Pick a specific (leaf) category in the composer.`
  );
}

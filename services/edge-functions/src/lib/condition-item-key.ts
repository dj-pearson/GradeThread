// The cell key, on its own so two graphs can share it (US-2848).
//
// normalizeItemKey lived in condition-curve.ts, which imports condition-value.ts
// at runtime. The shadow comparison needs the same key from inside
// condition-value.ts, and importing it back would have closed a cycle. So the
// key moved here, where it depends on nothing at all, and condition-curve.ts
// re-exports it so every existing importer is untouched.
//
// The shape is structural rather than ItemKey so this file stays import-free.
// ItemKey satisfies it, which is what matters at the call sites.

export interface ItemIdentity {
  categoryId: string;
  brand?: string | null;
  q?: string | null;
}

/**
 * Normalized, stable identity for an item across lookups.
 *
 * SIZE IS DELIBERATELY NOT IN THE KEY. A curve is fitted per brand + category +
 * keyword; a medium and a large of the same sweater are the same market cell,
 * and splitting them would divide an already-thin sample for no gain.
 */
export function normalizeItemKey(item: ItemIdentity): string {
  return [item.brand ?? "", item.categoryId, item.q ?? ""]
    .map((s) => s.trim().toLowerCase())
    .join("|");
}

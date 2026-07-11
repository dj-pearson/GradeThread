// US-1903: client-side windowing for the AutoLister "Verify groups" pass.
//
// The /verify-groups edge endpoint samples each group down to its boundary
// shots (first/middle/last, ≤3 per group) and packs groups into a single
// request until a 40-photo sample budget is exhausted — see
// services/edge-functions/src/lib/ai-group-verify.ts (sampleGroupsForVerify,
// MAX_VERIFY_PHOTOS). A 45-group session therefore only ever got its first
// ~13 groups checked in one call. These pure helpers let the client walk ALL
// groups across sequential windows that each match one server request, so
// every group is covered and suggestions aggregate + dedupe across windows.

/** Mirror of MAX_VERIFY_PHOTOS in ai-group-verify.ts — the server's per-request
 *  sample-photo budget. Keep the two in lockstep. */
export const MAX_VERIFY_SAMPLE_PHOTOS = 40;

/**
 * How many photos a group contributes to a window's sample budget. Mirrors the
 * server's sampling: first/middle/last for a group with >3 photos, otherwise
 * every photo; an empty group contributes nothing (the server skips it).
 */
export function sampledSizeForVerify(photoCount: number): number {
  return photoCount <= 0 ? 0 : Math.min(3, photoCount);
}

/**
 * Partition ordered groups into sequential windows whose total sampled-photo
 * size fits `budget`, never splitting a group across windows. Mirrors
 * sampleGroupsForVerify's maximal-prefix packing so each window maps to exactly
 * one /verify-groups request. Empty groups are dropped. A single group can
 * never exceed the budget (≤3 sampled ≤ budget), so it always lands in a window.
 */
export function planVerifyWindows<T extends { photoCount: number }>(
  groups: readonly T[],
  budget: number = MAX_VERIFY_SAMPLE_PHOTOS,
): T[][] {
  const windows: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const g of groups) {
    const size = sampledSizeForVerify(g.photoCount);
    if (size === 0) continue;
    if (current.length > 0 && used + size > budget) {
      windows.push(current);
      current = [];
      used = 0;
    }
    current.push(g);
    used += size;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

export interface DedupableSuggestion {
  type: "merge" | "split" | "move";
  /** merge: [a, b] (unordered) · split: [group] · move: [from, to] (ordered). */
  group_ids: string[];
  photo_ids: string[];
}

/**
 * Stable key for de-duplicating suggestions aggregated across windows, by
 * (type, group_ids, photo_ids). A merge pair is unordered so [a,b] and [b,a]
 * collapse; a move is directional so its [from,to] order is preserved. The
 * photo set is always order-insensitive.
 */
export function suggestionDedupeKey(s: DedupableSuggestion): string {
  const groups = s.type === "move" ? s.group_ids : [...s.group_ids].sort();
  const photos = [...s.photo_ids].sort();
  return `${s.type}|${groups.join(",")}|${photos.join(",")}`;
}

/** Drop later duplicates, keeping the first occurrence's order. */
export function dedupeSuggestions<T extends DedupableSuggestion>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const key = suggestionDedupeKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

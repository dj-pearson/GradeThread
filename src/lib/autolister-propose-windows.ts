// US-1904: client windowing + seam-merge for AI propose-groups.
//
// The /propose-groups edge endpoint scores one window of ≤ PROPOSE_WINDOW
// photos. A big timeless dump is walked across sequential windows that OVERLAP
// by PROPOSE_OVERLAP photos, so an item straddling a window seam isn't
// force-split: it appears (partly) in both windows, and mergeProposalWindows
// stitches the two halves back into one group. Pure + unit-tested.

/** Photos per propose request — mirrors the server's per-window cap. */
export const PROPOSE_WINDOW = 40;
/** Photos shared between adjacent windows so a seam-spanning item isn't split. */
export const PROPOSE_OVERLAP = 4;

export interface ClientProposedGroup {
  photoIds: string[];
  /** 0..1 — the model's confidence in this item's boundary. */
  confidence: number;
  reason: string;
}

/**
 * Split ordered photo ids into windows of at most `windowSize`, where each
 * window after the first repeats the last `overlap` ids of the previous one.
 * The overlap never exceeds windowSize-1 (progress is always guaranteed).
 */
export function planProposeWindows(
  ids: readonly string[],
  windowSize: number = PROPOSE_WINDOW,
  overlap: number = PROPOSE_OVERLAP,
): string[][] {
  if (ids.length === 0) return [];
  if (ids.length <= windowSize) return [ids.slice()];
  const step = Math.max(1, windowSize - Math.min(overlap, windowSize - 1));
  const windows: string[][] = [];
  for (let start = 0; start < ids.length; start += step) {
    windows.push(ids.slice(start, start + windowSize));
    if (start + windowSize >= ids.length) break; // last window reached the end
  }
  return windows;
}

/**
 * Merge per-window proposals into one flat, de-duplicated group list, in photo
 * order. A group that shares any photo with the previous merged group (the
 * window overlap) EXTENDS it — that's the seam-spanning item — keeping the
 * original boundary's confidence/reason. A group of all-new photos is a fresh
 * item. A group entirely inside the overlap (nothing new) is dropped.
 */
export function mergeProposalWindows(
  windows: readonly ClientProposedGroup[][],
): ClientProposedGroup[] {
  const result: ClientProposedGroup[] = [];
  const assigned = new Set<string>();
  for (const window of windows) {
    for (const group of window) {
      const newIds = group.photoIds.filter((id) => !assigned.has(id));
      const last = result[result.length - 1];
      const continuesLast =
        !!last &&
        group.photoIds.some((id) => assigned.has(id) && last.photoIds.includes(id));
      if (newIds.length === 0) continue; // fully within the overlap → nothing to add
      if (continuesLast) {
        last.photoIds.push(...newIds);
      } else {
        result.push({ photoIds: newIds, confidence: group.confidence, reason: group.reason });
      }
      for (const id of newIds) assigned.add(id);
    }
  }
  return result;
}

/**
 * When an eBay item-specifics change counts as unsaved work (US-2256).
 *
 * The composer's unsaved-changes guard compares the picker's reported aspect
 * map against a baseline. Deciding WHEN to stamp that baseline is the whole
 * problem, and it is not answerable from the reports alone: the picker rewrites
 * its own map at least twice after mount with nobody touching it — the
 * deterministic remap that runs once the category's aspect spec loads, and the
 * Measurements → aspect projection.
 *
 * The original rule was "the first report is the baseline, every later one is
 * an edit", written on the belief that the first report arrived after the
 * picker's prefill. It does not — the prefill waits on a network fetch. So
 * every graded item with measurements opened dirty, and closing it always
 * asked "Leave without saving?" about work nobody had done. A guard that fires
 * on every exit is one the seller learns to dismiss, which is worse than
 * having no guard: on the day it means something, it looks identical.
 *
 * Ordering cannot separate the two cases, so intent is reported instead. The
 * picker calls `onUserEdit` from click and keystroke handlers only, and until
 * that happens every report simply re-stamps the baseline.
 */

export interface AspectDirtyState {
  /** The map as of the last report that preceded any seller edit. */
  baseline: string | null;
  dirty: boolean;
}

export const INITIAL_ASPECT_DIRTY_STATE: AspectDirtyState = {
  baseline: null,
  dirty: false,
};

/**
 * Fold one report from the picker into the dirty state.
 *
 * `sellerEdited` is a latch, not a per-report flag: once the seller has
 * touched the picker it stays true for the life of the editor. A save clears
 * the dirty flag by re-stamping the baseline (`stampAspectsSaved`) rather than
 * by forgetting that the seller was ever here — un-latching would make the
 * next automatic rewrite silently discardable again.
 */
export function reduceAspectReport(
  state: AspectDirtyState,
  encoded: string,
  sellerEdited: boolean,
): AspectDirtyState {
  if (!sellerEdited) return { baseline: encoded, dirty: false };
  if (encoded === state.baseline) return state;
  return { ...state, dirty: true };
}

/** A save makes the current map the saved map. */
export function stampAspectsSaved(encoded: string): AspectDirtyState {
  return { baseline: encoded, dirty: false };
}

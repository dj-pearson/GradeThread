// The one definition of what `priority` means in prd.json (US-2371).
//
// Before this file, the backlog encoded two contradictory orders at once.
// scripts/ralph/run-sdk.mjs sorted DESCENDING, so the biggest number won; but
// the Android block was authored at -98701 (the US-1299 epic) through -98603,
// ascending within itself in the exact order the stories were actually worked,
// and US-1299's own note calls it [P1]. Under a descending sort that whole block
// could never be picked; under an ascending one nothing positive ever could.
// Only one can be right, so the direction is now written down, in one place,
// with every consumer importing from here.
//
// The contract, decided by the operator on 2026-07-31:
//
//   1. ASCENDING. Lowest number first. -98701 outranks 58 outranks 2544.
//   2. `priority` is OPTIONAL. A story without one sorts LAST — it is unranked,
//      not urgent. 96 of 247 open stories are in that state and backfilling them
//      with invented numbers would be worse than admitting they are unranked.
//   3. If `priority` IS present it must be a finite number. prd-lint fails on
//      anything else, because a string or a null silently poisons the
//      comparator: `undefined - 5` is NaN, and a NaN comparator makes V8's
//      TimSort produce an arbitrary, unstable order rather than an obviously
//      wrong one. That is not theoretical — it dropped US-2368 out of a top-8
//      listing while this very story was being written.
//   4. Ties break on id, ascending, so two runs of the same backlog always yield
//      the same next story.
//
// See vault/70-agent/backlog-priority-contract.md for the reasoning.

/** Where a story with no `priority` sorts under the ascending contract: last. */
export const UNRANKED = Number.POSITIVE_INFINITY;

/**
 * True when `value` is an acceptable `priority`: absent, or a finite number.
 * Absent is legal (rule 2); present-but-not-a-number is not (rule 3).
 */
export function isValidPriority(value) {
  return value === undefined || Number.isFinite(value);
}

/** The rank used for sorting. Missing means last, never first. */
export function priorityRank(story) {
  const p = story?.priority;
  return Number.isFinite(p) ? p : UNRANKED;
}

/**
 * The ONE comparator. Ascending by priority, then by numeric id so the order is
 * total and stable. Pass this to `.sort()`; never hand-roll the subtraction,
 * which is how the two directions diverged in the first place.
 */
export function comparePriority(a, b) {
  const ra = priorityRank(a);
  const rb = priorityRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return idNumber(a) - idNumber(b);
}

/** `"US-2371"` → `2371`. Anything unparseable sorts last among its tie group. */
export function idNumber(story) {
  const m = /(\d+)/.exec(String(story?.id ?? ""));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

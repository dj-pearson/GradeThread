// US-2753: start the comp query before the grade exists.
//
// THE PROBLEM. An /appraise was a serial chain: grade the photo, then use the
// grade to pick an eBay conditionId, then query eBay. The Claude Vision call
// dominates, and the eBay call sat behind it doing nothing. A reseller standing
// in a shop paid for both, one after the other.
//
// THE OBSERVATION THAT MAKES THIS CHEAP. gradeToConditionId collapses the whole
// 1.0-10.0 scale into four eBay buckets, and the band from 3.0 to 8.4 — which is
// very nearly every garment anyone picks up in a thrift store — maps to a single
// one: "3000", Used. So the condition the grade is going to ask for is already
// knowable, most of the time, before the grade exists.
//
// WHY SPECULATION AND NOT LOCAL BUCKETING. The first design for this fetched
// comps with NO condition filter and split them by BrowseComp.condition after
// the fact. That is slower to reason about and quietly less accurate: an
// unfiltered Browse query returns whatever eBay ranks highest, which is not a
// representative sample per condition, so the "Used" bucket carved out of it is
// a different population from the one a filtered query returns. That is an
// accuracy change wearing a speedup's clothes.
//
// Speculation cannot change the answer. It issues the IDENTICAL query the
// sequential code would have issued — same filter, same limit — just earlier. On
// a hit the result is byte-for-byte what today returns. On a miss the precise
// query runs exactly when it runs today. The only thing that changes is how much
// of the wait happened in parallel.

import { gradeToConditionId } from "./repricing.ts";

/**
 * The condition to query before the grade lands.
 *
 * DERIVED from gradeToConditionId's own default rather than written as "3000",
 * so moving that default moves the guess with it. A hard-coded constant here
 * would drift silently: the speculation would start missing every time and the
 * only symptom would be that appraisals got slow again.
 */
export const SPECULATIVE_CONDITION_ID: string = gradeToConditionId(null);

/**
 * Will the comps we already fetched serve this grade?
 *
 * True means the speculative query is the query — reuse it and pay nothing.
 * False means re-query at the grade's real condition, which costs what the old
 * sequential path cost and is correct rather than approximate. Reusing
 * mismatched comps to save a call would be valuing a new-with-tags jacket
 * against used ones, which is the one thing this must never do.
 */
export function speculationHits(gradeValue: number | null): boolean {
  return gradeToConditionId(gradeValue) === SPECULATIVE_CONDITION_ID;
}

/** A speculative fetch that has settled. It never rejects; it reports. */
export type Settled<T> = { ok: true; result: T } | { ok: false; err: unknown };

/**
 * Reuse the speculative comps, or re-query at the grade's real condition.
 *
 * Generic over the comp type and takes the re-query as a function, so the
 * decision is testable by counting calls rather than by reading the route and
 * believing it. The two properties worth holding are: a hit issues NO second
 * fetch, and a miss issues exactly one, at the condition the grade actually
 * wants.
 *
 * A FAILED speculation falls through to the re-query rather than surfacing the
 * speculative error. That is deliberate — the speculative call is an
 * optimisation the caller never asked for, so its failure should cost a retry,
 * not an error the seller sees. If the re-query fails too, that error is real
 * and propagates.
 */
export async function resolveComps<T>(
  speculated: Settled<T>,
  gradeValue: number | null,
  requery: (conditionId: string) => Promise<T>,
): Promise<{ result: T; reused: boolean }> {
  if (speculationHits(gradeValue) && speculated.ok) {
    return { result: speculated.result, reused: true };
  }
  return { result: await requery(gradeToConditionId(gradeValue)), reused: false };
}

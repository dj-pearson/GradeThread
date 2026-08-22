// Types for the US-2772 close-claim guard, so src/test/close-claims-guard.test.ts
// drives the REAL parser rather than a copy of it.
//
// The copy is the thing to avoid here specifically: this guard exists because a
// commit message asserted a state nobody checked, and a test asserting against
// its own re-implementation of the parser would be the same mistake one level
// up — green while the hook that actually runs does something else.

/** How a story's closure stands, as the guard is willing to describe it. */
export type CloseState = "archived" | "passes" | "open" | "unknown";

/** Minimal shape read off a prd.json story — only `passes` is consulted. */
export interface ClaimStory {
  id: string;
  passes?: boolean;
}

/**
 * The story ids a commit SUBJECT claims to have closed.
 *
 * Empty for a subject that merely names a story, and empty for "disclose" —
 * the word boundary is load-bearing and has its own test.
 */
export function closeClaims(subject: string): string[];

/**
 * Whether `id` is actually closed.
 *
 * `passes` (still in prd.json, not yet archived) counts as closed: the archive
 * move is a separate step and `--no-archive` skips it on purpose.
 */
export function closeState(
  id: string,
  prd: Map<string, ClaimStory>,
  archive: Set<string>,
): CloseState;

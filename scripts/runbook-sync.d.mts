// Types for the runbook staleness guard, so src/test/runbook-sync-narrowing.test.ts
// drives the REAL classifier rather than a copy of it.
//
// A copy is the specific mistake to avoid here. This narrowing decides which
// commits the lane walks past in silence; a test asserting against its own
// re-implementation would stay green while the script CI runs skips something
// an operator needed to read.

/**
 * Whether every line a commit added or removed to a vault note was output of
 * `scripts/render-cron-docs.ts` rather than something a person wrote.
 *
 * Takes a diff body as `git show --format= --unified=0` prints it. False for an
 * empty or unreadable diff: a commit this cannot read is never walked past.
 */
export function isGeneratedOnlyDiff(diff: string): boolean;

// US-3112: prove a cron's diagnostics actually reach the ledger.
//
// `readJobOutcome` gained a `diagnostics` channel so a job can record WHAT went
// wrong and not only HOW MANY, and its own tests pin the reader. But a reader
// with nothing feeding it is the [[shipped-but-unwired]] shape: no call site, so
// no wrong answer, so no test has a reason to go red. The thing this story is
// blocked on — somebody diagnosing twelve unnamed per-topic errors — is only
// unblocked if the RETURN in the route keeps carrying the sentences.
//
// The guard is a PURE function over source text, exported and exercised against
// string literals below, so the broken shapes stay permanent test cases rather
// than file edits somebody has to remember to undo (Ralph learnings: "NEVER
// restore a sabotage run with git checkout").
//
// Comments are stripped FIRST and on purpose. The AC3 surface check in this same
// story passed for months against a file whose call had been deleted, because a
// comment beside it still named the global — a guard that matches prose is a
// guard that cannot fail.

import { assert, assertEquals } from "@std/assert";
import { MAX_DIAGNOSTICS } from "../lib/cron-run-outcome.ts";

/** Routes whose failure modes are invisible without a sentence in the ledger. */
const REQUIRED_ROUTES = [
  "../routes/jobs-ebay-notification-reconcile.ts",
] as const;

/** Strip line and block comments. Crude, and deliberately so: it only has to
 * stop prose from satisfying the check, and over-stripping a string containing
 * "//" would make the guard stricter, never looser. */
export function stripComments(src: string): string {
  return src
    .replace(/\r\n/g, "\n") // CRLF checkout: a \n needle never matches otherwise
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/([^:])\/\/.*$/gm, "$1");
}

/**
 * Every `diagnostics` that is RETURNED to the cron runner, as opposed to merely
 * mentioned. Matches the two forms a response body can take — `diagnostics,`
 * (shorthand) and `diagnostics: [...]` — after comments are gone.
 */
export function returnedDiagnostics(src: string): number {
  const code = stripComments(src);
  return (code.match(/^\s*diagnostics\s*(,|:)/gm) ?? []).length;
}

Deno.test("US-3112: the notification reconcile returns diagnostics on BOTH exits", async () => {
  for (const rel of REQUIRED_ROUTES) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    const found = returnedDiagnostics(src);
    // Two, not one: the success path (200 with per-topic errors) and the throw
    // path. Every run from 2026-08-20 to 2026-09-03 failed on the THROW, and a
    // 500 body carries no counters at all, so `detail` recorded `{}`.
    assert(
      found >= 2,
      `${rel} returns diagnostics from ${found} exit(s); both the 200 and the 500 need it`,
    );
  }
  // A floor, so an emptied REQUIRED_ROUTES cannot read as coverage.
  assert(REQUIRED_ROUTES.length >= 1);
});

Deno.test("US-3112: a comment naming diagnostics does not satisfy the guard", () => {
  // The exact sabotage that beat AC3's surface check: delete the call, keep the
  // comment that explains it.
  const sabotaged = `
    // US-3112: diagnostics land in cron_runs.detail via readJobOutcome.
    /* returns diagnostics: [...] for the operator */
    return c.json({ ok: true, errors: result.errors });
  `;
  assertEquals(returnedDiagnostics(sabotaged), 0);
});

Deno.test("US-3112: the guard sees both body forms", () => {
  assertEquals(returnedDiagnostics("return c.json({\n  ok: true,\n  diagnostics,\n});"), 1);
  assertEquals(
    returnedDiagnostics('return c.json({\n  error: "x",\n  diagnostics: [msg],\n}, 500);'),
    1,
  );
});

Deno.test("US-3112: the route's bound is the reader's bound", () => {
  // The route slices `notAuthorized` against MAX_DIAGNOSTICS so a long refusal
  // list cannot push the actionable errors out of the persisted array. If the
  // reader's cap moves and the route keeps its own number, that silently stops
  // being true.
  assertEquals(MAX_DIAGNOSTICS, 10);
});

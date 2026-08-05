// US-2376: the two admin actions that used to be raw browser writes now live on
// the edge, and the guarantees that made moving them worthwhile are pinned here.
//
// These are SOURCE assertions, not a live HTTP drive. Both routes need an admin
// JWT, a fresh MFA step-up claim and a real submission/user row to exercise for
// real — that's the tenant-isolation harness's job (env-gated, runs against a
// live service). What can be checked deterministically in CI is the posture:
// which guards each route carries, and that mark-failed reuses the sweep's
// fail+refund path rather than re-implementing a partial one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const ROUTES = new URL("../routes/", import.meta.url);
const LIB = new URL("../lib/", import.meta.url);

// Normalize CRLF — these files are checked out with native line endings on
// Windows, so a multi-line assertion would fail there and pass in CI.
const read = async (url: URL) => (await Deno.readTextFile(url)).replace(/\r\n/g, "\n");

const adminUsersSrc = await read(new URL("admin-users.ts", ROUTES));
const adminGradingSrc = await read(new URL("admin-grading.ts", ROUTES));
const stuckSrc = await read(new URL("stuck-submissions.ts", LIB));

/** The body of one route registration, from its path literal to the next one. */
function routeBody(src: string, marker: string): string {
  const start = src.indexOf(marker);
  assert(start >= 0, `route ${marker} is missing`);
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\nadmin\w+Routes\.(get|post|put|patch|delete|use)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

Deno.test("US-2376: POST /users/:id/plan carries billing:write, a step-up and an audit row", () => {
  const body = routeBody(adminUsersSrc, `adminUsersRoutes.post("/:id/plan"`);

  // The scope is the whole point: an admin whose billing:write was revoked must
  // not be able to grant entitlement by another door.
  assertStringIncludes(body, 'requireScope("billing:write")');
  // Step-up must be the FIRST thing the handler does, before any work.
  assertStringIncludes(body, "const stepUp = requireStepUp(c);");
  assertStringIncludes(body, "if (stepUp) return stepUp;");
  assertStringIncludes(body, 'action: "admin.change_plan"');
  // before/after, not just "a plan changed" — the prior value is what makes the
  // row reviewable. US-2398 widened both to carry the subscription status too,
  // because the grant now moves that as well and a comp is the thing a reviewer
  // most needs to see recorded.
  assertStringIncludes(body, "before: { plan: previous, subscription_status:");
  assertStringIncludes(body, "after: { plan, subscription_status:");
});

Deno.test("US-2398: the plan route grants the LIVE tier, and stamps a comp", () => {
  // The values must match public.flipdesk_plan (00037) — the column every
  // entitlement reads. They used to be public.user_plan
  // (free/starter/professional/enterprise), a different vocabulary for a column
  // nothing gates on, so every grant this route made was inert.
  const decl = adminUsersSrc.slice(adminUsersSrc.indexOf("const ASSIGNABLE_PLANS"));
  const listed = [...decl.slice(0, decl.indexOf("]")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assertEquals(listed, ["free", "starter", "pro", "business"]);

  const body = routeBody(adminUsersSrc, `adminUsersRoutes.post("/:id/plan"`);
  // Writing flipdesk_plan alone would still have been a no-op: effectivePlanFor
  // demotes a paid plan to Free on a 'none'/'canceled' status, which is exactly
  // what a cardless account carries. The 'comp' status (00529) is what makes the
  // grant real, so both halves are pinned together.
  assertStringIncludes(body, "flipdesk_plan: plan");
  assertStringIncludes(body, '"comp"');
  // And it must refuse an account somebody else's billing system owns, rather
  // than writing a value the next webhook overwrites.
  assertStringIncludes(body, "EXTERNALLY_BILLED");
});

Deno.test("US-2376: mark-failed reuses the sweep's fail+refund, not a partial copy", () => {
  const body = routeBody(adminGradingSrc, `adminGradingRoutes.post("/submissions/:id/mark-failed"`);

  // The defect being closed: the browser version flipped the status column and
  // stopped there, so the customer stayed charged for a grade they never got.
  // Calling the shared helper is what makes that impossible to regress into.
  assertStringIncludes(body, "failUngradedSubmission(");
  assert(
    !body.includes('.from("submissions")\n    .update('),
    "mark-failed must not write the status itself — that path skips the refund",
  );
  // Only a wedged submission may be failed; a completed one keeps its grade.
  assertStringIncludes(body, '!== "processing"');
  // admin-grading's auditLog wrapper is positional, not an object literal.
  assertStringIncludes(body, 'auditLog(c, "grading.mark_failed", "submission"');
});

Deno.test("US-2376: failUngradedSubmission cannot double-refund a grade that just landed", () => {
  const start = stuckSrc.indexOf("export async function failUngradedSubmission");
  assert(start >= 0, "failUngradedSubmission is missing");
  const fn = stuckSrc.slice(start, stuckSrc.indexOf("\n}", start));

  // Re-asserting status='processing' inside the UPDATE is the whole concurrency
  // guard: a grade that completed in the race window fails the match, the claim
  // returns nothing, and no charge is reversed.
  assertStringIncludes(fn, '.eq("status", "processing")');
  assertStringIncludes(fn, "if (!claimed) return false;");
  // All three steps, in order.
  assertStringIncludes(fn, "reverseChargeForUngradedSubmission(");
  assertStringIncludes(fn, '.from("flipdesk_grading_submissions")');

  // And the sweep must still go through it, or the two paths drift apart again.
  assertStringIncludes(stuckSrc, "failAndRefund: (id) =>\n    failUngradedSubmission(");
});

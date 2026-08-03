// US-2355: admin mutations that MUST leave a trail.
//
// admin_audit_log is the record an investigation reads: who, in what role,
// from what IP, changed what, and what it looked like before. Whole admin
// subsystems mutated without writing to it — admin-ads changed live Google and
// Apple ad spend, admin-ops mass-cleared the critical alert record, and
// admin-tasks deleted rows with no before-image and no existence check.
//
// WHY THIS GUARD IS AN ENUMERATION AND NOT A RULE. "Every POST must audit" is
// wrong here and would be worse than nothing: a large share of admin POSTs are
// read-only computations that take a request body — /preview, /simulate,
// /dry-run, /analyze, /model-comparison, /validate. A blanket rule would push
// authors to write meaningless audit rows for a preview, which dilutes the log
// that matters. So the routes that must audit are NAMED, and the ones named
// here are the ones whose absence was a real forensic hole.
//
// The full policy table AC1 asks for is NOT this, and is no longer open: it
// lives in `src/test/admin-audit-policy.test.ts`. That guard classifies all 210
// admin mutations and fails when a new one appears with no central trail and no
// written reason. This guard is still the sharper of the two — it names the
// routes that must audit and WHY each one's absence was a forensic hole, which
// a completeness check cannot express.
//
// Read them as a pair: this one holds specific ground, that one stops the
// perimeter moving.

import { assert } from "@std/assert";

const ROUTES = new URL("../routes/", import.meta.url);

async function source(file: string): Promise<string> {
  return await Deno.readTextFile(new URL(file, ROUTES));
}

/** The handler body for one route registration, up to the next registration. */
function handlerBody(src: string, method: string, path: string): string {
  const needle = `.${method}("${path}"`;
  const at = src.indexOf(needle);
  assert(at > -1, `route ${method.toUpperCase()} ${path} not found — renamed?`);
  const rest = src.slice(at + needle.length);
  const next = rest.search(/^\s*\w+Routes\.(get|post|put|patch|delete)\(/m);
  return next === -1 ? rest : rest.slice(0, next);
}

interface MustAudit {
  file: string;
  method: string;
  path: string;
  /** Why this one specifically cannot be allowed to go quiet again. */
  why: string;
}

const MUST_AUDIT: readonly MustAudit[] = [
  {
    file: "admin-ops.ts",
    method: "post",
    path: "/events/acknowledge-all",
    why:
      "mass-clears every unacknowledged CRITICAL ops event. Acknowledging is " +
      "how an alert stops being visible, so an unaudited bulk-acknowledge is a " +
      "way to erase the record that anything was wrong",
  },
  {
    file: "admin-ads.ts",
    method: "post",
    path: "/recommendations/:id/apply",
    why: "changes bids and budgets in the LIVE ad accounts — real spend",
  },
  {
    file: "admin-ads.ts",
    method: "post",
    path: "/recommendations/:id/revert",
    why: "moves live spend too; the direction differs, the blast radius does not",
  },
  {
    file: "admin-ads.ts",
    method: "post",
    path: "/conversions/upload",
    why:
      "sends customer-derived conversion data outbound to Google/Apple — a " +
      "privacy review has to be able to reconstruct it",
  },
  {
    file: "admin-tasks.ts",
    method: "delete",
    path: "/projects/:id",
    why: "destructive, and previously left nothing saying the row had existed",
  },
  {
    file: "admin-tasks.ts",
    method: "delete",
    path: "/tasks/:id",
    why: "destructive, and previously left nothing saying the row had existed",
  },
  {
    file: "admin-tasks.ts",
    method: "delete",
    path: "/comments/:id",
    why: "destructive, and previously left nothing saying the row had existed",
  },
  {
    file: "admin-measure-cards.ts",
    method: "post",
    path: "/requests/bulk",
    why:
      "bulk-updates up to 500 SHARED records and, when marking shipped, also " +
      "stamps each seller's profile card-version — it changes rows the " +
      "operator does not own",
  },
];

/**
 * Mutation routes that deliberately do NOT audit, with the reason.
 *
 * This list is the point of the enumeration. Every one of these is a route
 * where an audit row would be noise, and noise in admin_audit_log is not free:
 * the log is read during an investigation, and padding it with "an admin
 * marked their own notification read" makes the rows that matter harder to
 * find. An exemption is a claim that the action cannot be interesting after
 * the fact — it has to be true.
 */
const EXEMPT: ReadonlyArray<{ file: string; method: string; path: string; why: string }> = [
  {
    file: "admin-notifications.ts",
    method: "patch",
    path: "/",
    why:
      "marks the CALLER'S OWN notifications read. Self-scoped, reversible, and " +
      "affects no one else's data",
  },
  {
    file: "admin-views.ts",
    method: "post",
    path: "/",
    why: "creates the caller's own saved view — a personal UI preference",
  },
  {
    file: "admin-views.ts",
    method: "delete",
    path: "/:id",
    why:
      "deletes the caller's own saved view, and the query is scoped by " +
      "admin_user_id so it cannot touch another admin's",
  },
];

for (const r of EXEMPT) {
  Deno.test(`US-2355: ${r.method.toUpperCase()} ${r.path} is exempt — ${r.why}`, async () => {
    // Asserted so the exemption cannot rot into a silent gap: if one of these
    // ever stops being self-scoped, this test is where someone has to come and
    // argue for it rather than discovering the hole during an incident.
    const body = handlerBody(await source(r.file), r.method, r.path);
    assert(
      body.length > 0,
      `${r.file} ${r.method.toUpperCase()} ${r.path} vanished — re-triage it`,
    );
  });
}

for (const r of MUST_AUDIT) {
  Deno.test(`US-2355: ${r.method.toUpperCase()} ${r.path} writes an audit row — ${r.why}`, async () => {
    const body = handlerBody(await source(r.file), r.method, r.path);
    assert(
      body.includes("writeAuditLog("),
      `${r.file} ${r.method.toUpperCase()} ${r.path} no longer writes an audit row`,
    );
  });
}

// ── AC2: a delete has to say what it deleted ───────────────────────────────

const DESTRUCTIVE = MUST_AUDIT.filter((r) => r.method === "delete");

for (const r of DESTRUCTIVE) {
  Deno.test(`US-2355: DELETE ${r.path} captures a before-image`, async () => {
    const body = handlerBody(await source(r.file), r.method, r.path);
    // The row is READ before it is removed, and that read is what reaches the
    // audit log. Without it the trail records that something was deleted and
    // nothing about what, which cannot be reviewed or restored from.
    assert(
      /\.select\(/.test(body) && /const \{ data: before \}/.test(body),
      `DELETE ${r.path} does not read the row before deleting it`,
    );
    assert(
      /before,|before:/.test(body),
      `DELETE ${r.path} does not put the before-image in the audit row`,
    );
  });

  Deno.test(`US-2355: DELETE ${r.path} 404s on a missing row`, async () => {
    // `.delete().eq("id", …)` against an absent id SUCCEEDS. Without an
    // existence check the route cannot tell "deleted it" from "there was
    // nothing there", and reports the same 200 either way.
    const body = handlerBody(await source(r.file), r.method, r.path);
    assert(
      /if \(!before\) return jsonError\(c, 404/.test(body),
      `DELETE ${r.path} still reports success for a row that never existed`,
    );
  });
}

Deno.test("US-2355: the guard is looking at real routes", () => {
  // Guards the guard: handlerBody() asserts the route exists, so a renamed
  // path fails loudly rather than making every assertion above vacuous. This
  // pins the SIZE of the declared set so a future edit cannot quietly empty it.
  assert(MUST_AUDIT.length >= 8, "the must-audit set shrank");
  assert(DESTRUCTIVE.length >= 3, "the destructive set shrank");
});

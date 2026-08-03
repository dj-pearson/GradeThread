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
// The full policy table AC1 asks for — every admin mutation classified, and
// reviewed as policy rather than derived by a script — is NOT this. It is a
// judgement pass over 100+ routes and remains open on the story. This guard
// holds the ground that has been taken.

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
];

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
  assert(MUST_AUDIT.length >= 7, "the must-audit set shrank");
  assert(DESTRUCTIVE.length >= 3, "the destructive set shrank");
});

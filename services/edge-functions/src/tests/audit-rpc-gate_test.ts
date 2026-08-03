// US-2352: an RPC must enforce at least what the route in front of it claims.
//
// THE HOLE. `GET /api/admin/audit/export` restricts itself to super_admin and
// writes an `audit_log.export` row for every download. The RPC it wraps,
// `admin_audit_log_search`, was guarded only by `is_admin()`, granted to
// `authenticated`, and accepted `p_limit` up to 50,000 — and the console calls
// it from the BROWSER. So any plain admin could open devtools, call the RPC
// directly, and take the whole forensic log: every other admin's IP addresses,
// user agents and `details` payloads, with no export row left behind.
//
// The route's gate and its self-audit were both decoration to anyone willing to
// skip the route. That is the general shape worth guarding: a control in front
// of a callable thing is not a control.
//
// WHAT IS NOT A BUG, because the count invites the wrong conclusion. Fifteen
// SECURITY DEFINER functions share the "granted to authenticated, guarded by
// is_admin()" pattern. Fourteen are fine — thirteen are read-only analytics an
// admin is meant to read, and `is_workspace_member` MUST stay callable by
// authenticated or the RLS policies that call it break. The pattern is a defect
// only where a STRICTER control sits in front of the RPC that the RPC does not
// itself enforce, and today that is this one function.
//
// Migration 00517 is the fix. These read the SQL rather than the database
// because applying migrations needs Docker, and the property worth pinning —
// "the function enforces super_admin" — is a property of the text.

import { assert, assertEquals } from "@std/assert";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

async function sql(file: string): Promise<string> {
  return await Deno.readTextFile(new URL(file, MIGRATIONS));
}

/** The body of one `create or replace function public.<name>` in a file. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`create or replace function public.${name}`);
  assert(at > -1, `${name} not found`);
  const end = src.indexOf("\n$$;", at);
  assert(end > -1, `${name} body not terminated`);
  return src.slice(at, end);
}

// The CURRENT definition of the search RPC. 00517 introduced the gate; 00518
// corrected it (see below). These assert what is live, so they follow the last
// migration that redefines the function — an assertion pinned to a superseded
// file passes while production has something else.
const FIX = "00518_audit_search_self_audit_ordering.sql";
/** 00517 still owns admin_audit_log_filter_options; 00518 did not touch it. */
const GATE = "00517_audit_log_search_super_admin.sql";

Deno.test("US-2352: the search RPC requires super_admin, not merely admin", async () => {
  const body = fnBody(await sql(FIX), "admin_audit_log_search");
  assert(
    body.includes("public.is_super_admin()"),
    "the search RPC no longer checks super_admin — the export route's gate " +
      "becomes skippable again by calling the RPC directly",
  );
  // The service-role escape hatch must remain, or the edge export breaks.
  assert(
    body.includes("auth.role() = 'service_role'"),
    "the service-role caller (the edge export) can no longer read",
  );
  // And plain is_admin() must NOT be what decides.
  assert(
    !/if not \(v_is_service or public\.is_admin\(\)\)/.test(body),
    "the guard fell back to is_admin()",
  );
});

Deno.test("US-2352: a browser caller cannot ask for an export-sized page", async () => {
  // 50,000 exists only for the export path, which runs as service_role behind
  // the super_admin route gate. Two ceilings, so a stolen super-admin session
  // still cannot pull the log in one request.
  const body = fnBody(await sql(FIX), "admin_audit_log_search");
  const m = /v_max\s+int\s*:=\s*case when v_is_service then (\d+) else (\d+) end/
    .exec(body);
  assert(m, "the two-ceiling clamp is gone");
  const [, service, browser] = m;
  assertEquals(Number(service), 50000, "the export path lost its ceiling");
  assert(
    Number(browser) < Number(service),
    "the browser ceiling is no lower than the export ceiling",
  );
  assert(
    Number(browser) <= 500,
    `browser cap ${browser} is larger than a console page needs (25/page)`,
  );
});

Deno.test("US-2352: a direct RPC call records itself", async () => {
  // AC3. The RPC path was the quiet one: the route wrote an audit row and the
  // RPC wrote nothing, so the way around the gate was also the way around the
  // record.
  const body = fnBody(await sql(FIX), "admin_audit_log_search");
  assert(
    body.includes("insert into public.admin_audit_log"),
    "the RPC no longer records its own calls",
  );
  assert(
    body.includes("'audit_log.search'"),
    "the self-audit row lost its action name",
  );
  // Service-role calls stay out of it — the edge route already writes
  // audit_log.export, and recording both double-counts every export.
  // Scoped by position rather than by an adjacent-lines regex: 00518 added the
  // actor_role lookup between the guard and the insert, and the first version
  // of this assertion required them to be neighbours. A guard that breaks when
  // a line is added between two things it cares about is a guard that gets
  // loosened in a hurry by whoever hits it.
  const guardAt = body.indexOf("if not v_is_service then");
  const insertAt = body.indexOf("insert into public.admin_audit_log");
  assert(guardAt > -1, "the non-service-role scope is gone");
  assert(
    insertAt > guardAt,
    "the self-audit is no longer scoped to non-service-role callers, so every " +
      "export is now counted twice",
  );
});

Deno.test("US-2352: the function is VOLATILE, because it writes", async () => {
  // Postgres refuses a write inside a STABLE function. If someone restores
  // `stable` to 'optimise' it, the self-audit above stops being possible — and
  // it would fail at call time in production, not here, unless this is pinned.
  const src = await sql(FIX);
  const decl = src.slice(
    src.indexOf("create or replace function public.admin_audit_log_search"),
    src.indexOf("as $$"),
  );
  assert(decl.includes("volatile"), "the search RPC is not declared volatile");
  assert(!/\bstable\b/.test(decl), "the search RPC is declared stable and writes");
});

Deno.test("US-2352: the filter-options helper is gated the same way", async () => {
  // It feeds the same super-admin-only page and exposes the admin roster plus
  // the action vocabulary of the log. Gating one and not the other leaves the
  // shape of the log readable by anyone the search now refuses.
  const body = fnBody(await sql(GATE), "admin_audit_log_filter_options");
  assert(body.includes("public.is_super_admin()"), "filter options lost its gate");
  // Its return type must stay `jsonb`: CREATE OR REPLACE cannot change a return
  // type, so a rewrite here fails at apply time rather than at review time.
  assert(body.includes("returns jsonb"), "filter options changed return type");
});

Deno.test("US-2352: the migration keeps the US-1108 triple", async () => {
  const src = await sql(FIX);
  assert(
    src.includes("insert into public.applied_migrations (version) values ('00518')"),
    "missing the self-record footer",
  );
  assert(
    src.includes("create or replace function"),
    "not idempotent — a plain CREATE FUNCTION cannot be re-applied",
  );
  // Deliberately NOT a hard-coded version. My first draft asserted the literal
  // "00517", which would have failed on the next unrelated migration — a guard
  // that breaks for a reason it does not guard gets deleted. What matters here
  // is that this migration is not AHEAD of the expected version;
  // schema-version_test.ts already enforces the bump generically.
  const version = await Deno.readTextFile(
    new URL("../lib/schema-version.ts", import.meta.url),
  );
  const expected = /EXPECTED_SCHEMA_VERSION = "(\d+)"/.exec(version)?.[1];
  assert(expected, "EXPECTED_SCHEMA_VERSION not found");
  assert(
    expected! >= "00518",
    `EXPECTED_SCHEMA_VERSION is ${expected}, behind the 00518 correction`,
  );
});


Deno.test("US-2352: the self-audit row does NOT land inside its own result set", async () => {
  // THE BUG 00518 FIXES, and it reached production. 00517 inserted the
  // `audit_log.search` row BEFORE running the search, in the same function and
  // therefore the same statement. Under READ COMMITTED the SELECT saw it:
  // `total_count` grew by one on every call, and because the new row sorts first
  // under `created_at desc` it displaced everything by one — so page 0 returned
  // it plus originals 1-24, and turning to page 1 returned originals 24-48. One
  // duplicated row per page turn, on the forensic surface of all places.
  //
  // The fix is ordering: RETURN QUERY executes immediately and appends its rows,
  // then execution continues, so the insert after it cannot be seen by it.
  const body = fnBody(await sql(FIX), "admin_audit_log_search");
  const returnAt = body.indexOf("return query");
  const insertAt = body.indexOf("insert into public.admin_audit_log");
  assert(returnAt > -1, "the search query is gone");
  assert(insertAt > -1, "the self-audit insert is gone");
  assert(
    insertAt > returnAt,
    "the self-audit insert runs BEFORE the search again, so every call pollutes " +
      "its own result set — inflated total_count and a duplicated row per page",
  );
});

Deno.test("US-2352: the self-audit row carries actor_role", async () => {
  // 00517 left it NULL. Every other writer sets it — lib/audit-log.ts and the
  // 00065 triggers — so a filter on actor_role silently skipped these rows and
  // the CSV export showed a blank column for them.
  const body = fnBody(await sql(FIX), "admin_audit_log_search");
  assert(
    body.includes(
      "(admin_user_id, actor_role, action, target_type, target_id, details)",
    ),
    "the self-audit insert dropped actor_role again",
  );
});

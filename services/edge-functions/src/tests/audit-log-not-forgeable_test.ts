// US-2349 [P0]: the audit log is not writable — or readable — from a browser.
//
// THE FORGERY. 00003 defined the INSERT policy as `WITH CHECK (is_admin())`,
// with nothing tying `admin_user_id` to `auth.uid()`. Any admin could insert
// rows naming any other admin: grant yourself comp credits, then write a dozen
// `admin.change_role` rows stamped with the super_admin's id. Non-repudiation
// was gone for the whole table, and the 00227 anomaly detectors would have fired
// on the forged actor — aiming the investigation at the wrong person.
//
// THE READ HOLE this also closes, which US-2352 missed. 00517 put the search RPC
// behind super_admin and gave it a self-audit. The TABLE's own SELECT policy was
// still `is_admin()`, so a direct `.from("admin_audit_log").select()` in the
// browser returned everything, to any admin, unrecorded. Hardening the front
// door while the wall stays open is worse than leaving both: it reads as fixed.
//
// PROVEN ON A REAL DATABASE — `scripts/verify-audit-log-not-forgeable.sql`, run
// against the full migration corpus on a throwaway stack. Forgery blocked with
// 42501; a direct read returns 0 while the row demonstrably exists; the
// service-role writer and the SECURITY DEFINER read RPC both still work. Then
// the old policies were restored and the same forgery succeeded, so the proof
// measures what it claims.
//
// One trap that proof had to avoid, recorded because it would have produced a
// confident false pass: a local `supabase db reset` grants `authenticated` no
// SELECT/INSERT on ANY public table, so an ungranted run "blocks" the forgery
// for a reason unrelated to the fix. The script grants first, reproducing prod,
// and leaves the policy as the only thing under test.

import { assert } from "@std/assert";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);
const FIX = "00520_audit_log_not_forgeable.sql";

async function sql(file: string): Promise<string> {
  return await Deno.readTextFile(new URL(file, MIGRATIONS));
}

Deno.test("US-2349: neither browser policy survives", async () => {
  const src = await sql(FIX);
  assert(
    src.includes('drop policy if exists "Admins can create audit log entries"'),
    "the forgeable INSERT policy is not dropped",
  );
  assert(
    src.includes('drop policy if exists "Admins can view audit log"'),
    "the SELECT policy is not dropped — a direct read still bypasses the " +
      "super_admin RPC gate and its self-audit",
  );
  // Nothing may replace them. A narrower policy would still be a browser policy.
  assert(
    !/create policy/i.test(src),
    "a policy is created here — the table is meant to have none at all",
  );
});

Deno.test("US-2349: the grant goes too, and only for the browser roles", async () => {
  // PostgREST checks the GRANT as well as the policy, so leaving the grant makes
  // the table one accidental `create policy` away from open again.
  const src = await sql(FIX);
  assert(
    /revoke all on public\.admin_audit_log from anon, authenticated/.test(src),
    "the browser grant is left in place",
  );
  // service_role must NOT be revoked — it is how the edge writes every row.
  assert(
    !/revoke[^;]*from[^;]*service_role/.test(src),
    "service_role is revoked, which stops the edge writing audit rows at all",
  );
});

Deno.test("US-2349: RLS is asserted, not assumed", async () => {
  // A table with no policies and no RLS is wide open, and that is one careless
  // `alter table … disable row level security` away. Cheap to re-assert.
  const src = await sql(FIX);
  assert(
    src.includes("alter table public.admin_audit_log enable row level security"),
    "RLS is not re-asserted, so a table with zero policies could be a table " +
      "with zero protection",
  );
});

Deno.test("US-2349: no browser code writes the audit log", () => {
  // The reason the policy could not simply be dropped before: the SPA wrote
  // rows. US-2376 moved two of the three; the last one is deleted rather than
  // relocated, because an endpoint whose only job is "write me an audit row"
  // reintroduces exactly this forgery.
  const pagesDir = new URL("../../../../src/pages/admin/", import.meta.url);
  const offenders: string[] = [];
  const walk = (dir: URL) => {
    for (const e of Deno.readDirSync(dir)) {
      if (e.isDirectory) {
        walk(new URL(`${e.name}/`, dir));
      } else if (e.name.endsWith(".tsx")) {
        const body = Deno.readTextFileSync(new URL(e.name, dir));
        if (/from\("admin_audit_log"\)[\s\S]{0,200}?\.insert\(/.test(body)) {
          offenders.push(e.name);
        }
      }
    }
  };
  walk(pagesDir);
  assert(
    offenders.length === 0,
    `these admin pages write admin_audit_log from the browser and will now fail ` +
      `silently against the new policy: ${offenders.join(", ")}`,
  );
});

Deno.test("US-2349: the database proof is committed and exercises both halves", async () => {
  const proof = await Deno.readTextFile(
    new URL("../../../../scripts/verify-audit-log-not-forgeable.sql", import.meta.url),
  );
  assert(proof.includes("rollback;"), "the proof is not read-only");
  // The grant-first step is what makes it a test of the POLICY rather than of a
  // local stack that never granted anything.
  assert(
    /grant select, insert on public\.admin_audit_log to authenticated/.test(proof),
    "the proof no longer reproduces prod's grant, so it can pass for the wrong " +
      "reason on a fresh local stack",
  );
  assert(
    proof.includes("set local request.jwt.claims"),
    "the proof no longer impersonates a real session, so RLS would not apply",
  );
  assert(
    proof.includes("rows_actually_present"),
    "the proof no longer shows the row exists, so a read of 0 could just be an " +
      "empty table",
  );
  assert(
    proof.includes("edge_writes"),
    "the proof no longer checks that the service-role writer still works",
  );
});

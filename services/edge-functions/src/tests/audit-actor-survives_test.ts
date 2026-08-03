// US-2350 [P0]: an admin cannot erase their own audit trail by leaving.
//
// THE DEFECT. `admin_audit_log.admin_user_id` was ON DELETE CASCADE (00003).
// The append-only guarantee is a pair of RLS policies permitting SELECT and
// INSERT and nothing else — and a cascade is not a policy-checked DELETE, it is
// referential action, so it went straight through. POST /api/account/delete is
// self-serve, an admin could call it on themselves, and every row that admin had
// ever authored went with them. Issue refunds and role changes for a week, then
// delete the account, and the forensic export returns nothing about any of it.
//
// PROVEN AGAINST A REAL DATABASE, not inferred from the SQL. The whole migration
// corpus was applied to a throwaway local stack and
// `scripts/verify-audit-survives-actor-deletion.sql` was run inside a
// transaction: two audit rows written, the acting admin deleted through
// `auth.users` (the exact path account/delete takes), and both rows survived
// with their email and role intact. Then the CASCADE was restored and the same
// script showed the rows vanish — so the proof measures what it claims to.
//
// These source assertions exist because that proof needs Docker and CI does not
// run it on every push. They pin the three things the fix is made of.

import { assert } from "@std/assert";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);
const FIX = "00519_audit_log_survives_actor_deletion.sql";

async function sql(file: string): Promise<string> {
  return await Deno.readTextFile(new URL(file, MIGRATIONS));
}

Deno.test("US-2350: the actor FK is SET NULL, not CASCADE", async () => {
  const src = await sql(FIX);
  assert(
    /add constraint admin_audit_log_admin_user_id_fkey[\s\S]{0,200}on delete set null/
      .test(src),
    "the audit-log actor FK is not re-added as ON DELETE SET NULL",
  );
  assert(
    !/admin_audit_log_admin_user_id_fkey[\s\S]{0,200}on delete cascade/.test(src),
    "the CASCADE is back — deleting an admin erases their trail again",
  );
  // Dropped with IF EXISTS so the migration is safe to re-run and safe on a
  // database where the constraint has already been replaced.
  assert(
    src.includes("drop constraint if exists admin_audit_log_admin_user_id_fkey"),
    "the constraint drop is not idempotent",
  );
});

Deno.test("US-2350: SET NULL alone is not the fix — identity is denormalized", async () => {
  // A row that survives but no longer says who acted is not much better than no
  // row. The email is captured at write time so a later deletion cannot take it.
  const src = await sql(FIX);
  assert(
    /add column if not exists actor_email text/.test(src),
    "actor_email is gone — a surviving row with a NULL actor names nobody",
  );
  assert(
    /update public\.admin_audit_log[\s\S]{0,300}set actor_email = u\.email/.test(src),
    "existing rows are not backfilled, so history stays anonymous",
  );
});

Deno.test("US-2350: identity is stamped in the DATABASE, not in one writer", async () => {
  // Audit rows arrive from at least three places — lib/audit-log.ts, the 00065
  // dispute trigger, and the 00518 audit-search self-audit. A rule that lives in
  // one writer is a rule the other two do not follow, and the one that forgets
  // is the one whose rows go anonymous.
  const src = await sql(FIX);
  assert(
    src.includes("create trigger trg_stamp_audit_actor"),
    "the stamping trigger is gone",
  );
  assert(
    /before insert on public\.admin_audit_log/.test(src),
    "the trigger is not BEFORE INSERT, so it cannot fill the row being written",
  );
  // It must only fill what the writer left blank: a caller that knows better —
  // an impersonation path recording the real operator — keeps its own value.
  assert(
    src.includes("coalesce(new.actor_email, u.email)"),
    "the trigger overwrites a value the writer supplied deliberately",
  );
  assert(
    src.includes("drop trigger if exists trg_stamp_audit_actor"),
    "the trigger creation is not idempotent",
  );
});

Deno.test("US-2350 AC3: an admin cannot self-serve delete their account", async () => {
  // The step-up that used to guard this proved the person at the keyboard was
  // the account holder, which was never the question. The question is whether
  // the actor whose decisions are on record removes themselves unilaterally.
  const src = await Deno.readTextFile(
    new URL("../routes/account.ts", import.meta.url),
  );
  const at = src.indexOf('accountRoutes.post("/delete"');
  assert(at > -1, "the delete route was renamed");
  const body = src.slice(at, at + 4000);
  assert(
    body.includes("admin_self_delete_blocked"),
    "an admin can self-delete again",
  );
  assert(
    /user\.role === "admin" \|\| user\.role === "super_admin"/.test(body),
    "the block no longer keys on the privileged roles",
  );
  // Ordinary users must stay unaffected — this is a GDPR path for everyone else.
  assert(
    !/return c\.json\([\s\S]{0,200}admin_self_delete_blocked[\s\S]{0,400}\}\s*\n\s*const \{ data: user \}/
      .test(src),
    "the block appears to run before the role is known, which would catch " +
      "ordinary users too",
  );
});

Deno.test("US-2350: the database proof is committed and runnable", async () => {
  // The source assertions above describe the SQL. Only the script proves the
  // BEHAVIOUR, and a proof nobody can re-run is a claim.
  const proof = await Deno.readTextFile(
    new URL("../../../../scripts/verify-audit-survives-actor-deletion.sql", import.meta.url),
  );
  assert(proof.includes("rollback;"), "the proof script is not read-only");
  assert(
    proof.includes("delete from auth.users"),
    "the proof no longer exercises the actual cascade path",
  );
  assert(
    /surviving_rows/.test(proof),
    "the proof no longer asserts the rows survive",
  );
});

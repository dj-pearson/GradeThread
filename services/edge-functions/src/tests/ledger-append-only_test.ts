// US-2565: the credit ledger is append-only in the DATABASE, not by convention.
//
// Three layers, because no single one of them is sufficient:
//
//   1. The SQL says what it must say (source assertions — always run).
//   2. The ops-health tile reports the guard's real state, including the
//      difference between "gone" and "could not tell" (pure — always run).
//   3. The trigger actually fires FOR THE SERVICE ROLE (integration — gated on
//      a DB fixture). This is the one that matters and the one that cannot be
//      faked: RLS does not bind service_role, so a test that only exercises
//      `authenticated` proves nothing about the role every edge route uses.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { requireIntegrationFixtures } from "./integration-required.ts";
import { ledgerAppendOnlyTile } from "../lib/ops-health.ts";

// ── 1. The migration says what it must say ─────────────────────────────────

const MIGRATION = new URL(
  "../../../../supabase/migrations/00597_ledger_append_only.sql",
  import.meta.url,
);

async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

Deno.test("the trigger covers UPDATE and DELETE, row-level, before the write", async () => {
  const sql = await migrationSql();
  assert(
    /BEFORE UPDATE OR DELETE ON public\.grade_credit_transactions/i.test(sql),
    "must be BEFORE (not AFTER) so the write never lands, and must cover both verbs",
  );
  assert(
    /FOR EACH ROW EXECUTE FUNCTION public\.reject_ledger_mutation\(\)/i.test(sql),
    "must be FOR EACH ROW — a statement-level trigger would let a zero-row " +
      "UPDATE pass and would not name the row in the error",
  );
  assert(
    /DROP TRIGGER IF EXISTS grade_credit_transactions_append_only/i.test(sql),
    "must drop before create so the migration is re-runnable (US-1108)",
  );
});

Deno.test("the guard has NO role exemption — service_role included", async () => {
  const sql = await migrationSql();
  // The whole point of a trigger over RLS is that it binds every role. A
  // `current_user`/`auth.role()` escape hatch in this function would silently
  // restore the hole the story exists to close, and would read as a safety
  // feature to whoever added it.
  assert(
    !/auth\.role\(\)|current_user|session_user/i.test(
      sql.slice(sql.indexOf("reject_ledger_mutation"), sql.indexOf("ledger_append_only_enforced")),
    ),
    "reject_ledger_mutation must not branch on the calling role",
  );
  assertStringIncludes(sql, "restrict_violation");
});

Deno.test("the migration states its dependency on 00595", async () => {
  const sql = await migrationSql();
  // Applied alone, before the cascading FK is gone, this trigger aborts every
  // account deletion in the product. The ordering is a real operational hazard
  // and the file has to say so.
  assert(
    /00595/.test(sql),
    "00597 must name its dependency on 00595 — applied first, it breaks account deletion",
  );
});

Deno.test("the enforcement probe checks ENABLED, not merely present", async () => {
  const sql = await migrationSql();
  const fn = sql.slice(sql.indexOf("ledger_append_only_enforced"));
  assert(
    /tgenabled/i.test(fn),
    "a disabled trigger (ALTER TABLE ... DISABLE TRIGGER) still has a pg_trigger " +
      "row, so presence alone would report a removed guard as healthy",
  );
  assert(
    /tgisinternal/i.test(fn),
    "internal (constraint-backed) triggers must be excluded or the probe can " +
      "match something that is not ours",
  );
});

// ── 2. The tile tells the truth, including about not knowing ───────────────

Deno.test("the health tile is green only when the guard is actually enforced", () => {
  const t = ledgerAppendOnlyTile(true);
  assertEquals(t.status, "green");
  assertEquals(t.key, "ledgerAppendOnly");
});

Deno.test("a missing guard is RED, not amber", () => {
  // There is no partial version of "the ledger is evidence". Amber would invite
  // it onto a backlog.
  const t = ledgerAppendOnlyTile(false);
  assertEquals(t.status, "red");
  assertStringIncludes(t.detail ?? "", "00597");
});

Deno.test("an unreadable probe is UNKNOWN, not red and never green", () => {
  // Before 00597 applies the RPC does not exist. Paging an operator about a
  // guard that was never applied trains them to ignore the tile; reporting green
  // would be a lie. Both null and undefined take this path, because a payload
  // from an older edge simply omits the field.
  for (const v of [null, undefined]) {
    const t = ledgerAppendOnlyTile(v);
    assertEquals(t.status, "unknown", `expected unknown for ${String(v)}`);
    assert(t.status !== "green");
  }
});

// ── 3. The trigger fires for the SERVICE ROLE ──────────────────────────────

const URL_ENV = Deno.env.get("TEST_SUPABASE_URL");
const KEY = Deno.env.get("TEST_SUPABASE_SERVICE_ROLE_KEY");
const USER = Deno.env.get("TEST_LEDGER_USER_ID");
const CONFIGURED = Boolean(URL_ENV && KEY && USER);

const RUN = requireIntegrationFixtures(
  "ledger-append-only",
  ["TEST_SUPABASE_URL", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_LEDGER_USER_ID"],
  CONFIGURED,
);

Deno.test({
  name: "service_role cannot UPDATE or DELETE a ledger row",
  ignore: !RUN,
  fn: async () => {
    // Deliberately the SERVICE-ROLE key. An anon/authenticated client would be
    // stopped by RLS long before the trigger, so it would pass whether or not
    // this story shipped — which is the failure mode this test exists to avoid.
    const db = createClient(URL_ENV!, KEY!, { auth: { persistSession: false } });

    // Seed one row through the sanctioned path.
    const { error: grantErr } = await db.rpc("grant_grade_credits", {
      p_user_id: USER!,
      p_credits: 1,
      p_reason: "admin_grant",
      p_notes: "append-only guard test seed",
    });
    assertEquals(grantErr, null, "seed grant should succeed");

    const { data: seeded, error: readErr } = await db
      .from("grade_credit_transactions")
      .select("id, notes")
      .eq("user_id", USER!)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    assertEquals(readErr, null);
    assert(seeded, "seed row should be readable");
    const rowId = (seeded as { id: string }).id;

    // UPDATE must be refused.
    const { error: updateErr } = await db
      .from("grade_credit_transactions")
      .update({ notes: "tampered" })
      .eq("id", rowId);
    assert(updateErr, "UPDATE on a ledger row must fail for service_role");
    assertStringIncludes(
      `${updateErr?.message ?? ""}`.toLowerCase(),
      "append-only",
      "the error should explain the rule and point at compensating rows",
    );

    // DELETE must be refused.
    const { error: deleteErr } = await db
      .from("grade_credit_transactions")
      .delete()
      .eq("id", rowId);
    assert(deleteErr, "DELETE on a ledger row must fail for service_role");

    // And the row is untouched — a refused write that partially applied would be
    // worse than either outcome.
    const { data: after } = await db
      .from("grade_credit_transactions")
      .select("id, notes")
      .eq("id", rowId)
      .maybeSingle();
    assert(after, "the row must still exist after the refused DELETE");
    assertEquals(
      (after as { notes: string | null }).notes,
      "append-only guard test seed",
      "notes must be unchanged after the refused UPDATE",
    );

    // The probe the dashboard reads agrees with what just happened.
    const { data: enforced, error: probeErr } = await db.rpc(
      "ledger_append_only_enforced",
    );
    assertEquals(probeErr, null);
    assertEquals(enforced, true, "ledger_append_only_enforced() must report true");
  },
});

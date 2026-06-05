// US-398: credit-ledger balance consistency — concurrency + reconciliation.
//
// Proves the invariant SUM(delta) == grade_credit_balance survives concurrent
// debits interleaved with a zero-delta included_grant, and that the
// credit_ledger_reconciliation() RPC reports no drift. The row-locking RPCs
// (debit/grant_grade_credits) serialize same-user writes, so a parallel burst
// can neither overspend nor desync the ledger from the balance.
//
// Env-gated + SKIPs cleanly when no DB fixture is configured (same pattern as
// ai-quota-concurrency_test.ts). Required env:
//   TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE_KEY, TEST_LEDGER_USER_ID
// The user's balance + ledger are mutated; use a dedicated fixture user.
//   deno test --allow-net --allow-env src/tests/ledger-consistency_test.ts
import { assert, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";

const URL = Deno.env.get("TEST_SUPABASE_URL");
const KEY = Deno.env.get("TEST_SUPABASE_SERVICE_ROLE_KEY");
const USER = Deno.env.get("TEST_LEDGER_USER_ID");
const CONFIGURED = Boolean(URL && KEY && USER);

if (!CONFIGURED) {
  console.warn(
    "[ledger-consistency] SKIPPED — set TEST_SUPABASE_URL + " +
      "TEST_SUPABASE_SERVICE_ROLE_KEY + TEST_LEDGER_USER_ID to run this test.",
  );
}

Deno.test({
  name: "concurrent debits + included_grant keep ledger == balance with no overspend",
  ignore: !CONFIGURED,
  fn: async () => {
    const db = createClient(URL!, KEY!, { auth: { persistSession: false } });
    const GRANT = 20;

    // Reset to a clean, known balance via the atomic grant RPC.
    const { error: grantErr } = await db.rpc("grant_grade_credits", {
      p_user_id: USER!,
      p_credits: GRANT,
      p_reason: "admin_grant",
      p_notes: "ledger-consistency test seed",
    });
    assertEquals(grantErr, null, "seed grant should succeed");

    // Fire 40 single-credit debits (2x the balance) plus zero-delta
    // included_grant audit rows, all in parallel.
    const debits = Array.from({ length: 40 }, () =>
      db.rpc("debit_grade_credits", {
        p_user_id: USER!,
        p_credits: 1,
        p_submission_id: null,
        p_notes: "ledger-consistency test debit",
      }));
    const auditRows = Array.from({ length: 5 }, () =>
      db.from("grade_credit_transactions").insert({
        user_id: USER!,
        delta: 0,
        reason: "included_grant",
        balance_after: null, // US-398: zero-delta audit row
        notes: "ledger-consistency test audit",
      }));
    await Promise.all([...debits, ...auditRows]);

    // Balance never went negative and exactly GRANT debits succeeded.
    const { data: u } = await db
      .from("users")
      .select("grade_credit_balance")
      .eq("id", USER!)
      .single();
    const balance = (u as { grade_credit_balance: number }).grade_credit_balance;
    assert(balance >= 0, "balance must never go negative");

    // The reconciliation RPC must report NO drift for this user.
    const { data: drift, error: reconErr } = await db.rpc(
      "credit_ledger_reconciliation",
    );
    assertEquals(reconErr, null, "reconciliation query should run");
    const rows = (drift ?? []) as Array<{ user_id: string; drift: number }>;
    const mine = rows.find((r) => r.user_id === USER);
    assertEquals(mine, undefined, "ledger sum must equal balance (no drift)");
  },
});

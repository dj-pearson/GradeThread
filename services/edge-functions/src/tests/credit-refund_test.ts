// US-384: a refunded credit pack must actually DEBIT the wallet (not just
// append a ledger row), and the ledger's balance_after must stay consistent
// with users.grade_credit_balance — including when credits were already spent.
//
// The reversal logic lives in the row-locked SQL RPC revoke_grade_credits, so
// the integration test drives a REAL Supabase with the SERVICE-ROLE key against
// a disposable test user. It is env-gated and SKIPs cleanly without a fixture.
// Required env:
//   TEST_SUPABASE_URL                e.g. https://api.gradethread.com
//   TEST_SUPABASE_SERVICE_ROLE_KEY   service-role key (bypasses RLS)
//   TEST_CREDIT_USER_ID              a users.id safe to mutate in the test DB
//
// Run:  deno task test   (or: deno test --allow-net --allow-env)

import { assert, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { requireIntegrationFixtures } from "./integration-required.ts";

const URL = Deno.env.get("TEST_SUPABASE_URL");
const KEY = Deno.env.get("TEST_SUPABASE_SERVICE_ROLE_KEY");
const USER_ID = Deno.env.get("TEST_CREDIT_USER_ID");

const CONFIGURED = Boolean(URL && KEY && USER_ID);

// US-2038 AC3 (class b): skip locally, but FAIL LOUDLY in a lane that
// declared it would run these — a silent skip and a pass look identical.
const RUN = requireIntegrationFixtures(
  "credit-refund",
  ["TEST_SUPABASE_URL", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_CREDIT_USER_ID"],
  CONFIGURED,
);

function admin() {
  return createClient(URL!, KEY!, { auth: { persistSession: false } });
}

async function balanceOf(db: ReturnType<typeof admin>): Promise<number> {
  const { data } = await db
    .from("users")
    .select("grade_credit_balance")
    .eq("id", USER_ID!)
    .single();
  return (data as { grade_credit_balance: number }).grade_credit_balance;
}

async function latestLedger(db: ReturnType<typeof admin>) {
  const { data } = await db
    .from("grade_credit_transactions")
    .select("delta, reason, balance_after")
    .eq("user_id", USER_ID!)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data as { delta: number; reason: string; balance_after: number };
}

Deno.test({
  name: "refund of an unspent pack reduces the balance and ledger is consistent",
  ignore: !RUN,
  fn: async () => {
    const db = admin();
    const start = await balanceOf(db);

    await db.rpc("grant_grade_credits", {
      p_user_id: USER_ID,
      p_credits: 10,
      p_reason: "pack_purchase",
      p_stripe_payment_intent: "pi_test_refund",
      p_notes: "test pack",
    });
    assertEquals(await balanceOf(db), start + 10, "grant should add 10");

    const { data } = await db.rpc("revoke_grade_credits", {
      p_user_id: USER_ID,
      p_credits: 10,
      p_stripe_payment_intent: "pi_test_refund",
      p_notes: "test refund",
    });
    const result = data as { revoked: number; shortfall: number; balance_after: number };

    assertEquals(result.revoked, 10);
    assertEquals(result.shortfall, 0);
    assertEquals(await balanceOf(db), start, "refund should return balance to start");

    const led = await latestLedger(db);
    assertEquals(led.reason, "refund");
    assertEquals(led.delta, -10);
    // balance_after must match the real wallet, not a hard-coded 0 (the bug).
    assertEquals(led.balance_after, await balanceOf(db));
  },
});

Deno.test({
  name: "refund of an already-spent pack clamps at zero and reports shortfall",
  ignore: !RUN,
  fn: async () => {
    const db = admin();
    const start = await balanceOf(db);

    // Grant 5, then spend them all so the refund can recover nothing.
    await db.rpc("grant_grade_credits", {
      p_user_id: USER_ID,
      p_credits: 5,
      p_reason: "pack_purchase",
      p_stripe_payment_intent: "pi_test_spent",
      p_notes: "test pack spent",
    });
    await db.rpc("debit_grade_credits", {
      p_user_id: USER_ID,
      p_credits: 5,
      p_submission_id: null,
      p_notes: "spend before refund",
    });
    assertEquals(await balanceOf(db), start, "back to start after spend");

    const { data } = await db.rpc("revoke_grade_credits", {
      p_user_id: USER_ID,
      p_credits: 5,
      p_stripe_payment_intent: "pi_test_spent",
      p_notes: "refund of spent pack",
    });
    const result = data as { revoked: number; shortfall: number; balance_after: number };

    // Nothing to claw back from this slice; the shortfall is surfaced (not a
    // silent no-op) and the balance never goes negative.
    assert(result.revoked <= start, "cannot revoke more than the wallet holds");
    assertEquals(result.revoked + result.shortfall, 5, "revoked + shortfall == refunded");
    assert(result.balance_after >= 0, "balance must never go negative");
    assertEquals(await balanceOf(db), result.balance_after);
  },
});

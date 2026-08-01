// US-2291 [P0]: an approved claim draws the guarantee pool down ONCE.
//
// The bug: the claim flow called BOTH `reservePoolDrawdown` (at decision time,
// keyed `purchase:<purchaseId>`) and `recordPoolDrawdown` (after the insert,
// keyed by the CLAIM id). The ledger's idempotency is
// `ON CONFLICT (entry_type, reference_id) DO NOTHING` — so two different keys
// meant nothing conflicted and both rows landed. Every auto-approved claim was
// recorded twice.
//
// What that costs: a $5,000 period budget is exhausted after $2,500 of real
// payouts. The visible symptom is not an error — it is buyers being told the
// guarantee pool is spent when half of it is still there, and the loss-ratio
// circuit-breaker tripping at half the intended loss rate.
//
// The second call carried a comment calling itself "a no-op-on-conflict", which
// is what makes this worth a test rather than just a fix: the INTENT was right
// and the KEY was wrong, and nothing anywhere compared the two. So these assert
// the shared derivation and the arithmetic it protects.

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { poolDrawdownRef, evaluatePoolGate, DEFAULT_GUARANTEE_POOL_CONFIG } = await import(
  "../lib/guarantee-pool.ts"
);

Deno.test("the drawdown reference is keyed on the PURCHASE, not the claim", () => {
  // The claim row does not exist when the reserve runs, and the claim is itself
  // idempotent on purchase_id — so the purchase is the only identifier both
  // sides of the flow can agree on.
  assertEquals(poolDrawdownRef("p1"), "purchase:p1");
});

Deno.test("the same purchase always yields the same reference", () => {
  // The whole defect in one property: if two call sites can derive different
  // keys for one payout, the ledger's ON CONFLICT can never fire.
  assertEquals(poolDrawdownRef("p1"), poolDrawdownRef("p1"));
});

Deno.test("different purchases never collide", () => {
  // The other direction matters too — a shared key would make the SECOND
  // claim's drawdown silently vanish, which is the same bug pointing the other
  // way (the pool would under-count instead of over-counting).
  assertEquals(poolDrawdownRef("p1") === poolDrawdownRef("p2"), false);
});

Deno.test("the claim flow no longer double-writes the drawdown", async () => {
  // A source assertion, because the failure has no runtime symptom to catch:
  // both writes "succeed", the ledger just holds one row too many. The reserve
  // is where the money moves; a second write here can only be a duplicate.
  const src = await Deno.readTextFile(
    new URL("../lib/buyer-guarantee-claim.ts", import.meta.url),
  );
  assertEquals(src.includes("await recordPoolDrawdown("), false);
  assertEquals(src.includes("poolDrawdownRef(purchase.id)"), true);
});

// ── The arithmetic the fix protects ────────────────────────────────────────
//
// evaluatePoolGate is the pure decision the reserve makes under a lock. Feeding
// it the drawn totals a run of claims SHOULD produce, versus the doubled ones
// the bug produced, shows exactly what the budget was doing wrong.

Deno.test("half the budget really paid out must not read as all of it", () => {
  // The story's scenario, stated as arithmetic: a $5,000 period budget is
  // exhausted after $2,500 of real payouts. evaluatePoolGate is the pure
  // decision the reserve makes under a lock, so feeding it the TRUE spend and
  // the DOUBLED spend shows exactly what the budget was doing wrong.
  const cfg = DEFAULT_GUARANTEE_POOL_CONFIG; // period budget 500000 cents
  const claim = 3000;
  const trueSpend = cfg.period_budget_cents / 2;

  assertEquals(
    evaluatePoolGate(
      claim,
      { periodAccruedCents: 1_000_000, periodDrawnCents: trueSpend, accountDrawnCents: 0 },
      cfg,
    ).allowAuto,
    true,
    "half the budget spent must still auto-approve",
  );

  // What the bug recorded for the same run of payouts. The buyer is refused and
  // told the pool is exhausted while half of it is still there.
  assertEquals(
    evaluatePoolGate(
      claim,
      { periodAccruedCents: 1_000_000, periodDrawnCents: trueSpend * 2, accountDrawnCents: 0 },
      cfg,
    ),
    { allowAuto: false, reason: "period_budget" },
  );
});

Deno.test("double-counting also trips the loss-ratio breaker at half the real loss", () => {
  // The subtler consequence: the circuit-breaker is a ratio of drawn to
  // accrued, so doubling the numerator halves the loss rate it fires at — the
  // whole guarantee auto-approval path shuts off twice as early as intended.
  const cfg = DEFAULT_GUARANTEE_POOL_CONFIG;
  const accrued = 100_000;
  const trueDrawn = Math.floor(accrued * cfg.loss_ratio_throttle) - 2000;
  assertEquals(
    evaluatePoolGate(
      1000,
      { periodAccruedCents: accrued, periodDrawnCents: trueDrawn, accountDrawnCents: 0 },
      cfg,
    ).allowAuto,
    true,
  );
  assertEquals(
    evaluatePoolGate(
      1000,
      { periodAccruedCents: accrued, periodDrawnCents: trueDrawn * 2, accountDrawnCents: 0 },
      cfg,
    ).allowAuto,
    false,
  );
});

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

import { assert, assertEquals } from "@std/assert";

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

// ── US-2396: ONE derivation, both writers ──────────────────────────────────
//
// The point of poolDrawdownRef is that a single function decides what a
// drawdown is keyed on. Two writers reach guarantee_pool_ledger — the
// automatic reserve in buyer-guarantee-claim.ts and the manual approval in
// admin-guarantee-pool.ts — and the manual one passed the CLAIM id while the
// reserve passed the PURCHASE id, which is the exact mismatch US-2291 was
// filed for, in the file that fixed it.
//
// STATE PLAINLY WHAT THIS WAS: not a live double-drawdown. 00490 writes the
// ledger row only on the allowed path, so a reserved claim ends up
// auto_approved, and the admin route refuses any claim whose status is not
// manual_review — so no claim could be both reserved and manually approved,
// and the two key forms never met. It was a latent mismatch and a doc that
// lied about its only caller.
//
// The reason to close it anyway is that both of those conditions live far from
// this code and neither is written where an editor would have to read it. The
// guard below is what makes the invariant survive them changing.

Deno.test("US-2396: both drawdown writers derive the ref from poolDrawdownRef", async () => {
  const read = async (p: string) =>
    (await Deno.readTextFile(new URL(p, import.meta.url)))
      // Comments stripped. Both files now EXPLAIN this rule at length and name
      // the old shape verbatim, so a raw scan would be satisfied by the prose
      // describing the bug — and would stay green after a revert.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");

  const admin = await read("../routes/admin-guarantee-pool.ts");
  const auto = await read("../lib/buyer-guarantee-claim.ts");

  // The manual path: keyed through the shared derivation, on the PURCHASE.
  assert(
    /recordPoolDrawdown\(\s*poolDrawdownRef\(cl\.purchase_id\)/.test(admin),
    "the manual approval no longer keys its drawdown through poolDrawdownRef — " +
      "a second key form in the ledger means a reserved claim can be drawn " +
      "down twice as soon as it becomes reachable",
  );
  // And specifically NOT on the claim id, which is what it used to pass.
  assert(
    !/recordPoolDrawdown\(\s*cl\.id\b/.test(admin),
    "the manual approval is keyed on the claim id again",
  );

  // The automatic path, unchanged — asserted here so the two are pinned
  // TOGETHER. Either one drifting alone re-creates the mismatch, and a guard
  // that watches only one of them cannot see that.
  assert(
    /poolDrawdownRef\(purchase\.id\)/.test(auto),
    "the automatic reserve no longer keys on the purchase",
  );
});

Deno.test("US-2396: the parameter name no longer contradicts the doc", () => {
  // The mismatch was invited by the signature. The doc said "pass
  // poolDrawdownRef"; the parameter was called `claimId`, and the only caller
  // believed the parameter. The value lands in `reference_id` unexamined
  // either way, so nothing at the call site could reveal the disagreement.
  const src = Deno.readTextFileSync(
    new URL("../lib/guarantee-pool.ts", import.meta.url),
  );
  const at = src.indexOf("export async function recordPoolDrawdown(");
  assert(at > -1, "recordPoolDrawdown is gone");
  const sig = src.slice(at, src.indexOf(")", at));
  assert(
    /referenceId: string/.test(sig),
    "the first parameter is named for a claim again, which is how the wrong " +
      "id got passed in the first place",
  );
  assert(!/claimId/.test(sig), "the claimId parameter name is back");
});

// US-2022: consignor payout reversal decisions + the return-window hold.
//
// Pure logic only — no Stripe, no DB. The money question these pin down is
// "when a sale comes apart, does the consignor's cut come back?", which before
// this story had the answer "no, and nothing tells you".
//
//   deno test --allow-env src/tests/consignor-reversal_test.ts

import { assertEquals } from "@std/assert";

const {
  planReversal,
  isReversingSaleStatus,
  normalizeConsignorPayoutConfig,
  DEFAULT_CONSIGNOR_PAYOUT_CONFIG,
  holdUntilFor,
  isHeld,
} = await import("../lib/consignor-reversal-math.ts");

const PAID = { id: "p1", status: "paid", amount: 120, stripe_transfer_id: "tr_123" };

Deno.test("a paid payout with a transfer id is reversed for its full amount", () => {
  const plan = planReversal(PAID);
  assertEquals(plan, {
    action: "reverse",
    payoutId: "p1",
    transferId: "tr_123",
    amount: 120,
  });
});

// The headline scenario from the story: $200 item, 60% split, buyer returns it.
Deno.test("the $120-on-a-$200-return case reverses rather than staying paid", () => {
  const plan = planReversal({ ...PAID, amount: 120 });
  assertEquals(plan.action, "reverse");
  if (plan.action === "reverse") assertEquals(plan.amount, 120);
});

Deno.test("pending / failed / processing are cancelled — no money left the platform", () => {
  for (const status of ["pending", "failed", "processing"]) {
    const plan = planReversal({ ...PAID, status, stripe_transfer_id: null });
    assertEquals(plan.action, "cancel", `${status} should cancel`);
  }
});

// An unrecognised status must not fall through to "leave it paid". Cancelling
// costs a re-issued payout; the alternative is money leaving for a dead sale.
Deno.test("an unknown status is cancelled, not ignored", () => {
  assertEquals(planReversal({ ...PAID, status: "who_knows" }).action, "cancel");
});

Deno.test("already-reversed and already-canceled rows are skipped (idempotent)", () => {
  assertEquals(planReversal({ ...PAID, status: "reversed" }), {
    action: "skip",
    payoutId: "p1",
    reason: "already_reversed",
  });
  assertEquals(planReversal({ ...PAID, status: "canceled" }), {
    action: "skip",
    payoutId: "p1",
    reason: "already_canceled",
  });
});

// This is the case that must never be silently dropped: the money moved, but we
// have nothing to reverse against, so only a human can recover it.
Deno.test("paid with no transfer id is FLAGGED for a human, never skipped", () => {
  for (const transferId of [null, "", "   "]) {
    const plan = planReversal({ ...PAID, stripe_transfer_id: transferId });
    assertEquals(plan.action, "flag", `transfer_id=${JSON.stringify(transferId)}`);
  }
});

Deno.test("an already-flagged clawback stays flagged rather than retrying forever", () => {
  assertEquals(planReversal({ ...PAID, status: "clawback_pending" }).action, "flag");
});

Deno.test("a zero or malformed amount is skipped — there is nothing to reverse", () => {
  for (const amount of [0, -5, Number.NaN]) {
    const plan = planReversal({ ...PAID, amount });
    assertEquals(plan.action, "skip", `amount=${amount}`);
  }
});

// ── which sale statuses trigger a reversal ──────────────────────────

Deno.test("reversing sale statuses are recognised, including both spellings of cancelled", () => {
  for (const s of ["returned", "refunded", "cancelled", "canceled", "RETURNED", " Refunded "]) {
    assertEquals(isReversingSaleStatus(s), true, `${s} should reverse`);
  }
  for (const s of ["completed", "pending", "", null, undefined]) {
    assertEquals(isReversingSaleStatus(s), false, `${s} should NOT reverse`);
  }
});

// ── the hold window ─────────────────────────────────────────────────

Deno.test("the hold ships OFF, so existing payout timing is unchanged", () => {
  assertEquals(DEFAULT_CONSIGNOR_PAYOUT_CONFIG.hold_days, 0);
  assertEquals(holdUntilFor(DEFAULT_CONSIGNOR_PAYOUT_CONFIG, Date.parse("2026-01-01")), null);
});

Deno.test("a configured hold stamps sale-date + hold_days", () => {
  const saleMs = Date.parse("2026-01-01T00:00:00.000Z");
  const until = holdUntilFor({ hold_days: 30 }, saleMs);
  assertEquals(until, "2026-01-31T00:00:00.000Z");
});

Deno.test("garbage config falls back to the safe default rather than throwing", () => {
  for (const raw of [null, undefined, {}, { hold_days: -1 }, { hold_days: "nope" }]) {
    assertEquals(normalizeConsignorPayoutConfig(raw).hold_days, 0, JSON.stringify(raw));
  }
  assertEquals(normalizeConsignorPayoutConfig({ hold_days: "45" }).hold_days, 45);
  assertEquals(normalizeConsignorPayoutConfig({ hold_days: 7.9 }).hold_days, 7);
});

Deno.test("isHeld is true only while the stamp is in the future", () => {
  const now = Date.parse("2026-01-15T00:00:00.000Z");
  assertEquals(isHeld("2026-01-31T00:00:00.000Z", now), true);
  assertEquals(isHeld("2026-01-01T00:00:00.000Z", now), false);
  assertEquals(isHeld(null, now), false);
  // A malformed stamp must not hold a payout hostage forever.
  assertEquals(isHeld("not-a-date", now), false);
});

// ── US-2031: explicit single-currency enforcement ───────────────────
//
// fireTransfer hardcodes "usd". Before this, `sales` carried no currency at
// all, so a GBP 120 sale would have transferred as USD 120 with no error —
// wrong amounts, silently, in the direction of overpaying the consignor.

const { isPayableCurrency, PAYOUT_CURRENCY } = await import("../lib/consignor-payout-math.ts");

Deno.test("USD is payable, in any casing or spacing the API might send", () => {
  for (const c of ["usd", "USD", " Usd ", "uSd"]) {
    assertEquals(isPayableCurrency(c), true, `${c} should be payable`);
  }
  assertEquals(PAYOUT_CURRENCY, "usd");
});

// NULL/blank = "the marketplace never told us" — every pre-existing sale row.
// These must keep behaving exactly as before, NOT start being refused.
Deno.test("an unreported currency is treated as USD, so legacy sales still pay", () => {
  for (const c of [null, undefined, "", "   "]) {
    assertEquals(isPayableCurrency(c), true, `${JSON.stringify(c)} should be payable`);
  }
});

Deno.test("any other currency is REFUSED rather than paid as dollars", () => {
  for (const c of ["gbp", "GBP", "eur", "cad", "aud", "jpy"]) {
    assertEquals(isPayableCurrency(c), false, `${c} must be refused`);
  }
});

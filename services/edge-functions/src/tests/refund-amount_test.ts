import { assertEquals, assertMatch } from "@std/assert";
import {
  normalizeRefundAmount,
  refundIdempotencyKey,
} from "../lib/refund-amount.ts";

// US-2294: an admin refund of `amount: 0` used to refund the ENTIRE charge.
//
// `...(amount ? { amount } : {})` — 0 is falsy, so the field was dropped, and
// Stripe reads a refund with no amount as a full one. The admin typed the
// universal "no, nothing" and the customer got everything back. There was also
// no upper bound of any kind, so a typo'd extra digit went straight through.
//
// These are the cases nobody wants to exercise against a live charge, which is
// exactly why the validation is pure and tested here instead.

Deno.test("amount 0 is refused, and the error teaches the right way", () => {
  const res = normalizeRefundAmount(0, 5000);
  assertEquals(res.ok, false);
  if (res.ok) return;
  assertMatch(res.error, /greater than zero/);
  // Naming the alternative matters: an admin who wanted a full refund and typed
  // 0 needs to be told to omit the field, not just told "no".
  assertMatch(res.error, /omit the amount/);
});

Deno.test("negative, fractional and non-numeric amounts are refused", () => {
  for (const bad of [-100, 10.5, Number.NaN, Number.POSITIVE_INFINITY, "500", {}]) {
    assertEquals(normalizeRefundAmount(bad, 5000).ok, false, `accepted ${String(bad)}`);
  }
  const frac = normalizeRefundAmount(10.5, 5000);
  if (!frac.ok) assertMatch(frac.error, /whole number/);
});

Deno.test("the ceiling is the REMAINING balance, not the original charge", () => {
  // A 1000-cent charge already refunded 500 can only give back 500 more.
  assertEquals(normalizeRefundAmount(600, 500).ok, false);
  assertEquals(normalizeRefundAmount(500, 500), {
    ok: true,
    kind: "partial",
    amount: 500,
  });
});

Deno.test("an over-balance amount names the number that would have worked", () => {
  const res = normalizeRefundAmount(5001, 5000);
  assertEquals(res.ok, false);
  if (!res.ok) assertMatch(res.error, /5000 cents remaining/);
});

Deno.test("a full refund is an INTENT — absent, never falsy", () => {
  assertEquals(normalizeRefundAmount(undefined, 5000), { ok: true, kind: "full" });
  assertEquals(normalizeRefundAmount(null, 5000), { ok: true, kind: "full" });
});

Deno.test("an already-fully-refunded charge is refused both ways", () => {
  assertEquals(normalizeRefundAmount(undefined, 0).ok, false);
  assertEquals(normalizeRefundAmount(100, 0).ok, false);
});

Deno.test("an unknown balance refuses a partial but still allows a full refund", () => {
  // An unknown ceiling is not a smaller version of "no ceiling" — it is the
  // same problem, so the partial path fails closed.
  const partial = normalizeRefundAmount(100, null);
  assertEquals(partial.ok, false);
  if (!partial.ok) assertMatch(partial.error, /refusing a partial refund/);
  assertEquals(normalizeRefundAmount(undefined, null), { ok: true, kind: "full" });
});

Deno.test("full and partial idempotency keys can never collide", () => {
  // The old key interpolated `amount ?? "full"`, so `amount: 0` produced `:0`
  // for something Stripe executed as a FULL refund — a different key for the
  // same effect, which meant the double-click guard was bypassed by the exact
  // input that caused the bug.
  const full = refundIdempotencyKey("ch_1", { ok: true, kind: "full" });
  const partial = refundIdempotencyKey("ch_1", {
    ok: true,
    kind: "partial",
    amount: 250,
  });
  assertEquals(full, "admin-refund:ch_1:full");
  assertEquals(partial, "admin-refund:ch_1:250");
  assertEquals(full === partial, false);
});

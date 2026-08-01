// US-2294: validate an admin refund amount before it reaches Stripe.
//
// The bug this exists to remove was one character wide. The route built its
// Stripe call as `...(amount ? { amount } : {})`, so a literal **0 is falsy**,
// the field was dropped, and Stripe reads a refund with no amount as a FULL
// refund. An admin typing 0 — the universal "no, don't refund anything" — got
// the entire charge back to the customer instead. There was also no upper bound
// at all, so a typo'd extra digit went straight through.
//
// Two lessons are encoded here rather than left to the caller:
//
//   1. "refund everything" is an INTENT and must be stated, never inferred from
//      a value being falsy. Absent means full; present means partial; 0 is
//      neither and is rejected.
//   2. The ceiling is the charge's REMAINING refundable balance, not its
//      original amount — a charge already refunded 40% can only give back the
//      other 60%, and asking Stripe for more fails after the audit-log entry
//      has already been written.
//
// Pure on purpose: no Stripe client, no env, no I/O. That is what lets the
// interesting cases (0, negative, fractional, over-balance) be tested at all —
// they are exactly the ones nobody wants to exercise against a live charge.

export type RefundAmountResult =
  /** A partial refund of exactly `amount` minor units. */
  | { ok: true; kind: "partial"; amount: number }
  /** No amount supplied: refund the whole remaining balance. */
  | { ok: true; kind: "full" }
  | { ok: false; error: string };

/**
 * Normalize the `amount` field of an admin refund request.
 *
 * `raw` is the untrusted body value. `remainingCents` is the charge's
 * refundable balance (`charge.amount - charge.amount_refunded`).
 *
 * Passing `null`/`undefined` for `remainingCents` means the balance could not
 * be read. A partial refund is REFUSED in that case rather than sent unchecked:
 * the whole point of the ceiling is that we could not previously tell a $5
 * refund from a $500 one, and an unknown ceiling is not a smaller version of
 * that problem.
 */
export function normalizeRefundAmount(
  raw: unknown,
  remainingCents?: number | null,
): RefundAmountResult {
  // Absent is the only way to ask for a full refund. Explicitly NOT `!raw`.
  if (raw === undefined || raw === null) {
    if (remainingCents != null && remainingCents <= 0) {
      return { ok: false, error: "This charge has already been fully refunded." };
    }
    return { ok: true, kind: "full" };
  }

  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, error: "amount must be a number of cents." };
  }
  if (!Number.isInteger(raw)) {
    // Stripe works in minor units; 10.5 cents is not a thing, and rounding it
    // silently would refund a different number than the admin typed.
    return { ok: false, error: "amount must be a whole number of cents." };
  }
  if (raw <= 0) {
    // The original defect. Named explicitly so the error teaches the rule.
    return {
      ok: false,
      error:
        "amount must be greater than zero. To refund the full charge, omit the amount.",
    };
  }
  if (remainingCents == null) {
    return {
      ok: false,
      error: "Could not read the charge's refundable balance; refusing a partial refund.",
    };
  }
  if (remainingCents <= 0) {
    return { ok: false, error: "This charge has already been fully refunded." };
  }
  if (raw > remainingCents) {
    return {
      ok: false,
      error: `amount exceeds the refundable balance (${remainingCents} cents remaining).`,
    };
  }
  return { ok: true, kind: "partial", amount: raw };
}

/**
 * The Stripe idempotency key for a refund.
 *
 * Kept next to the validator because the two have to agree on what "full"
 * means. The old key interpolated `amount ?? "full"`, which for `amount = 0`
 * produced `:0` — a DIFFERENT key from `:full` for what Stripe would execute as
 * the same full refund. So the guard against a double-click could be bypassed
 * by the very input that triggered the bug.
 */
export function refundIdempotencyKey(
  chargeId: string,
  result: Extract<RefundAmountResult, { ok: true }>,
): string {
  return result.kind === "full"
    ? `admin-refund:${chargeId}:full`
    : `admin-refund:${chargeId}:${result.amount}`;
}

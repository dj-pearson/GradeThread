// US-1640: classify the result of a per-grade "mark paid" flip so a DUPLICATE
// payment for the same submission is refunded instead of silently kept.
//
// The per-grade Checkout idempotency key is tier-scoped, so one submission can
// mint up to 3 payable Checkout Sessions — a user can genuinely pay twice for
// the same grade. The Stripe dispatcher dedupes by event.id BEFORE the handler
// runs, so a 0-row flip is never a re-delivery: the submission is already paid
// by a DIFFERENT session. This pure classifier makes that decision testable
// without a DB or live Stripe.

export type PerGradeFlipOutcome =
  | "paid" // the flip claimed the submission — proceed to grade
  | "duplicate" // already paid by a DIFFERENT charge — refund THIS one
  | "already" // already paid by the SAME PI / a concurrent flip — no refund
  | "missing"; // submission not found for this owner — nothing to do

export interface ExistingSubmission {
  payment_status: string;
  stripe_payment_intent_id: string | null;
}

export function classifyPerGradeFlip(params: {
  /** Did the conditional `.eq(payment_status,'unpaid')` update claim a row? */
  flipped: boolean;
  /** The submission re-read after a 0-row flip (owner-scoped), or null. */
  existing: ExistingSubmission | null;
  /** The PaymentIntent of the CURRENT Checkout Session being processed. */
  currentPaymentIntentId: string | null;
}): PerGradeFlipOutcome {
  if (params.flipped) return "paid";
  if (!params.existing) return "missing";
  const paidByAnotherCharge =
    params.existing.payment_status !== "unpaid" &&
    params.existing.stripe_payment_intent_id !== params.currentPaymentIntentId;
  return paidByAnotherCharge ? "duplicate" : "already";
}

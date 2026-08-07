// US-2289: which submissions have already had money taken for them.
//
// Its own module, and pure, for one reason: it is the hinge the batch
// double-charge fix turns on, and getting it wrong in either direction is
// expensive. Keeping it out of grading-batch-worker.ts means the rule can be
// tested without booting the whole grading pipeline — which is exactly the kind
// of friction that leaves a rule like this untested.

/**
 * True when `payment_status` means the charging chokepoint (grade-billing.ts)
 * has already taken money for this submission.
 *
 * The paid values are the ones the charging paths write: an included-allowance
 * grant, a seller credit debit, a one-off Stripe checkout, and (US-1841) a buyer
 * video-grade credit. Anything else — "unpaid", a NULL, a value from a future
 * migration this code has not seen — is treated as UNPAID, deliberately.
 *
 * Fail CLOSED, and the asymmetry is the reason: a false negative re-creates a
 * submission nobody was charged for, which costs nothing. A false positive
 * skips a charge that never happened, or worse, resumes something we do not own.
 *
 * Adding a payment_status without adding it here is therefore SAFE but wasteful
 * (the work gets redone free); adding one here that isn't really paid is not.
 */
export function isPaidSubmissionStatus(status: string | null | undefined): boolean {
  return status === "included" || status === "credits" ||
    status === "paid_stripe" || status === "buyer_credits";
}

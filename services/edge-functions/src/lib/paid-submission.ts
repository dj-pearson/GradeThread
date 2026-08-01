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
 * The three paid values are the three it writes: an included-allowance grant,
 * a credit debit, and a one-off Stripe checkout. Anything else — "unpaid", a
 * NULL, a value from a future migration this code has not seen — is treated as
 * UNPAID, deliberately.
 *
 * Fail CLOSED, and the asymmetry is the reason: a false negative re-creates a
 * submission nobody was charged for, which costs nothing. A false positive
 * skips a charge that never happened, or worse, resumes something we do not own.
 */
export function isPaidSubmissionStatus(status: string | null | undefined): boolean {
  return status === "included" || status === "credits" || status === "paid_stripe";
}

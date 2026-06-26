// US-484: Certificate visibility gate.
//
// A grade whose parent submission was flagged for moderation (not-clothing /
// suspected image manipulation / cross-account photo reuse — set in
// grading-pipeline.ts) must NOT be publicly resolvable until a human clears it.
// The admin approve path (US-476) sets flagged=false + moderation_status
// 'approved', which makes the certificate citable again.
//
// This is the single source of truth for that predicate, shared by the public
// certificate endpoint and the public integrity-verify endpoint so the two can
// never drift. It is a pure function so the withhold behaviour is unit-testable
// without a live database (AC3).

export interface CertificateModerationState {
  flagged?: boolean | null;
  moderation_status?: string | null;
  // Mandatory-review lifecycle: a submission still in `pending_review` has a
  // PRELIMINARY grade whose certificate must not be publicly resolvable until a
  // human finalizes it. Selected alongside flagged/moderation_status by every
  // public cert path so this predicate stays the single source of truth.
  status?: string | null;
}

/**
 * True when a certificate must be withheld (return 404) from the public cert
 * and verify endpoints. A certificate is withheld when EITHER:
 *   • its grade is still preliminary (submission status `pending_review`) and
 *     so not yet finalized by a human reviewer, OR
 *   • its submission is flagged for moderation AND not yet explicitly approved.
 *
 * A null/missing submission is treated as NOT withheld here — the caller has
 * already proven a certified (public) report exists; absence of a moderation
 * row means nothing flagged it.
 */
export function isCertificateWithheld(
  sub: CertificateModerationState | null | undefined,
): boolean {
  if (sub?.status === "pending_review") return true;
  return sub?.flagged === true && sub.moderation_status !== "approved";
}

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
}

/**
 * True when a certificate must be withheld (return 404) from the public cert
 * and verify endpoints. A certificate is withheld iff its submission is flagged
 * AND has not yet been explicitly approved by a human reviewer.
 *
 * A null/missing submission is treated as NOT withheld here — the caller has
 * already proven a certified (public) report exists; absence of a moderation
 * row means nothing flagged it.
 */
export function isCertificateWithheld(
  sub: CertificateModerationState | null | undefined,
): boolean {
  return sub?.flagged === true && sub.moderation_status !== "approved";
}

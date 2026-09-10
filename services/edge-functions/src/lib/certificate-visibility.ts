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

/**
 * A row from the sitemap list query: the certificate, its parent submission's
 * moderation state, and the submission id the photo check keys on.
 */
export interface CertificateListRow {
  certificate_id?: string | null;
  created_at?: string | null;
  submission_id?: string | null;
  /** supabase-js returns a to-one embed as an object, occasionally an array. */
  submissions?: CertificateModerationState | CertificateModerationState[] | null;
}

/**
 * The certificates sitemap-certs.xml is allowed to advertise.
 *
 * TWO rules, and the second one is the one that was missing. A withheld
 * certificate 404s, so listing it would be a soft 404 (US-484/US-1680). A
 * certificate with no garment photo resolves fine and is served `noindex`
 * because it is too thin to rank (US-1665 AC4) — so listing it tells a crawler
 * to fetch a page we then tell it to drop, which is the US-2098 contradiction
 * on the one surface designed to scale to 50,000 URLs.
 *
 * `withPhotos` is the set of submission ids that have at least one image row,
 * which is what selectHeroUrl() resolves a hero from. The photoless rule also
 * lives in functions/cert/[id].ts, which runs in Cloudflare Pages and cannot
 * import this; the two cite each other instead.
 *
 * Pure, so the contract is testable without a database.
 */
export function indexableCertificates(
  rows: readonly CertificateListRow[],
  withPhotos: ReadonlySet<string>,
): CertificateListRow[] {
  return rows.filter((r) => {
    const sub = Array.isArray(r.submissions) ? r.submissions[0] : r.submissions;
    if (isCertificateWithheld(sub)) return false;
    return typeof r.submission_id === "string" && withPhotos.has(r.submission_id);
  });
}

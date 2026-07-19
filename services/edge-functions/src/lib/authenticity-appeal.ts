// US-2145: withdrawing an authenticity verdict a seller successfully contested.
//
// Everything else in this module protects the buyer. This is the only path that
// protects a SELLER whose genuine item was flagged — the error direction no
// guarantee reimburses, produced by a pass with no measured error rate
// (US-2130/2131), and now durable because we sealed the verdict into certificate
// integrity v4 and wrote it to an append-only passport ledger.
//
// Three mechanical consequences follow from an upheld appeal, and all three must
// happen or the record contradicts itself:
//
//   1. The stored assessment is withdrawn (the certificate must stop displaying
//      a verdict a human has overturned).
//   2. The certificate is RESEALED. Integrity v4 covers the verdict, so changing
//      it without resealing leaves a hash over a verdict no longer shown —
//      verification then fails on exactly the certificate we just corrected.
//   3. The outcome routes through the US-2140 review path, so a wrongly-flagged
//      genuine item becomes an 'authentic' golden-set case. That is the most
//      valuable label the system can obtain: a confirmed false positive.
//
// NOT decided here, deliberately: what the certificate and passport RENDER while
// an appeal is open, the SLA, and the notice wording. Those are product and
// counsel decisions (US-2133), not mechanics.

import type { CertIntegrityFields } from "./cert-integrity.ts";

export type AppealOutcome = "upheld" | "rejected";

export interface WithdrawnAssessment {
  /** The verdict is cleared, not rewritten to a different verdict. */
  verdict: null;
  verdict_confidence: null;
  /** Cleared because the PUBLIC VIEW derives its confidence band from this. */
  authenticity_confidence: null;
  /** Cleared because the public view surfaces it as a risk label. */
  counterfeit_risk: null;
  /** Cleared because the public view renders it verbatim to buyers. */
  summary: null;
  withdrawn: true;
  withdrawn_at: string;
  withdrawn_reason: string;
  /** The original assessment, kept operator-side for the record. */
  withdrawn_original: Record<string, unknown>;
}

/**
 * Build the withdrawn form of a stored assessment. Pure + exported.
 *
 * The verdict is CLEARED rather than flipped to 'likely_authentic'. An upheld
 * appeal means the assessment should never have been published — it does not
 * mean we now positively vouch for the item, and asserting that would be the
 * same overreach in the opposite direction.
 *
 * ⚠ WHICH FIELDS MUST BE CLEARED IS NOT OBVIOUS, and getting it wrong is silent.
 * The public certificate view (00172, carried forward through 00307) does NOT
 * read `verdict`. It derives what a buyer sees from:
 *
 *     authenticity_confidence  → authenticity_confidence_band
 *     counterfeit_risk         → authenticity_counterfeit_risk
 *     summary                  → authenticity_summary
 *
 * So clearing only the verdict would leave a seller who WON their appeal with a
 * certificate still publicly showing an elevated counterfeit risk and the
 * original red-flag summary. Every field the view reads has to go.
 *
 * The original is preserved under `withdrawn_original` — operator-side, since no
 * view projects it — so the record of what was said, and that an appeal was
 * necessary, survives the correction.
 */
export function withdrawAssessment(
  assessment: Record<string, unknown> | null,
  reason: string,
  nowIso: string,
): (Record<string, unknown> & WithdrawnAssessment) | null {
  if (!assessment) return null;
  return {
    ...assessment,
    verdict: null,
    verdict_confidence: null,
    authenticity_confidence: null,
    counterfeit_risk: null,
    summary: null,
    withdrawn: true,
    withdrawn_at: nowIso,
    withdrawn_reason: reason.slice(0, 500),
    withdrawn_original: { ...assessment },
  };
}

/**
 * Fields the PUBLIC certificate view reads out of `authenticity_assessment`.
 * Exported so a test can assert the withdrawal clears every one of them — if
 * the view ever learns a new field, that test fails rather than a seller
 * silently staying flagged after winning an appeal.
 */
export const PUBLICLY_PROJECTED_ASSESSMENT_FIELDS = [
  "authenticity_confidence",
  "counterfeit_risk",
  "summary",
] as const;

/**
 * The certificate fields to reseal with after a withdrawal. Pure + exported.
 *
 * Scores are carried through untouched: an authenticity appeal says nothing
 * about the garment's CONDITION, and silently re-deriving a grade here would
 * change a number nobody contested.
 */
export function resealFieldsAfterWithdrawal(
  current: CertIntegrityFields,
): CertIntegrityFields {
  return {
    ...current,
    // v4 canonicalizes null as the defined empty verdict, so a withdrawn
    // certificate hashes identically to one that never had the add-on.
    authenticity_verdict: null,
    authenticity_verdict_confidence: null,
  };
}

export interface AppealResolution {
  outcome: AppealOutcome;
  /** Withdraw the stored verdict and reseal? Only on an upheld appeal. */
  withdraw: boolean;
  /** Feed the golden set with a confirmed-authentic case? */
  promoteAsAuthentic: boolean;
  /** The reviewer verdict to record via the US-2140 path, if any. */
  reviewerVerdict: "authentic" | null;
}

/**
 * What an appeal decision implies. Pure + exported.
 *
 * A REJECTED appeal deliberately produces no golden-set case. Upholding the
 * original verdict is not the same as a human independently confirming the item
 * is counterfeit — the reviewer may simply have found the appeal unpersuasive,
 * and treating that as ground truth would seed the golden set with labels nobody
 * actually verified. A confirmed counterfeit comes through the US-2140 review
 * path on its own merits.
 */
export function resolveAppeal(outcome: AppealOutcome): AppealResolution {
  if (outcome === "upheld") {
    return {
      outcome,
      withdraw: true,
      promoteAsAuthentic: true,
      reviewerVerdict: "authentic",
    };
  }
  return {
    outcome,
    withdraw: false,
    promoteAsAuthentic: false,
    reviewerVerdict: null,
  };
}

/** Validate an incoming appeal. Returns an error string, or null. */
export function validateAppeal(body: Record<string, unknown>): string | null {
  if (typeof body.grade_report_id !== "string" || !body.grade_report_id.trim()) {
    return "grade_report_id is required.";
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 20) {
    // A one-word appeal cannot be adjudicated, and asking for substance up front
    // is cheaper than a round trip after someone has already been flagged.
    return "Please describe why the assessment is wrong (at least 20 characters).";
  }
  return null;
}

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
 * Hide the verdict while an appeal is open. Pure + exported.
 *
 * DECIDED 2026-07-19 (vault/60-decisions/adr-authenticity-open-questions.md §1b):
 * we stop publishing a claim we are actively reconsidering. The alternative —
 * showing "under review" — tells a buyer there is doubt, which can harm the
 * seller more than the original flag did.
 *
 * Implemented by clearing the same publicly-projected fields a withdrawal
 * clears, stashing the originals under `appeal_hidden_original`. That makes the
 * transition REVERSIBLE: a rejected appeal restores exactly what was there, so
 * hiding is not a quiet way to lose a verdict.
 *
 * The certificate must be RESEALED after this — integrity v4 covers the verdict,
 * so the hash has to track what is actually displayed.
 */
export function hideAssessmentForAppeal(
  assessment: Record<string, unknown> | null,
  nowIso: string,
): Record<string, unknown> | null {
  if (!assessment) return null;
  // Already hidden — do not stash a stash, which would make the original
  // unrecoverable on a second appeal.
  if (assessment.appeal_hidden_original) return assessment;
  return {
    ...assessment,
    verdict: null,
    verdict_confidence: null,
    authenticity_confidence: null,
    counterfeit_risk: null,
    summary: null,
    under_appeal: true,
    appeal_opened_at: nowIso,
    appeal_hidden_original: { ...assessment },
  };
}

/**
 * Restore the verdict after a REJECTED appeal. Pure + exported.
 *
 * Returns the assessment exactly as it was before hiding. A rejected appeal is
 * not a finding about the item — the reviewer found the appeal unpersuasive —
 * so nothing about the original assessment should change.
 */
export function restoreAssessmentAfterAppeal(
  assessment: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!assessment) return null;
  const stashed = assessment.appeal_hidden_original as Record<string, unknown> | undefined;
  if (!stashed) return assessment;
  return { ...stashed };
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

/**
 * How many open authenticity appeals one seller may hold at once.
 *
 * Hiding the verdict while an appeal is open is what makes a rate limit
 * necessary: without one, filing an appeal per item is a way to suppress every
 * verdict indefinitely at no cost. Deliberately generous — this is a brake on
 * abuse, not a barrier to a seller with several genuinely-misjudged items.
 */
export const MAX_OPEN_APPEALS_PER_SELLER = 5;

/** Can this seller open another appeal? Pure + exported. */
export function canOpenAppeal(openCount: number): { ok: true } | { ok: false; reason: string } {
  if (openCount >= MAX_OPEN_APPEALS_PER_SELLER) {
    return {
      ok: false,
      reason:
        `You already have ${openCount} authenticity appeals open. ` +
        `We'll review those first — the limit is ${MAX_OPEN_APPEALS_PER_SELLER} at a time.`,
    };
  }
  return { ok: true };
}

/**
 * Reseal a certificate after its authenticity verdict changed (hidden,
 * restored, or withdrawn).
 *
 * Integrity v4 seals the verdict, so ANY change to it without a reseal leaves a
 * hash computed over something the certificate no longer displays — and
 * verification then fails on precisely the certificate we just corrected. This
 * exists so no caller has to remember that.
 *
 * Reads the row back rather than taking fields from the caller: the reseal must
 * canonicalize over what is actually stored, and a caller assembling the fields
 * by hand is how the six seal sites drift apart.
 *
 * Returns the columns to merge into the update, or null when the row has no
 * certificate (nothing to seal) or is unreadable — never throws, because a
 * failed reseal must not lose the appeal that triggered it.
 */
export async function resealAfterAuthenticityChange(
  gradeReportId: string,
  // The assessment AS IT WILL BE after this change — not as it currently is.
  // Callers reseal in the same round-trip as the update, so reading the stored
  // value here would hash the verdict being replaced and write a signature that
  // verifies against nothing. Passing it explicitly makes that impossible.
  nextAssessment: { verdict?: string | null; verdict_confidence?: number | null } | null,
): Promise<Record<string, unknown> | null> {
  try {
    const { supabaseAdmin } = await import("./supabase.ts");
    const { buildCertIntegrity } = await import("./cert-integrity.ts");

    const { data } = await supabaseAdmin
      .from("grade_reports")
      .select(
        "certificate_id, overall_score, grade_tier, fabric_condition_score, " +
          "structural_integrity_score, cosmetic_appearance_score, " +
          "functional_elements_score, odor_cleanliness_score, ai_summary, " +
          "buyer_writeup, coverage",
      )
      .eq("id", gradeReportId)
      .maybeSingle();
    const r = data as Record<string, unknown> | null;
    if (!r || !r.certificate_id) return null;

    const coverage = r.coverage as
      | { coverage_pct?: number | null; covered_zones?: string[] | null }
      | null;
    const integrity = await buildCertIntegrity({
      certificate_id: String(r.certificate_id),
      overall_score: r.overall_score as number,
      grade_tier: String(r.grade_tier),
      fabric_condition_score: r.fabric_condition_score as number,
      structural_integrity_score: r.structural_integrity_score as number,
      cosmetic_appearance_score: r.cosmetic_appearance_score as number,
      functional_elements_score: r.functional_elements_score as number,
      odor_cleanliness_score: r.odor_cleanliness_score as number,
      ai_summary: (r.ai_summary as string) ?? "",
      buyer_writeup: (r.buyer_writeup as string | null) ?? null,
      coverage_pct: coverage?.coverage_pct ?? null,
      covered_zones: coverage?.covered_zones ?? null,
      authenticity_verdict: nextAssessment?.verdict ?? null,
      authenticity_verdict_confidence: nextAssessment?.verdict_confidence ?? null,
    });

    return {
      content_hash: integrity.content_hash,
      content_signature: integrity.content_signature,
      integrity_version: integrity.integrity_version,
    };
  } catch {
    return null;
  }
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

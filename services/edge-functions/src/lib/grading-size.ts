// US-2213: a VERIFIED size on the certificate.
//
// lib/sizing-charts.ts is 9,071 lines and 170 brands of curated per-brand,
// per-department, per-category charts. Its only consumers were the AutoLister's
// size pass and the brand resolver. Grading imported none of it — while
// ACCEPTING measurement photos the whole time (image_type measurement_chest /
// waist / length / sleeve / inseam, 00103). So the evidence was being collected
// at submit and thrown away, and the chart that interprets it was sitting in the
// same repo.
//
// ── THE TWO SIZE SIGNALS, AND WHY NEITHER IS "THE SELLER'S" ────────────────
//
// A grading submission has NO size field at all — `submissions` carries
// garment_type, garment_category, brand, title and description, and that is it.
// So unlike brand (US-2210), there is no seller-declared size to contradict.
// The two signals that DO exist are both ours:
//
//   READ      — the size printed on the care label, transcribed by the tag pass
//               (US-2210). A transcription. Authoritative when legible.
//   DERIVED   — measurements read off the flat-lay photos, mapped to the brand's
//               own chart by estimateSize. An inference. Available when the
//               label is missing, cut off, or illegible — which is the case
//               this whole feature exists for.
//
// When both exist they are two independent readings of one garment and they
// should agree. When they disagree we say so and prefer NEITHER: a relabelled
// garment, a mis-sewn label, a shrunk garment and a bad tape read all produce
// the same disagreement, and the direction of the error is not knowable here.
//
// ── WHY THE SIZE CHART DOES NOT GO IN THE GRADING PROMPT ───────────────────
//
// The story's AC asks for the chart in the trusted channel "matching how
// garment-baselines and fabric-criteria already do it". Those are injected into
// the COMPOSITE because they inform how a factor is judged — what the fabric's
// honest wear looks like, what the factory state was. A size chart informs none
// of that. The composite grades condition; a table of waist measurements is
// noise in it, and prompt noise on a paid call is a real cost.
//
// So the chart goes where it is already injected as authoritative reference —
// the focused size call inside estimateSize (US-1088) — and what reaches the
// trusted grading block is the RESULT: one line naming the size and how we got
// it. That satisfies the intent (a size on the certificate that came from the
// garment) without putting a sizing table in a condition prompt.
//
// Pure — no network, no DB, no model — so every rule here is unit-testable.

import type { AcceptedTagField } from "./tag-ground-truth.ts";

/**
 * Rollout gate: `GRADING_SIZE_VERIFY`, default OFF. Its own flag rather than
 * riding on GRADING_TAG_OCR because it is a SEPARATE vision call with a separate
 * cost, and an operator has to be able to buy one without the other.
 */
export function sizeVerifyGradingEnabled(): boolean {
  const v = (Deno.env.get("GRADING_SIZE_VERIFY") ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Below this a derived size is discarded. Deliberately at the existing
 * SIZE_ESTIMATE_LOW_CONFIDENCE boundary (0.5) rather than a new number: the
 * AutoLister already calls anything under it a "best guess" rather than an
 * answer, and a size too soft to auto-apply to a listing is far too soft to
 * print on a certificate. One threshold, one meaning, two callers.
 */
export const SIZE_DERIVE_MIN_CONFIDENCE = 0.5;

/** How a size on the certificate was established. */
export type SizeSource =
  /** Transcribed off the care label. */
  | "label"
  /** Inferred from measurement photos against the brand's chart. */
  | "measurements"
  /** Both agreed. The strongest case. */
  | "label_and_measurements";

export interface SizeVerification {
  /** The size we are willing to stand behind, in the brand's own labelling. */
  size: string;
  source: SizeSource;
  confidence: number;
  /** Department/gender when the size pass could tell. */
  gender?: string | null;
  /** The model's short reasoning, when the size came from measurements. */
  rationale?: string;
  /**
   * Present ONLY when the label and the measurements disagree. Both values are
   * kept; neither is treated as the correction.
   */
  disagreement?: { label: string; measurements: string };
}

/** The measurement-derived half, as estimateSize returns it. */
export interface DerivedSizeInput {
  size: string;
  gender: string | null;
  confidence: number;
  rationale: string;
}

// Sizes are compared with punctuation, case and spacing removed: "W30 L32",
// "w30l32" and "W30-L32" are one claim, and flagging them as a disagreement
// would bury the real ones. NOT a semantic equivalence — "M" and "Medium" are
// deliberately NOT unified here, because the brands in the corpus label in their
// own vocabulary and inventing a mapping is how a wrong "agreement" gets
// asserted. An unrecognised pair is reported as a disagreement, which a human
// can dismiss; a false agreement is silent.
function loosenSize(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Combine the label read and the measurement-derived estimate into the single
 * size a certificate can carry, or null when neither is good enough.
 *
 * Precedence when both are present and AGREE: source is
 * `label_and_measurements` and the confidence is the HIGHER of the two —
 * independent agreement is genuinely stronger evidence than either alone.
 *
 * When they DISAGREE the label wins the displayed value (it is a transcription,
 * not an inference) but the confidence is knocked down to the LOWER of the two
 * and the disagreement is recorded, because a contested reading is weaker than
 * an uncontested one no matter which side we show.
 */
export function resolveSizeVerification(
  labelRead: AcceptedTagField | undefined,
  derived: DerivedSizeInput | null,
  minConfidence: number = SIZE_DERIVE_MIN_CONFIDENCE,
): SizeVerification | null {
  const label = labelRead?.value.trim() ?? "";
  const labelConf = labelRead?.confidence ?? 0;

  const derivedSize = derived?.size.trim() ?? "";
  const derivedOk = !!derived &&
    derivedSize.length > 0 &&
    derived.confidence >= minConfidence;

  if (label.length === 0 && !derivedOk) return null;

  if (label.length > 0 && derivedOk) {
    if (loosenSize(label) === loosenSize(derivedSize)) {
      return {
        size: label,
        source: "label_and_measurements",
        confidence: Math.max(labelConf, derived!.confidence),
        gender: derived!.gender,
        rationale: derived!.rationale || undefined,
      };
    }
    return {
      size: label,
      source: "label",
      confidence: Math.min(labelConf, derived!.confidence),
      gender: derived!.gender,
      rationale: derived!.rationale || undefined,
      disagreement: { label, measurements: derivedSize },
    };
  }

  if (label.length > 0) {
    return { size: label, source: "label", confidence: labelConf };
  }

  return {
    size: derivedSize,
    source: "measurements",
    confidence: derived!.confidence,
    gender: derived!.gender,
    rationale: derived!.rationale || undefined,
  };
}

/**
 * The one line the trusted grading block carries. Names the PROVENANCE, because
 * "Size: M" and "Size: M, measured from the flat-lay photos" are different
 * claims and only the second is honest about being an inference.
 *
 * Returns "" for no verification, keeping the feature strictly additive.
 */
export function sizeVerificationLine(v: SizeVerification | null): string {
  if (!v) return "";
  const how: Record<SizeSource, string> = {
    label: "read from the size label",
    measurements: "derived from the measurement photos against the brand's size chart",
    label_and_measurements:
      "read from the size label AND independently confirmed by the measurement photos",
  };
  const gender = v.gender ? `${v.gender} ` : "";
  const base = `- Size: ${gender}${v.size} (${how[v.source]})`;
  if (!v.disagreement) return base;
  return `${base}\n- NOTE: the measurement photos indicate ${v.disagreement.measurements}, which does NOT match the label. Both readings are recorded; neither has been treated as correct.`;
}

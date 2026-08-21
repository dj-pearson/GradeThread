// US-2567: what goes into a condition-evidence pack, and what gets left out.
//
// The pack is the returns-defense artifact for one graded garment: the annotated
// full shots, a zoomed crop of each localized flaw, and a certificate card that
// makes the set self-describing when the images are viewed out of order (which,
// on a marketplace dispute form, they always are).
//
// PURE ON PURPOSE, like lib/derived-photo-provenance.ts. The selection rules —
// which defects earn a crop, how many, how far to expand a box before cropping —
// are the part worth being certain about, and none of them need a database or a
// JPEG decoder to decide.

import type { ImageAnnotations, PhotoAnnotation } from "./disclosure.ts";

/**
 * How many per-defect crops one item may produce.
 *
 * The model can find thirty issues on a heavily worn garment, and thirty extra
 * uploads per item is a storage and listing-payload problem long before it is a
 * useful disclosure — eBay caps a listing at 24 images in total, so a pack that
 * fills it leaves no room for the seller's own photography.
 *
 * Six is chosen against that ceiling, not as a round number: front/back/tag plus
 * the annotated shots plus a certificate card already spend most of the budget.
 * Operator-tunable because the right answer depends on the marketplace.
 */
export const DEFAULT_MAX_DEFECT_CROPS = 6;

export function maxDefectCrops(): number {
  const raw = Number(Deno.env.get("EVIDENCE_MAX_DEFECT_CROPS"));
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : DEFAULT_MAX_DEFECT_CROPS;
}

/** How much context to keep around a defect box, as a fraction of its size. */
export const CROP_MARGIN = 0.6;

/**
 * The smallest fraction of the frame a crop may cover.
 *
 * A pinhole's bbox can be a few pixels wide. Cropped tight and upscaled it is an
 * abstract blur that proves nothing, and a disclosure image nobody can read is
 * worse than no image — it invites the argument it was meant to end. This floors
 * the crop so there is always recognisable garment around the flaw.
 */
export const MIN_CROP_SPAN = 0.18;

export interface DefectCropTarget {
  /** Which source image this crop comes from (front / back / detail_1 / …). */
  imageType: string;
  /** The annotation, carrying its callout number, severity and box. */
  annotation: PhotoAnnotation;
  /** Normalized [x, y, w, h] actually cropped — expanded and clamped. */
  cropBox: [number, number, number, number];
}

export interface DefectCropSelection {
  crops: DefectCropTarget[];
  /** How many localized defects were dropped by the cap. Zero when none were. */
  truncated: number;
}

const SEVERITY_RANK: Record<string, number> = { major: 0, moderate: 1, minor: 2 };

/**
 * Expand a defect box by `margin` on every side and clamp it inside the frame,
 * then grow it to at least MIN_CROP_SPAN so the result is legible.
 *
 * Clamping happens AFTER the floor, not before, so a defect at the very edge of
 * a photo still yields a full-size crop — it slides inward rather than coming
 * back as a thin strip. A box hard against the left edge that merely clamped
 * would lose half its context precisely where the flaw is.
 */
export function expandCropBox(
  bbox: readonly [number, number, number, number],
  margin: number = CROP_MARGIN,
  minSpan: number = MIN_CROP_SPAN,
): [number, number, number, number] {
  const [bx, by, bw, bh] = bbox;
  // A degenerate or inverted box from the model must not produce a negative
  // span; treat it as a point and let the floor below give it a readable size.
  const w0 = Math.max(0, bw);
  const h0 = Math.max(0, bh);
  const cx = bx + w0 / 2;
  const cy = by + h0 / 2;

  let w = Math.max(w0 * (1 + margin * 2), minSpan);
  let h = Math.max(h0 * (1 + margin * 2), minSpan);
  w = Math.min(w, 1);
  h = Math.min(h, 1);

  const x = Math.min(Math.max(cx - w / 2, 0), 1 - w);
  const y = Math.min(Math.max(cy - h / 2, 0), 1 - h);
  return [x, y, w, h];
}

/**
 * Which localized defects earn their own crop, worst-first, bounded.
 *
 * Only defects the grader could LOCALIZE are eligible: without a bbox there is
 * no region to zoom to, and inventing one would put a callout box over a part of
 * the garment nobody claimed was damaged. Those defects still appear in the
 * annotated full shot's legend, which is the honest place for them.
 *
 * `groups` has already been filtered by selectAnnotatableImages, so the private
 * grading `label` shot is gone before this sees it (US-276 forbids label imagery
 * in the public bucket) and intentional design features were dropped upstream by
 * buildImageAnnotations.
 *
 * Worst-first so that when the cap bites, what survives is what a buyer would
 * have complained about.
 */
export function selectDefectCrops(
  groups: readonly ImageAnnotations[],
  cap: number = DEFAULT_MAX_DEFECT_CROPS,
): DefectCropSelection {
  const eligible: DefectCropTarget[] = [];
  for (const group of groups) {
    for (const annotation of group.annotations) {
      if (!annotation.bbox) continue;
      eligible.push({
        imageType: group.image_type,
        annotation,
        cropBox: expandCropBox(annotation.bbox),
      });
    }
  }

  eligible.sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[a.annotation.severity] ?? 3) -
      (SEVERITY_RANK[b.annotation.severity] ?? 3);
    // Callout number as the tiebreak, so the order is deterministic across runs
    // and a resumed batch renders the same set it started with.
    return bySeverity !== 0 ? bySeverity : a.annotation.n - b.annotation.n;
  });

  const limit = Math.max(0, cap);
  return {
    crops: eligible.slice(0, limit),
    truncated: Math.max(0, eligible.length - limit),
  };
}

/** The certificate facts stamped onto every asset in a pack. */
export interface EvidenceStamp {
  certificateNumber: string | null;
  overallScore: number;
  gradeTier: string;
}

/**
 * The one-line provenance stamp burned into every asset's legend.
 *
 * An evidence image that cannot name its own certificate is just a picture: the
 * whole argument in a dispute is "this flaw was documented and published under a
 * verifiable grade before you bought it", and that argument needs the number on
 * the image itself, because that is what gets screenshotted and pasted into a
 * claim form.
 *
 * Returns null when there is no certificate number — an uncertified grade must
 * not print a stamp implying one exists.
 */
export function evidenceStampLine(stamp: EvidenceStamp): string | null {
  if (!stamp.certificateNumber) return null;
  const score = Number.isFinite(stamp.overallScore)
    ? stamp.overallScore.toFixed(1)
    : "—";
  const tier = (stamp.gradeTier ?? "").trim();
  const parts = [stamp.certificateNumber, `${score} / 10`];
  if (tier) parts.push(tier);
  return `${parts.join("  ·  ")}  ·  gradethread.com/verify`;
}

/** The lines a certificate card renders, in order. */
export interface CertificateCardCopy {
  heading: string;
  score: string;
  tier: string;
  defects: string;
  certificate: string;
  verify: string;
}

/**
 * The certificate card's copy.
 *
 * Separated from the drawing so the wording is testable and so the web preview
 * and the shipped image cannot drift — the card is the only asset in the pack
 * with no photograph on it, which makes its text the entire artifact.
 */
export function certificateCardCopy(
  stamp: EvidenceStamp,
  defectCount: number,
): CertificateCardCopy {
  const score = Number.isFinite(stamp.overallScore)
    ? stamp.overallScore.toFixed(1)
    : "—";
  return {
    heading: "Condition report",
    score: `${score} / 10`,
    tier: (stamp.gradeTier ?? "").trim() || "Graded",
    // Plain counting, not a category. "3 flaws documented" is checkable against
    // the rest of the pack; "some wear" is not.
    defects: defectCount === 0
      ? "No flaws documented"
      : `${defectCount} flaw${defectCount === 1 ? "" : "s"} documented`,
    certificate: stamp.certificateNumber ?? "Not certified",
    verify: "gradethread.com/verify",
  };
}

/**
 * US-2706: the copy for the sheet that goes to an eBay RETURN case.
 *
 * A sibling of certificateCardCopy rather than a flag on it, because the two
 * differ on the one line that matters and merging them would put an off-eBay
 * URL in front of a marketplace reviewing a case.
 *
 * TWO DIFFERENCES, both required by the story:
 *
 *   THE GRADE DATE. The whole argument is that the flaw was documented BEFORE
 *   the sale. A card that names the certificate and not the date asserts the
 *   documentation exists without saying it predates anything, which is the half
 *   that carries no weight.
 *
 *   NO URL. certificateCardCopy prints "gradethread.com/verify", which is
 *   correct on a listing image and wrong here: eBay is deciding a case, and a
 *   domain on the evidence is an off-site link into the middle of it. The
 *   instruction survives without the address - a certificate number IS the
 *   lookup, and anyone holding it can find it.
 *
 * It also says nothing about who should win. eBay decides.
 */
export function returnEvidenceCardCopy(
  stamp: EvidenceStamp,
  defectCount: number,
  gradedAtIso: string | null,
): CertificateCardCopy {
  const base = certificateCardCopy(stamp, defectCount);
  return {
    ...base,
    heading: "Condition documented before sale",
    verify: gradedAtIso
      ? `Graded ${formatGradeDate(gradedAtIso)} · verify by certificate number`
      : "Verify by certificate number",
  };
}

/** YYYY-MM-DD, in UTC. Unambiguous to a reviewer in any country. */
function formatGradeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date unavailable";
  return d.toISOString().slice(0, 10);
}

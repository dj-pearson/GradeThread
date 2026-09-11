// US-3333: when a MeasureCard is in a flaw photo, size the flaw from the card
// instead of a guess.
//
// Flaw size decides severity, and the vision model estimates it from garment
// proportions. The edge already finds the MeasureCard's four ArUco markers and
// fits a homography from image pixels to card-plane INCHES (measure-detect.ts,
// US-1570/US-2627). The same fit on a defect or detail photo turns a flaw's
// bbox into millimetres, and the millimetres into the published size bucket.
// Deterministic, and no extra vision call.
//
// Rules, in the order they bite:
//   - Off unless GRADING_CARD_SIZING is on. A bucket change moves the defect
//     weighting and therefore the grade, so it ships dark like every other
//     grade-moving change, and turns on as a decision.
//   - The card must calibrate cleanly: all four markers, and a reprojection
//     residual under CARD_SIZING_MAX_REPROJ_IN, tighter than the 0.06in the
//     measuring flow accepts, because here a wrong scale moves a grade.
//   - No card, a failed fit, an undecodable image: the analysis comes back
//     UNCHANGED. Nothing is inferred from an absence.
//   - "extensive" (a flaw that dominates a panel) is about coverage, not a
//     length, so a card reading of "large" never downgrades it.
//
// The flaw is assumed to lie on the card's plane, which is how a flat-lay
// defect shot is taken; a card propped at an angle fails the residual gate.

import { Image } from "imagescript";
import type { DetectedIssue, PerImageAnalysis } from "./ai-grading.ts";
import type { SizeBucket } from "./defect-weighting.ts";
import { calibrateAdaptive, rescaleCalibration } from "./measure-calibrate.ts";
import { MEASURE_CARD_VERSIONS } from "./measure-card.ts";
import { applyHomography, type CalibrateResult } from "./measure-detect.ts";

/**
 * A flaw sized from the card. Persisted inside grade_reports.per_image_analysis
 * (internal; the public view projects only issue/severity/location/bbox), so
 * a reviewer can see which sizes were measured rather than estimated.
 */
export type CardSizedIssue = DetectedIssue & {
  size_mm?: number;
  size_source?: "card";
};

export const CARD_SIZING_MAX_REPROJ_IN = 0.03;
export const CARD_SIZING_MIN_MARKERS = 4;
export const MM_PER_INCH = 25.4;

export function cardSizingEnabled(): boolean {
  const v = (Deno.env.get("GRADING_CARD_SIZING") ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** The published buckets: pinhole <3, small 3-13, medium 13-50, large >50 mm. */
export function bucketForMm(mm: number, claimed?: SizeBucket | null): SizeBucket {
  if (mm < 3) return "pinhole";
  if (mm < 13) return "small";
  if (mm <= 50) return "medium";
  // Coverage, not length: never downgrade a panel-dominating call to "large".
  return claimed === "extensive" ? "extensive" : "large";
}

/** A calibration this module will size from, in ORIGINAL image pixels. */
export interface CardFit {
  /** Row-major 3x3, image px -> card-plane inches. */
  homography: number[];
  width: number;
  height: number;
}

/** True when a detector result is clean enough to move a grade. */
export function fitIsTrustworthy(res: CalibrateResult): boolean {
  return res.ok &&
    res.quality.markersFound >= CARD_SIZING_MIN_MARKERS &&
    Number.isFinite(res.quality.reprojResidualIn) &&
    res.quality.reprojResidualIn <= CARD_SIZING_MAX_REPROJ_IN;
}

/**
 * The longest side of a normalized bbox [x, y, w, h], in millimetres on the
 * card plane. Each side is the mean of its two opposite edges after projection,
 * so a perspective tilt the homography corrects does not inflate one edge.
 */
export function bboxLongestSideMm(
  bbox: readonly [number, number, number, number],
  fit: CardFit,
): number | null {
  const [x, y, w, h] = bbox;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const px = (u: number, v: number) =>
    applyHomography(fit.homography, u * fit.width, v * fit.height);
  const tl = px(x, y), tr = px(x + w, y), br = px(x + w, y + h), bl = px(x, y + h);
  const d = (a: [number, number], b: [number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);
  const across = (d(tl, tr) + d(bl, br)) / 2;
  const down = (d(tl, bl) + d(tr, br)) / 2;
  const inches = Math.max(across, down);
  return Number.isFinite(inches) ? inches * MM_PER_INCH : null;
}

/**
 * Re-size every genuine, localized flaw in one analysis from the card. Pure.
 * Issues without a bbox, and intentional features, are left exactly as they
 * were; so is everything when there is no fit.
 */
export function applyCardSizing(
  analysis: PerImageAnalysis,
  fit: CardFit | null,
): PerImageAnalysis {
  if (!fit) return analysis;
  let changed = false;
  const issues: DetectedIssue[] = analysis.detected_issues.map((issue) => {
    if (issue.is_intentional || !issue.bbox) return issue;
    const mm = bboxLongestSideMm(issue.bbox, fit);
    if (mm === null) return issue;
    changed = true;
    const sized: CardSizedIssue = {
      ...issue,
      size_bucket: bucketForMm(mm, issue.size_bucket ?? null),
      size_mm: Math.round(mm * 10) / 10,
      size_source: "card" as const,
      // The card is a measurement, not an estimate.
      size_confidence: 1,
    };
    return sized;
  });
  return changed ? { ...analysis, detected_issues: issues } : analysis;
}

/** Only flaw-bearing close-ups are worth a decode. */
export function wantsCardSizing(analysis: PerImageAnalysis): boolean {
  const t = analysis.image_type;
  if (!(t === "defect" || t.startsWith("defect") || t.startsWith("detail"))) return false;
  return analysis.detected_issues.some((i) => !i.is_intentional && !!i.bbox);
}

/**
 * Find and fit the MeasureCard in one image. Null when there is no card, the
 * fit is not trustworthy, or the image will not decode. Never throws.
 * `evidenceOnly`: a defect photo is not tagged as the card, so the resolution
 * ladder stops at the cheap rung when no marker is seen at all.
 */
export async function fitCardInImage(dataUri: string): Promise<CardFit | null> {
  try {
    const comma = dataUri.indexOf(",");
    if (comma < 0) return null;
    const bytes = Uint8Array.from(atob(dataUri.slice(comma + 1)), (c) => c.charCodeAt(0));
    const img = (await Image.decode(bytes)) as Image;
    const { result, scale } = calibrateAdaptive(img, MEASURE_CARD_VERSIONS, {
      evidenceOnly: true,
    });
    if (!result.ok || !fitIsTrustworthy(result)) return null;
    const rescaled = rescaleCalibration(result, scale);
    return { homography: rescaled.homography, width: img.width, height: img.height };
  } catch {
    return null;
  }
}

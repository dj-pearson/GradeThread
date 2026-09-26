// US-3528: stop paying for grades that are refunded.
//
// A submission whose photos fail the quality gate is refunded, but only AFTER
// every per-photo vision call has run (grading-pipeline.ts image-quality
// gate). So a seller holding one credit could resubmit bad photos over and
// over at no cost to them and about $0.10 a time to us. Three guards, all
// before any charge:
//
//   1. refundedGradeCap: at most GRADING_MAX_REFUNDED_PER_DAY (default 5)
//      refunded submissions per owner in 24 hours, then 429.
//   2. GRADING_MIN_IMAGE_EDGE (default 800): the longest side of a grading
//      photo. Smaller photos cost a vision call and cannot show condition.
//   3. exposureVerdict: a core photo (front, back, label) that is essentially
//      black or blown out is refused with a retake message. The thresholds are
//      deliberately extreme so a black tee on a dark background still passes;
//      they catch a lens cap or a flash into a mirror, not a moody photo.

import { supabaseAdmin } from "./supabase.ts";

function envNum(name: string, fallback: number): number {
  const raw = Number(Deno.env.get(name));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function maxRefundedPerDay(): number {
  return Math.trunc(envNum("GRADING_MAX_REFUNDED_PER_DAY", 5));
}

export function gradingMinImageEdge(): number {
  return Math.trunc(envNum("GRADING_MIN_IMAGE_EDGE", 800));
}

/** Pure: is this owner over the refunded-grade cap? 0 disables the cap. */
export function overRefundCap(
  refundedLast24h: number,
  cap = maxRefundedPerDay(),
): boolean {
  return cap > 0 && refundedLast24h >= cap;
}

export const REFUND_CAP_MESSAGE =
  "Too many grades were refunded for unusable photos in the last 24 hours. " +
  "Retake the photos in good light, then try again tomorrow.";

/**
 * True when the owner has hit the cap. A read failure answers false: this is a
 * cost guard, and refusing a paying customer because a count failed is worse
 * than one more refunded grade.
 */
export async function refundedGradeCapReached(
  ownerId: string,
  now = Date.now(),
): Promise<boolean> {
  const cap = maxRefundedPerDay();
  if (cap <= 0) return false;
  try {
    const { count, error } = await supabaseAdmin
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId)
      .gte("refunded_at", new Date(now - 24 * 60 * 60 * 1000).toISOString());
    if (error) return false;
    return overRefundCap(count ?? 0, cap);
  } catch {
    return false;
  }
}

/** Core slots the exposure check applies to. Detail shots may be macro-dark. */
export const EXPOSURE_CHECKED_TYPES = new Set(["front", "back", "label"]);
export const MIN_MEAN_LUMA = 12;
export const MAX_MEAN_LUMA = 248;

/** Pure: why a core photo's exposure is unusable, or null. */
export function exposureVerdict(
  imageType: string,
  meanLuma: number | null,
): string | null {
  if (meanLuma === null || !EXPOSURE_CHECKED_TYPES.has(imageType)) return null;
  if (meanLuma < MIN_MEAN_LUMA) {
    return `The ${imageType} photo is too dark to grade. Retake it in brighter light.`;
  }
  if (meanLuma > MAX_MEAN_LUMA) {
    return `The ${imageType} photo is washed out. Retake it without direct flash or glare.`;
  }
  return null;
}

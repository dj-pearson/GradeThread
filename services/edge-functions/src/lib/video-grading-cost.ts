// US-1765: video-grading cost control — the pure decisions.
//
// Grading from a clip is the same Vision work as grading from photos, but the
// COST SHAPE is different: the server chooses how many frames to look at, and
// every frame is a full Claude Vision call billed against ONE grade's revenue.
// So the three things that decide what a video grade may cost — how many frames,
// who may ask for one, and which ledger feature the calls land under — are
// gathered here as pure functions the route and the pipeline both call.
//
// They live in their own module (rather than inline in grade.ts) because each
// one is a number that decides profitability, and a number that decides
// profitability should be assertable without booting an HTTP route. The frame
// cap itself is `clampFrameCount` in video-frames.ts, next to the extractor it
// bounds.

/**
 * The ai_usage_events / ai_budgets / ai_feature_economics key for a grade
 * produced from a clip. One string, exported once: the metering write, the
 * budget lookup, the kill-switch flag and the admin dashboards must all agree on
 * it, and a typo in any one of them fails SILENTLY (spend lands under a feature
 * nothing watches).
 */
export const VIDEO_GRADING_FEATURE = "video_grading";

/** The ledger feature an ordinary photo grade meters under. */
export const PHOTO_GRADING_FEATURE = "grading";

/**
 * Which ai_usage_events.feature a finished grade's Vision calls are recorded
 * under.
 *
 * Video is NOT folded into 'grading'. A video grade is N frames' worth of Vision
 * calls against a single grade's revenue, so folding it in would average the
 * clip path's cost into the photo path's and hide the only number that decides
 * whether video grading pays for itself.
 *
 * Keyed on `video_graded` — set only once frames actually landed — never on the
 * seller's opt-in: a request that asked for video and fell back to photos is a
 * photo grade, and metering it as video would overstate the clip path's cost.
 */
export function gradingUsageFeature(videoGraded: boolean): string {
  return videoGraded ? VIDEO_GRADING_FEATURE : PHOTO_GRADING_FEATURE;
}

/**
 * Effective FlipDesk plans allowed to grade from a clip when the
 * `video_grading_plans` setting is missing or malformed. Paid plans only: the
 * frame count makes this the most expensive way to produce one grade, so it is a
 * plan capability rather than something every free account can spend.
 */
export const DEFAULT_VIDEO_GRADING_PLANS = ["starter", "pro", "business"];

/**
 * Read the operator's `video_grading_plans` setting into a usable allowlist.
 *
 * Falls back to the defaults on anything that is not a non-empty array of
 * strings — including an array that contains only junk. An empty allowlist would
 * silently disable the feature for EVERYONE, which is the kill-switch's job
 * (`feature_flags.video_grading`) and should never be reachable by fat-fingering
 * a settings row.
 */
export function resolveVideoGradingPlans(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULT_VIDEO_GRADING_PLANS;
  const plans = raw.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return plans.length > 0 ? plans : DEFAULT_VIDEO_GRADING_PLANS;
}

/** True when `effectivePlan` may grade from a clip under the given setting. */
export function videoGradingPlanAllowed(
  effectivePlan: string,
  rawSetting: unknown,
): boolean {
  return resolveVideoGradingPlans(rawSetting).includes(effectivePlan);
}

/**
 * Why a video-grading request that ALSO carries staged photos is refused.
 * Returns null when there is nothing wrong.
 *
 * Two independent reasons, either sufficient:
 *
 *  1. COST. Extracted frames are inserted as ordinary submission_images
 *     ALONGSIDE anything uploaded, and the pipeline makes one Vision call per
 *     image. Accepting both stacks the photo cap (14 slots) on top of the frame
 *     cap (8) for a single grade's revenue — the two caps compose, so neither
 *     one bounds the request. The photo path already refuses a repeated
 *     image_type for exactly this reason: cost must scale with garment coverage,
 *     not with what the caller chose to attach.
 *
 *  2. PROVENANCE. The Video-Verified badge claims every graded view came out of
 *     one continuous take. One hand-picked photo mixed into the graded set makes
 *     that claim false, and a badge that is sometimes false is worse than none.
 *
 * The web client already sends no photos in video mode and its comment says the
 * server refuses them; before this the server did not, so the client was the
 * only thing holding the cap. Anything posting the form directly bypassed it.
 */
export function videoPhotoConflict(uploadedPhotoCount: number): string | null {
  if (uploadedPhotoCount <= 0) return null;
  return "Video grading grades the clip's own frames, so extra photos can't be " +
    "included. Remove them, or switch to photo mode to grade from photos.";
}

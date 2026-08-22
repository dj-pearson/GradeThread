import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { clientIp } from "../middleware/rate-limit.ts";
import { getSettingSync } from "../lib/system-settings.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";
import {
  IN_APP_CAPTURE_SOURCE,
  parseVideoCaptureSource,
  VIDEO_FRAME_CAPTURE_SOURCE,
} from "../lib/verified-capture.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import { validateVideoUpload } from "../lib/video-validation.ts";
import {
  clampFrameCount,
  DEFAULT_MAX_VIDEO_FRAMES,
  extractVideoFrames,
  parseVideoSlotMarks,
  type VideoSlotMarks,
} from "../lib/video-frames.ts";
import {
  resolveVideoGradingAccess,
  VIDEO_GRADE_BUYER_METER,
  VIDEO_GRADING_FEATURE,
  videoGradingPlanAllowed,
  videoPhotoConflict,
} from "../lib/video-grading-cost.ts";
import { getBuyerEntitlements } from "../lib/buyer-entitlements.ts";
import { trackBuyerFeature } from "../lib/buyer-analytics.ts";
import {
  BUYER_METER_ALLOWANCE,
  type BuyerMeterSource,
  debitBuyerMeter,
  refundBuyerMeterSource,
} from "../lib/buyer-metering.ts";
import { computePhashFromImage } from "../lib/perceptual-hash.ts";
import {
  GRADE_TIERS,
  type GradeTier,
  TIER_CREDIT_COST,
  type PrecedenceResult,
  forensicAddonEnabled,
  runPaymentPrecedence,
  tierSupportsAuthenticityAddon,
} from "../lib/grade-billing.ts";
import { captureException, readCtxVar } from "../lib/observability.ts";
import {
  canOpenAppeal,
  hideAssessmentForAppeal,
  resealAfterAuthenticityChange,
  validateAppeal,
} from "../lib/authenticity-appeal.ts";
import { featureDisabledBody, isFeatureEnabled } from "../lib/feature-flags.ts";
import { aiBudgetExceededBody, isAiBudgetExhausted } from "../lib/ai-budget-gate.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import { classifyGarment, type GarmentClassification } from "../lib/ai-extract.ts";
import { valueAtGrade } from "../lib/condition-value.ts";
import { suggestCategories } from "../lib/ebay-client.ts";
import { effectivePlanFor } from "../lib/grade-pricing.ts";
import { refundReservedSnap } from "../lib/grade-refund.ts";

// US-614: free monthly Snap-to-Value cap per effective FlipDesk plan (-1 = unlimited).
const SNAP_CAP: Record<string, number> = {
  free: 15,
  starter: 60,
  pro: 200,
  business: -1,
};

type GradeEnv = {
  Variables: {
    userId: string;
    // Set by workspaceMiddleware. Equals userId for solo users / when the
    // caller is the workspace owner. For a member acting in someone else's
    // workspace, this is the OWNER's id — billing, plan caps, credits,
    // submissions, and storage paths all key off this so the work lands in
    // the right tenant.
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

const GARMENT_TYPES = ["tops", "bottoms", "outerwear", "dresses", "footwear", "accessories"] as const;
const GARMENT_CATEGORIES = [
  "t-shirt", "shirt", "blouse", "sweater", "hoodie",
  "jacket", "coat", "jeans", "pants", "shorts",
  "skirt", "dress", "sneakers", "boots", "sandals",
  "hat", "bag", "belt", "scarf", "neckwear", "gloves", "other",
] as const;
// Mirror of IMAGE_TYPES in src/lib/constants.ts (edge runs in a separate Deno
// project and can't import frontend code). label_2 = second tag shot,
// detail_2..4 = extra close-ups, measurement_* = flat tape-measure shots for
// size ID when there's no size tag.
const IMAGE_TYPES = [
  "front", "back", "label", "label_2",
  "detail", "detail_2", "detail_3", "detail_4",
  "defect",
  "measurement_chest", "measurement_waist", "measurement_length",
  "measurement_sleeve", "measurement_inseam",
] as const;
const REQUIRED_IMAGE_TYPES = ["front", "back", "label"];

// Hard ceiling on images accepted per submission. The grading pipeline issues
// one Claude Vision call PER image, but a submission is billed as a single
// grade — so an uncapped image count is a direct AI-cost multiplier (a caller
// could attach dozens of photos for the price of one grade). The cap matches
// the number of distinct IMAGE_TYPES slots; duplicate types are also rejected
// below so cost scales with garment coverage, not attacker choice. (HIGH-1)
const MAX_IMAGES_PER_SUBMISSION = IMAGE_TYPES.length;

// US-1763: optional walk-around video clip. Caps keep a single grade's storage
// + frame-extraction cost bounded — a short clip, not a movie. The bytes land in
// the same private submission bucket + owner folder as the photos.
const MAX_VIDEO_BYTES = 60 * 1024 * 1024; // 60 MB
const MAX_VIDEO_DURATION_SECONDS = 45;

// Optional seller-declared intentional design features. Passed to the grader
// as a hint so factory distressing isn't read as damage. Allowlist keeps the
// hint clean (free text would let sellers game the grade).
//
// ⚠ NO CLIENT SENDS THIS (US-2800). The line here claimed this list mirrored a
// constant of the same name in the web constants module. There is no such
// constant, and there never was. Nothing on web, iOS or Android appends
// `style_attributes` to the submission form, so this allowlist has only ever
// filtered an empty list.
// RetakeBridgeState carries a `styleAttributes` field and new-submission.tsx
// drops it, which is the closest anything comes.
//
// The parser is correct and is left alone: the moment a client offers the
// picker, this works. What is missing is the picker, not this.
//
// NOT to be confused with grade_reports.detected_style_attributes, which is the
// MODEL's own reading and is live — the certificate renders it. This constant
// is the SELLER's declaration, which is the half that was never wired.
const STYLE_ATTRIBUTES = [
  "distressed", "ripped", "raw-hem", "acid-wash", "bleached", "tie-dye",
  "cropped", "frayed", "patchwork", "painted", "vintage-wash", "garment-dyed",
  "deconstructed", "pre-pilled",
] as const;
type StyleAttribute = (typeof STYLE_ATTRIBUTES)[number];

// Parse style_attributes from the form. Accepts repeated fields or a single
// comma-separated value. Silently drops anything not on the allowlist.
function parseStyleAttributes(formData: FormData): string[] {
  const raw = formData.getAll("style_attributes");
  const flat: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    for (const part of entry.split(",")) {
      const v = part.trim().toLowerCase();
      if (v) flat.push(v);
    }
  }
  return [...new Set(flat)].filter((v): v is StyleAttribute =>
    (STYLE_ATTRIBUTES as readonly string[]).includes(v)
  );
}

type GarmentType = (typeof GARMENT_TYPES)[number];
type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];
type ImageType = (typeof IMAGE_TYPES)[number];

// US-339: original-image retention is OFF unless an operator opts in. When off,
// any `original_images` the client sends are ignored (defense-in-depth) so the
// fast compressed-upload path is the default and originals are never stored
// without an explicit config choice. EXIF capture below runs regardless.
const RETAIN_ORIGINAL_IMAGES =
  (Deno.env.get("RETAIN_ORIGINAL_IMAGES") ?? "").toLowerCase() === "true";

// Sanitize + bound the client-supplied EXIF blob (US-339). Never trust the
// client: keep only known fields, cap string lengths, and validate GPS ranges.
// Returns null when nothing usable remains (the common case).
function sanitizeExif(
  raw: FormDataEntryValue | undefined,
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const src = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const copyStr = (k: string) => {
    const v = src[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 256);
  };
  copyStr("make");
  copyStr("model");
  copyStr("software");
  copyStr("lensModel");
  copyStr("dateTime");
  copyStr("dateTimeOriginal");
  if (typeof src.orientation === "number" && Number.isFinite(src.orientation)) {
    const o = Math.trunc(src.orientation);
    if (o >= 1 && o <= 8) out.orientation = o;
  }
  const gps = src.gps;
  if (gps && typeof gps === "object" && !Array.isArray(gps)) {
    const lat = (gps as Record<string, unknown>).latitude;
    const lon = (gps as Record<string, unknown>).longitude;
    if (
      typeof lat === "number" && Number.isFinite(lat) && lat >= -90 &&
      lat <= 90 &&
      typeof lon === "number" && Number.isFinite(lon) && lon >= -180 &&
      lon <= 180
    ) {
      out.gps = { latitude: lat, longitude: lon };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const gradeRoutes = new Hono<GradeEnv>();

// Payment precedence (included → credits → checkout) now lives in
// lib/grade-billing.ts so the FlipDesk bridge and public API charge through
// the same path. See runPaymentPrecedence there.

function kickPipeline(submissionId: string, correlationId?: string) {
  // Status='processing' first; then fire-and-forget the grading pipeline.
  supabaseAdmin
    .from("submissions")
    .update({ status: "processing" })
    .eq("id", submissionId)
    .then(() => {
      processSubmission(submissionId).catch((err) => {
        // US-491/497: a crash in the un-awaited pipeline is otherwise invisible.
        // Report it to the tracker, correlated to the originating request, and
        // tag the submission so the stuck-submission reaper (US-495) can refund.
        captureException(err, {
          route: "grade.pipeline",
          correlationId,
          extra: { submissionId },
        });
        console.error(
          `[Grade] Pipeline error for ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    });
}

/**
 * US-1764: a video submission that produced no gradeable frames.
 *
 * Falls back to `needs_photos` — the SAME abstention the image-quality gate
 * (US-332) uses when photos are unusable — rather than grading a garment we
 * could not actually see. Crucially this returns BEFORE payment precedence runs,
 * so a failed extraction never consumes a credit or an included grade: the
 * submission is retakeable (US-949 treats needs_photos as a retake target) and
 * the seller can re-record or switch to photos at no cost.
 *
 * US-1841: the BUYER path is the exception to "payment hasn't run yet" — its
 * video-grade credit is debited at the gate, before the submission row exists,
 * because the quota answer has to come back before we do any work. So this
 * funnel — the ONE place a video grade gives up — hands that unit back to the
 * pocket it came from. Every failure return in the clip path goes through here,
 * which is why the refund lives here rather than at each call site.
 */
async function failVideoGrading(
  c: Context<GradeEnv>,
  submissionId: string,
  ownerId: string,
  reason: string,
  record: Record<string, unknown>,
  buyerDebit?: BuyerMeterSource | null,
) {
  // The debit was taken from the WORKSPACE OWNER (see the gate) because that is
  // who submissions.user_id names, and refund_grade — the other refund path —
  // can only reach that id. One payer identity, two refund paths that agree.
  if (buyerDebit) {
    await refundBuyerMeterSource(ownerId, VIDEO_GRADE_BUYER_METER, buyerDebit);
  }
  const { error } = await supabaseAdmin
    .from("submissions")
    .update({
      status: "needs_photos",
      video_graded: false,
      video_frames: { ...record, reason },
    })
    .eq("id", submissionId)
    .eq("user_id", ownerId);
  if (error) {
    console.error(`[video-grade] failed to mark ${submissionId} needs_photos:`, error);
  }
  return c.json({
    submissionId,
    status: "needs_photos",
    videoGrading: { ok: false, reason },
    photo_requests: [
      reason,
      "You can also switch to photo mode and upload front, back, label and detail shots.",
    ],
    payment: { paid: false, charged: false },
  }, 201);
}

// ── POST /submit ─────────────────────────────────────────────────
gradeRoutes.post("/submit", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;
  const role = c.get("workspaceRole") ?? "owner";

  // US-507: grading kill-switch — disable the (expensive, Anthropic-dependent)
  // pipeline during an outage/cost spike without a redeploy.
  // US-2406: pass the WORKSPACE OWNER — the billed party, whose plan every other
  // entitlement here reads — so a plan-targeted or partially-rolled-out rule is
  // actually applied instead of falling through.
  if (!(await isFeatureEnabled("grading", { userId: ownerId }))) {
    return c.json(featureDisabledBody("grading"), 503);
  }
  // Inline AI budget kill-switch: pause grading within seconds (not at the cron
  // interval) if the hard USD grading budget is breached. Checked BEFORE any
  // payment/credit reservation so an over-budget breach never charges the user.
  if (await isAiBudgetExhausted("grading")) {
    return c.json(aiBudgetExceededBody("grading"), 503);
  }

  // Member must have at least 'member' role in the workspace to submit a grade.
  // Owner/admin/listing_manager all qualify; viewer does not.
  if (role === "viewer") {
    return c.json(
      { error: "Viewers cannot submit grade requests in this workspace" },
      403,
    );
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data. Expected multipart/form-data." }, 400);
  }

  const garmentType = formData.get("garment_type") as string | null;
  const garmentCategory = formData.get("garment_category") as string | null;
  const title = formData.get("title") as string | null;
  const brand = formData.get("brand") as string | null;
  const description = formData.get("description") as string | null;
  const styleAttributes = parseStyleAttributes(formData);
  // US-340: the seller opted into the Verified Capture provenance path. This
  // flag alone earns nothing — the badge is only awarded if the server-side
  // checks in verified-capture.ts pass at grading time. Never lowers a grade.
  const liveCaptureOptIn =
    (formData.get("live_capture_opt_in") as string | null) === "true";
  // Live Capture builds ON Verified Capture: opting into the fraud-proof live
  // mode always opts into the underlying provenance path too.
  const verifiedCaptureOptIn = liveCaptureOptIn ||
    (formData.get("verified_capture_opt_in") as string | null) === "true";
  // US-1281: the seller opted into the premium Verified 360 capture path
  // (photogrammetric / LiDAR true-geometric coverage), only offered on capable
  // devices. The device reports its guided-capture metrics as a JSON blob; the
  // badge is only AWARDED if those metrics clear the server-side thresholds in
  // verified-360.ts at grading time. Never required; never lowers a grade.
  const verified360OptIn =
    (formData.get("verified_360_opt_in") as string | null) === "true";
  let capture360: Record<string, unknown> | null = null;
  if (verified360OptIn) {
    const raw = formData.get("capture_360") as string | null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          capture360 = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed metrics simply fail the badge check; never blocks the grade.
      }
    }
  }
  // US-1762: the seller wants this garment GRADED FROM the walk-around clip
  // rather than from staged photos. Distinct from merely attaching a clip
  // (US-1763), which is supplementary evidence. When honored, the server
  // extracts frames and writes them as ordinary submission_images, so the whole
  // per-image -> composite flow downstream runs unchanged.
  const videoGradingOptIn =
    (formData.get("video_grading") as string | null) === "true";
  // Optional guided-capture marks ("I'm showing the front now"). Never trusted:
  // parsed + bounded against the clip's real duration below.
  const videoSlotMarksRaw = formData.get("video_slot_marks") as string | null;
  // US-1766: how the clip entered the app — 'in_app_recorder' (recorded live in
  // GradeThread's own recorder) or 'library' (an existing file). Normalized to
  // one of the two known markers or null; an unrecognized string can never read
  // as live. Positive-only, exactly like every other provenance signal here.
  const videoCaptureSource = parseVideoCaptureSource(
    formData.get("video_capture_source"),
  );
  // US-601: premium authenticity / counterfeit-confidence add-on opt-in. Only
  // HONORED on a paid Premium/Express tier (the higher per-tier charge covers it)
  // and when the kill-switch flag is on — both enforced just below.
  const authenticityAddonOptIn =
    (formData.get("authenticity_addon") as string | null) === "true";
  // US-1296: Forensic Grade add-on opt-in. Enables the US-1035 high-resolution
  // defect-zoom re-analysis path (off by default to avoid eating its cost on
  // every grade). Only HONORED on a paid Premium/Express tier, when the
  // kill-switch flag is on, AND when originals are actually being retained
  // (US-339) — the zoom re-reads the uncompressed original. All enforced below.
  const forensicAddonOptIn =
    (formData.get("forensic_grade") as string | null) === "true";
  const tierRaw = (formData.get("tier") as string | null) ?? "standard";
  const tier: GradeTier = GRADE_TIERS.includes(tierRaw as GradeTier)
    ? (tierRaw as GradeTier)
    : "standard";
  // US-949: one-tap retake. When present, this new submission replaces a prior
  // needs_photos/expired one. The prior row is validated for ownership + a
  // retakeable status below, then marked superseded after this row is created.
  const retakeOf = (formData.get("retake_of") as string | null)?.trim() || null;
  // US-1282: re-grade of an existing Garment Passport. When present (and the
  // garment is owned by this workspace), the grade links to that garment and
  // appends to its condition history (the over-time curve) instead of minting a
  // new passport. Validated for ownership below (US-268); a foreign id is ignored
  // and the grade behaves as a fresh first grade.
  const regradeOf = (formData.get("regrade_of") as string | null)?.trim() || null;
  // US-1841: the buyer's closet item (US-1825) this grade was requested for. The
  // finished grade is written back onto it so the result lands where the buyer
  // asked for it rather than only in a submissions list. Ownership-verified
  // below (US-268); a foreign/forged id is ignored, not fatal.
  const closetItemOf = (formData.get("closet_item_id") as string | null)?.trim() || null;
  // US-2504: the seller’s inventory item this grade belongs to.
  //
  // The clip path had NO way to say which item it was grading - closet_item_id
  // is the BUYER’s portfolio, and the route that links to inventory
  // (/api/flipdesk/grading/submit) grades from photos already on the item and
  // takes no clip. So a walk-around grade produced a real certificate attached
  // to nothing, and the seller had to link it to their listing by hand.
  const inventoryItemOf =
    (formData.get("inventory_item_id") as string | null)?.trim() || null;

  const errors: string[] = [];
  if (!title || title.trim().length === 0) errors.push("title is required");
  if (!garmentType || !GARMENT_TYPES.includes(garmentType as GarmentType)) {
    errors.push(`garment_type must be one of: ${GARMENT_TYPES.join(", ")}`);
  }
  if (!garmentCategory || !GARMENT_CATEGORIES.includes(garmentCategory as GarmentCategory)) {
    errors.push(`garment_category must be one of: ${GARMENT_CATEGORIES.join(", ")}`);
  }
  if (!GRADE_TIERS.includes(tier)) {
    errors.push(`tier must be one of: ${GRADE_TIERS.join(", ")}`);
  }

  const imageFiles: File[] = [];
  const imageTypes: string[] = [];
  // US-480: the perceptual hash is recomputed server-side from the validated
  // upload bytes below (computePhashFromImage) — the client "phashes" field is
  // NO LONGER trusted for reuse detection, since a forged hash could otherwise
  // dodge a match against a stolen/stock photo already on file.
  // US-339: provenance EXIF per image, aligned to imageFiles by push order.
  const imageExif: (Record<string, unknown> | null)[] = [];
  // US-1283: per-image capture_source ('in_app_camera' = device-attested live
  // capture, else library/null), aligned to imageFiles by push order.
  const imageCaptureSource: (string | null)[] = [];
  // US-2136 AC4: per-image 0..1 macro sharpness, measured client-side on the
  // COMPRESSED bytes (macro-photo-quality.ts). Aligned to imageFiles by push
  // order, exactly like the arrays above. Null means "not measured" — an older
  // client, or a canvas that could not decode — and readers must treat that as
  // unknown rather than as zero.
  const imageQualityScore: (number | null)[] = [];
  const allEntries = formData.getAll("images");
  const allTypes = formData.getAll("image_types");
  const allExif = formData.getAll("exif_metadata");
  const allCaptureSources = formData.getAll("capture_sources");
  const allQualityScores = formData.getAll("quality_scores");
  // US-339: optional uncompressed originals, sent (in image order) only when
  // the client opted in. Consumed only if RETAIN_ORIGINAL_IMAGES is set.
  const allOriginals = formData.getAll("original_images");

  const seenTypes = new Set<string>();
  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    const type = allTypes[i] as string | undefined;
    if (entry instanceof File && entry.size > 0) {
      if (!type || !IMAGE_TYPES.includes(type as ImageType)) {
        errors.push(`image_types[${i}] must be one of: ${IMAGE_TYPES.join(", ")}`);
      } else if (seenTypes.has(type)) {
        // Reject duplicate slots: each image_type is graded once, so a repeated
        // type only multiplies vision-call cost without adding garment coverage.
        errors.push(`image_types[${i}] '${type}' is a duplicate; each image type may appear at most once`);
      } else if (imageFiles.length >= MAX_IMAGES_PER_SUBMISSION) {
        errors.push(`A submission may include at most ${MAX_IMAGES_PER_SUBMISSION} images`);
        break;
      } else {
        seenTypes.add(type);
        imageFiles.push(entry);
        imageTypes.push(type);
        imageExif.push(sanitizeExif(allExif[i]));
        const src = allCaptureSources[i];
        imageCaptureSource.push(
          typeof src === "string" && src.trim() ? src.trim() : null,
        );
        // Clamp rather than reject: the column carries a CHECK, and a client
        // bug that sends 1.4 should degrade to "as good as it gets" instead of
        // failing an otherwise-valid submission over a number nobody typed.
        const rawQuality = allQualityScores[i];
        const parsedQuality = typeof rawQuality === "string" && rawQuality.trim()
          ? Number(rawQuality)
          : Number.NaN;
        imageQualityScore.push(
          Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : null,
        );
      }
    }
  }

  // Originals must line up 1:1 with accepted images to be retained safely
  // (any mismatch means we'd store the wrong original against an image).
  const retainOriginals = RETAIN_ORIGINAL_IMAGES &&
    allOriginals.length === imageFiles.length;

  // US-1762: a video-graded submission supplies its coverage as extracted
  // FRAMES, so the photo-slot requirements are checked against the frames
  // instead (REQUIRED_VIDEO_FRAME_SLOTS is the same front/back/label/detail
  // bar, enforced in selectVideoFrames). Photos are refused outright in this
  // mode: mixing a hand-picked still into a "one continuous take" submission
  // would break exactly the claim the Video-Verified badge makes, and it would
  // push the Vision-call count past the frame cap the cost control depends on.
  if (videoGradingOptIn) {
    if (imageFiles.length > 0) {
      errors.push(
        "Video grading grades the clip's own frames — remove the photos, or switch to photo mode to use them",
      );
    }
  } else {
    for (const required of REQUIRED_IMAGE_TYPES) {
      if (!imageTypes.includes(required)) errors.push(`A '${required}' image is required`);
    }
    if (!imageTypes.some((t) => t.startsWith("detail"))) {
      errors.push("At least one 'detail' image is required");
    }
  }

  // US-1283: Live Capture accepts ONLY in-app camera images — a single
  // library/gallery upload defeats the un-fakeable guarantee, so reject the
  // submission rather than silently downgrade it at submit time. (The grade-time
  // evaluation in verified-capture.ts is the second, server-authoritative gate.)
  if (liveCaptureOptIn) {
    const notLive = imageCaptureSource.filter(
      (s) => (s ?? "").toLowerCase() !== IN_APP_CAPTURE_SOURCE,
    ).length;
    if (notLive > 0) {
      errors.push(
        "Live Capture requires every photo to be captured live in the app (no library uploads)",
      );
    }
  }

  // US-1763: optional walk-around video. Validate BEFORE creating the
  // submission so a bad/oversized/over-long clip is rejected as cheaply as a bad
  // image (magic-byte sniff, not the client MIME). Held in memory for the upload
  // step below once the submission row exists.
  let videoUpload:
    | { bytes: Uint8Array; contentType: string; ext: string; durationSeconds: number | null }
    | null = null;
  const videoEntry = formData.get("video");
  if (videoEntry instanceof File && videoEntry.size > 0) {
    const vBytes = new Uint8Array(await videoEntry.arrayBuffer());
    const vVerdict = validateVideoUpload(vBytes, {
      maxBytes: MAX_VIDEO_BYTES,
      maxDurationSeconds: MAX_VIDEO_DURATION_SECONDS,
    });
    if (!vVerdict.ok) {
      errors.push(`Invalid video: ${vVerdict.reason}`);
    } else {
      videoUpload = {
        bytes: vBytes,
        contentType: vVerdict.contentType,
        ext: vVerdict.ext,
        durationSeconds: vVerdict.durationSeconds,
      };
    }
  }
  // Grading FROM a clip needs a clip, and needs to know how long it is: the
  // frame plan samples by timestamp, so an unreadable duration means we cannot
  // choose where to look. Both are cheap to say NO to here, before a submission
  // row or a charge exists.
  if (videoGradingOptIn) {
    if (!videoUpload) {
      errors.push("Video grading needs a walk-around clip — attach one, or switch to photo mode");
    } else if (!videoUpload.durationSeconds || videoUpload.durationSeconds <= 0) {
      errors.push(
        "That clip's length could not be read, so it can't be graded. Re-record it, or switch to photo mode.",
      );
    }
    // US-1765: frames are inserted as ordinary submission_images ALONGSIDE any
    // uploaded photos, and the pipeline makes one Vision call per image — so
    // accepting both stacks the 14-slot photo cap on top of the 8-frame cap for
    // ONE grade's revenue and neither cap bounds the request. It also voids the
    // "every graded view came from one take" claim. Refused here, before a
    // submission row or a charge exists.
    const photoConflict = videoPhotoConflict(imageFiles.length);
    if (photoConflict) errors.push(photoConflict);
  }

  if (errors.length > 0) {
    return c.json({ error: "Validation failed", details: errors }, 400);
  }

  // ── US-1765: video-grading cost gates ──────────────────────────────────────
  // Ordered cheapest-to-most-consequential and ALL evaluated before a submission
  // row exists, so a gated request costs nothing and leaves nothing behind.
  let videoMaxFrames = DEFAULT_MAX_VIDEO_FRAMES;
  let videoSlotMarks: VideoSlotMarks = {};
  // US-1841: set when the BUYER's plan is paying for this clip grade — the pocket
  // that was debited, so a failure returns the unit to it and the pipeline can
  // record which one paid. Null on the seller path (ordinary grade precedence).
  let buyerVideoDebit: BuyerMeterSource | null = null;
  if (videoGradingOptIn) {
    // 1. Kill-switch (also what the monthly ai_budgets 'kill' action flips).
    if (!(await isFeatureEnabled(VIDEO_GRADING_FEATURE, { userId: ownerId }))) {
      return c.json(featureDisabledBody(VIDEO_GRADING_FEATURE), 503);
    }
    // 2. Hard AI budget. Frames are Vision calls, so a breached video budget
    //    must stop the clip path specifically — the photo path is unaffected.
    if (await isAiBudgetExhausted(VIDEO_GRADING_FEATURE)) {
      return c.json(aiBudgetExceededBody(VIDEO_GRADING_FEATURE), 429);
    }
    // 3. Plan gate. A free-plan seller gets the photo path and a clear upgrade
    //    prompt, never a silent downgrade into a worse grade.
    const { data: planRow } = await supabaseAdmin
      .from("users")
      .select("flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
      .eq("id", ownerId)
      .maybeSingle();
    const effPlan = effectivePlanFor(
      (planRow?.flipdesk_plan as string) ?? "free",
      (planRow?.subscription_status as string) ?? "none",
      (planRow?.trial_ends_at as string | null) ?? null,
      new Date(),
      (planRow?.past_due_since as string | null) ?? null,
    );
    //    US-1841: the buyer plan is the SECOND way in. Both paid buyer tiers
    //    include video-grade credits, so an account whose FlipDesk plan can't pay
    //    may still be entitled through the buyer product. Resolved only when the
    //    seller plan says no — a paid seller plan already covers the clip out of
    //    its bundle and must not also burn a buyer credit.
    const allowedPlansRaw = getSettingSync<unknown>("video_grading_plans", null);
    const sellerPlanAllowed = videoGradingPlanAllowed(effPlan, allowedPlansRaw);
    // Read against the WORKSPACE OWNER, like every other charge in this handler.
    // Not because entitlements aren't personal — they are — but because the
    // owner is who `submissions.user_id` names, and refund_grade (the refund path
    // for a failure that happens after this request returns) can only reach that
    // id. Splitting the payer between the two refund paths would leak a credit
    // exactly when a grade fails. Never an id from the request body (US-268).
    const buyerEnt = sellerPlanAllowed ? null : await getBuyerEntitlements(ownerId);
    const access = resolveVideoGradingAccess({
      sellerPlanAllowed,
      buyerEntitled: buyerEnt?.gateFlags.videoGrading === true,
    });
    if (!access.allowed) {
      return c.json({
        error:
          "Grading from a video is available on a paid plan. Upgrade, or grade this item from photos.",
        code: "UPGRADE_REQUIRED",
        action: "upgrade",
        feature: VIDEO_GRADING_FEATURE,
        plan: effPlan,
        buyerPlan: buyerEnt?.plan ?? null,
        product: "buyer",
      }, 402);
    }
    // 4. Frame cap — the direct AI-cost multiplier. Operator-tunable, clamped in
    //    code so a bad setting can never widen it past HARD_MAX_VIDEO_FRAMES.
    //    The buyer path shares it deliberately: one video grade costs the same
    //    frames × per-image Vision work whoever asked for it, so a second, softer
    //    buyer cap would be a second number to keep honest for no gain.
    videoMaxFrames = clampFrameCount(
      getSettingSync<number>("video_grading_max_frames", DEFAULT_MAX_VIDEO_FRAMES),
    );
    videoSlotMarks = parseVideoSlotMarks(
      videoSlotMarksRaw,
      videoUpload?.durationSeconds ?? null,
    );
    // 5. US-1841: on the buyer path the credit IS the payment, so spend it now —
    //    before the submission row exists, so an out-of-credits buyer gets the
    //    quota answer for free and leaves nothing behind. Refunded by
    //    failVideoGrading (this request) or refund_grade (a later pipeline
    //    failure), always to the pocket recorded here.
    if (access.payer === "buyer" && buyerEnt) {
      buyerVideoDebit = await debitBuyerMeter(
        ownerId,
        VIDEO_GRADE_BUYER_METER,
        // BUYER_METER_ALLOWANCE is what ties the meter key to the plan number;
        // reading it through the map keeps the two from drifting apart.
        buyerEnt.allowances[BUYER_METER_ALLOWANCE[VIDEO_GRADE_BUYER_METER]],
      );
      if (!buyerVideoDebit) {
        // US-1845: the exhausted case is the one worth measuring — it is the
        // upgrade moment, and it leaves no row behind to count it from later.
        trackBuyerFeature(ownerId, "video_grade", "quota_exhausted", {
          buyer_plan: buyerEnt.plan,
        });
        return c.json({
          error:
            "You've used this month's video-grade credits. Upgrade your plan, or grade this item from photos.",
          code: "quota_exhausted",
          action: "upgrade",
          product: "buyer",
          feature: VIDEO_GRADING_FEATURE,
          buyerPlan: buyerEnt.plan,
        }, 402);
      }
      trackBuyerFeature(ownerId, "video_grade", "credit_spent", {
        buyer_plan: buyerEnt.plan,
        credit_source: buyerVideoDebit,
      });
    }
  }

  // Suspended account gate (pre-pricing). Checks the WORKSPACE OWNER's
  // suspension state since they own the billing relationship. Plan caps are
  // enforced by the precedence step below — exceeding included grades isn't
  // a failure mode, it just falls through to credits or checkout.
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("suspended")
    .eq("id", ownerId)
    .single();

  if (userError || !user) {
    return c.json({ error: "User not found" }, 404);
  }
  if (user.suspended) {
    return c.json({
      error:
        "This workspace has been suspended and cannot create new submissions. Contact support if you believe this is a mistake.",
    }, 403);
  }

  // US-601: honor the authenticity add-on only on a paid Premium/Express tier
  // AND when the kill-switch flag is on. Standard grades never include it.
  const authenticityAddon =
    authenticityAddonOptIn &&
    tierSupportsAuthenticityAddon(tier) &&
    (await isFeatureEnabled("authenticity_addon", { userId: ownerId }));

  // US-1296: honor the Forensic Grade add-on only on a paid Premium/Express tier,
  // when its kill-switch flag is on, AND when this submission's originals are
  // being retained (US-339) — the zoom pass re-reads the uncompressed original,
  // so without retention there's nothing higher-res to forensically analyze.
  const forensicAddon = forensicAddonEnabled({
    optIn: forensicAddonOptIn,
    tier,
    retainOriginals,
    featureEnabled: await isFeatureEnabled("forensic_grade", { userId: ownerId }),
  });

  // US-949: validate the retake target BEFORE creating the new submission, so a
  // forged/foreign id can't link a retake chain across tenants (US-268). The
  // prior submission must belong to the same workspace owner and be in a
  // retakeable state (needs_photos = quality gate abstained, or expired =
  // checkout never completed). Anything else is ignored (treated as a fresh
  // submission) rather than failing the whole grade.
  let retakeTargetId: string | null = null;
  if (retakeOf) {
    const { data: prior } = await supabaseAdmin
      .from("submissions")
      .select("id, status, superseded_at")
      .eq("id", retakeOf)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (
      prior &&
      !prior.superseded_at &&
      (prior.status === "needs_photos" || prior.status === "expired")
    ) {
      retakeTargetId = prior.id;
    }
  }

  // US-1282: validate the re-grade target BEFORE creating the submission so a
  // forged/foreign garment id can't link a re-grade across tenants (US-268). The
  // garment must belong to this workspace owner (created_by) and be active.
  // Anything else is ignored (treated as a fresh first grade) rather than failing.
  let regradeTargetGarmentId: string | null = null;
  if (regradeOf) {
    const { data: priorGarment } = await supabaseAdmin
      .from("garments")
      .select("id, status")
      .eq("id", regradeOf)
      .eq("created_by", ownerId)
      .maybeSingle();
    if (priorGarment && priorGarment.status === "active") {
      regradeTargetGarmentId = priorGarment.id;
    }
  }

  // US-1841: validate the closet link the same way, scoped to the same account
  // the grade and the buyer credit are billed to, so a forged id can never make
  // one tenant's grade land in another tenant's portfolio. Unowned → ignored.
  let closetItemId: string | null = null;
  if (closetItemOf) {
    const { data: closetRow } = await supabaseAdmin
      .from("closet_items")
      .select("id")
      .eq("id", closetItemOf)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (closetRow) closetItemId = (closetRow as { id: string }).id;
  }

  // US-2504/US-268: same shape, same reasoning. Scoped to the account the
  // grade is billed to, so a forged id cannot land one tenant’s grade on
  // another tenant’s item. An unowned id is IGNORED rather than refused -
  // refusing would leak whether the id exists in another tenant, which is the
  // choice closet_item_id and `regrade_of` already make.
  let inventoryItemId: string | null = null;
  if (inventoryItemOf) {
    const { data: itemRow } = await supabaseAdmin
      .from("inventory_items")
      .select("id")
      .eq("id", inventoryItemOf)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (itemRow) inventoryItemId = (itemRow as { id: string }).id;
  }

  // Create submission (unpaid). user_id is the workspace owner so the row
  // is visible to all workspace members via the additive RLS.
  const { data: submission, error: submissionError } = await supabaseAdmin
    .from("submissions")
    .insert({
      user_id: ownerId,
      garment_type: garmentType as GarmentType,
      garment_category: garmentCategory as GarmentCategory,
      title: title!.trim(),
      brand: brand?.trim() || null,
      description: description?.trim() || null,
      style_attributes: styleAttributes,
      verified_capture_opt_in: verifiedCaptureOptIn,
      live_capture_opt_in: liveCaptureOptIn,
      verified_360_opt_in: verified360OptIn,
      capture_360: capture360,
      // US-1762: the request to grade from the clip. `video_graded` is set only
      // once frames actually landed — the pipeline reads THAT, never this.
      video_grading_opt_in: videoGradingOptIn,
      video_slot_marks: videoGradingOptIn ? videoSlotMarks : null,
      // US-1766: clip provenance. Stored only for a video-graded submission —
      // on a photo submission there is no clip for it to describe.
      video_capture_source: videoGradingOptIn ? videoCaptureSource : null,
      authenticity_addon: authenticityAddon,
      forensic_addon: forensicAddon,
      retake_of_submission_id: retakeTargetId,
      regrade_of_garment_id: regradeTargetGarmentId,
      // US-1841: buyer-funded clip grade — which pocket paid, and the portfolio
      // item the finished grade is written back onto.
      buyer_video_grade: buyerVideoDebit !== null,
      buyer_credit_source: buyerVideoDebit,
      closet_item_id: closetItemId,
      // The requested grade-speed tier drives the review SLA + queue priority
      // (express > premium > standard) once the AI grade lands in human review.
      service_tier: tier,
      status: "pending",
      payment_status: "unpaid",
    })
    .select("id")
    .single();

  if (submissionError || !submission) {
    console.error("Failed to create submission:", submissionError);
    // US-1841: the buyer credit was spent at the gate, before this row existed —
    // there is no submission for refund_grade to find, so hand it back here.
    if (buyerVideoDebit) {
      await refundBuyerMeterSource(ownerId, VIDEO_GRADE_BUYER_METER, buyerVideoDebit);
    }
    return c.json({ error: "Failed to create submission" }, 500);
  }

  const submissionId = submission.id;

  // Upload images.
  const imageRecords: Array<{
    submission_id: string;
    image_type: string;
    storage_path: string;
    display_order: number;
    phash: string | null;
    exif: Record<string, unknown> | null;
    original_storage_path: string | null;
    capture_source: string | null;
    quality_score: number | null;
    width: number | null;
    height: number | null;
  }> = [];

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const imageType = imageTypes[i];
    const timestamp = Date.now();

    // US-276: never trust the client extension/MIME. Sniff the real bytes,
    // reject SVG/non-images, cap size + dimensions; the private bucket accepts
    // only jpeg/png/webp. Then strip EXIF/GPS before the bytes ever land.
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const verdict = validateImageUpload(rawBytes, {
      allow: ["jpeg", "png", "webp"],
    });
    if (!verdict.ok) {
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return c.json(
        { error: `Invalid image (${imageType}): ${verdict.reason}` },
        400,
      );
    }
    const { bytes: cleanBytes } = stripImageMetadata(rawBytes, verdict.format);
    // US-480: recompute the reuse-detection hash from the bytes we actually
    // store (never the client). null on a decode/hash failure → image is simply
    // skipped by reuse detection, never blocked.
    const serverPhash = await computePhashFromImage(cleanBytes, verdict.format);
    const storagePath =
      `${ownerId}/${submissionId}/${imageType}_${timestamp}.${verdict.ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(storagePath, cleanBytes, {
        contentType: verdict.contentType,
        upsert: false,
      });

    if (uploadError) {
      console.error(`Failed to upload image ${i}:`, uploadError);
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return c.json({ error: `Failed to upload image: ${imageType}` }, 500);
    }

    // US-339: optionally retain the uncompressed ORIGINAL (EXIF intact) for
    // forensic/provenance use. Stored in the SAME private bucket + owner folder
    // as the compressed image (tenant-scoped, signed-URL-only access). Unlike
    // the compressed copy we deliberately DO NOT strip metadata here — that's
    // the whole point. Validation still runs (sniff + size/dim cap). Best
    // effort: a failed original upload never fails the submission.
    let originalStoragePath: string | null = null;
    if (retainOriginals) {
      const orig = allOriginals[i];
      if (orig instanceof File && orig.size > 0) {
        try {
          const origBytes = new Uint8Array(await orig.arrayBuffer());
          const origVerdict = validateImageUpload(origBytes, {
            allow: ["jpeg", "png", "webp"],
          });
          if (origVerdict.ok) {
            const origPath =
              `${ownerId}/${submissionId}/original_${imageType}_${timestamp}.${origVerdict.ext}`;
            const { error: origErr } = await supabaseAdmin.storage
              .from("submission-images")
              .upload(origPath, origBytes, {
                contentType: origVerdict.contentType,
                upsert: false,
              });
            if (origErr) {
              console.error(`Failed to upload original ${i}:`, origErr);
            } else {
              originalStoragePath = origPath;
            }
          }
        } catch (err) {
          console.error(`Original retention failed for image ${i}:`, err);
        }
      }
    }

    imageRecords.push({
      submission_id: submissionId,
      image_type: imageType,
      storage_path: storagePath,
      display_order: i,
      phash: serverPhash,
      exif: imageExif[i] ?? null,
      original_storage_path: originalStoragePath,
      capture_source: imageCaptureSource[i] ?? null,
      quality_score: imageQualityScore[i] ?? null,
      // US-2135 AC3: the delivered pixel dimensions, which validateImageUpload
      // already parsed out of the header above to enforce the bomb ceiling and
      // the US-529 floor, and which were being discarded. For a dedicated macro
      // slot the whole photo IS the region, so these ARE that region's density.
      //
      // Server-observed, unlike quality_score beside it: parsed from the bytes
      // we are about to store rather than reported by the client, so it needs
      // no client change to start working and cannot be overstated by one.
      // null when the parser does not read that format's header — never 0.
      width: verdict.width,
      height: verdict.height,
    });
  }

  // A video-graded submission arrives with NO photos (they're refused above), so
  // there is nothing to insert here — the frames become these rows further down.
  let imageInsertError: { message: string } | null = null;
  if (imageRecords.length > 0) {
    const { error } = await supabaseAdmin
      .from("submission_images")
      .insert(imageRecords);
    imageInsertError = error;
  }

  if (imageInsertError) {
    console.error("Failed to insert image records:", imageInsertError);
    for (const record of imageRecords) {
      const paths = [record.storage_path];
      // US-339: clean up any retained original alongside the compressed copy.
      if (record.original_storage_path) paths.push(record.original_storage_path);
      await supabaseAdmin.storage.from("submission-images").remove(paths);
    }
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    return c.json({ error: "Failed to save image records" }, 500);
  }

  // US-1763: store the validated walk-around video (if any) alongside the
  // photos in the private bucket + owner folder, then record its path on the
  // submission for US-1764 to consume. The clip is supplementary to the
  // photo-based grade, so a storage/patch failure is best-effort (logged) — it
  // must not fail an otherwise-good submission.
  if (videoUpload) {
    const videoPath =
      `${ownerId}/${submissionId}/video_${Date.now()}.${videoUpload.ext}`;
    const { error: videoUploadError } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(videoPath, videoUpload.bytes, {
        contentType: videoUpload.contentType,
        upsert: false,
      });
    if (videoUploadError) {
      console.error("Failed to upload video:", videoUploadError);
      // Attaching a clip is supplementary and stays best-effort — but a
      // submission that has NOTHING BUT the clip cannot be graded without it.
      if (videoGradingOptIn) {
        return await failVideoGrading(
          c,
          submissionId,
          ownerId,
          "The clip could not be stored, so there was nothing to grade. Try uploading it again.",
          { ok: false, stage: "upload" },
          buyerVideoDebit,
        );
      }
    } else {
      const { error: videoPatchError } = await supabaseAdmin
        .from("submissions")
        .update({
          video_storage_path: videoPath,
          video_content_type: videoUpload.contentType,
          video_duration_seconds: videoUpload.durationSeconds,
        })
        .eq("id", submissionId)
        .eq("user_id", ownerId);
      if (videoPatchError) {
        console.error("Failed to record video path:", videoPatchError);
      }
    }
  }

  // ── US-1764: clip -> grading frames ────────────────────────────────────────
  // Decode a bounded set of stills, keep the sharpest well-exposed one per slot,
  // drop near-duplicates, and write them as ordinary submission_images. Every
  // frame goes through the SAME US-276 hardening as an uploaded photo (sniff →
  // strip metadata → store) — ffmpeg output is bytes we generated, but treating
  // it as trusted would make this the one upload path with a weaker gate.
  if (videoGradingOptIn && videoUpload) {
    const extraction = await extractVideoFrames({
      videoBytes: videoUpload.bytes,
      durationSeconds: videoUpload.durationSeconds ?? 0,
      marks: videoSlotMarks,
      maxFrames: videoMaxFrames,
      ext: videoUpload.ext,
    });

    if (!extraction.ok || !extraction.selection.ok) {
      const reason = extraction.ok ? extraction.selection.reason : extraction.reason;
      console.error(`[video-grade] extraction failed for ${submissionId}: ${reason}`);
      return await failVideoGrading(c, submissionId, ownerId, reason, {
        ok: false,
        stage: extraction.ok ? "selection" : "extraction",
        max_frames: videoMaxFrames,
        duration_seconds: videoUpload.durationSeconds,
        extracted: extraction.extracted,
        planned: extraction.plan.map((p) => ({ slot: p.slot, at: p.atSeconds })),
        dropped: extraction.ok ? extraction.selection.dropped : [],
        reason,
      }, buyerVideoDebit);
    }

    const frameRecords: typeof imageRecords = [];
    const framePaths: string[] = [];
    let frameOrder = 0;
    for (const frame of extraction.selection.frames) {
      const verdict = validateImageUpload(frame.bytes, { allow: ["jpeg"] });
      if (!verdict.ok) {
        console.error(`[video-grade] frame ${frame.slot} rejected: ${verdict.reason}`);
        continue;
      }
      const { bytes: cleanBytes } = stripImageMetadata(frame.bytes, verdict.format);
      const framePath =
        `${ownerId}/${submissionId}/${frame.slot}_${Date.now()}_${frameOrder}.${verdict.ext}`;
      const { error: frameUploadError } = await supabaseAdmin.storage
        .from("submission-images")
        .upload(framePath, cleanBytes, {
          contentType: verdict.contentType,
          upsert: false,
        });
      if (frameUploadError) {
        console.error(`[video-grade] frame upload failed:`, frameUploadError);
        continue;
      }
      framePaths.push(framePath);
      frameRecords.push({
        submission_id: submissionId,
        image_type: frame.slot,
        storage_path: framePath,
        display_order: frameOrder++,
        // Recomputed from the stored bytes like every other upload, so a frame
        // lifted from someone else's listing video is still caught by reuse
        // detection (US-480) — and can still cost the clip its badge.
        phash: await computePhashFromImage(cleanBytes, verdict.format),
        // A frame carries no EXIF: it was never a file on a camera. The
        // provenance claim here is video_capture, not device metadata.
        exif: null,
        original_storage_path: null,
        capture_source: VIDEO_FRAME_CAPTURE_SOURCE,
        // US-2136 AC4: NULL, not zero, and not measured server-side. A video
        // frame never went through the browser capture gate, so we have not
        // looked at its sharpness — and "unknown" is the value that applies no
        // confidence cap. Writing 0 here would claim we measured it and found
        // it unreadable, which would silently cap every video-graded item.
        quality_score: null,
        // US-2135 AC3: dimensions ARE known here, and the asymmetry with
        // quality_score above is the point. Nobody measured this frame's
        // sharpness, so that stays null; the validator just parsed this frame's
        // width and height out of its own header, so those are as known as they
        // are for an uploaded photo. Null would understate what we have.
        width: verdict.width,
        height: verdict.height,
      });
    }

    // A frame lost between selection and storage takes its slot's coverage with
    // it, so re-check the required set rather than grading a partial clip.
    const storedSlots = new Set(frameRecords.map((r) => r.image_type));
    const requiredMissing = REQUIRED_IMAGE_TYPES.filter((t) => !storedSlots.has(t));
    if (requiredMissing.length > 0 || !storedSlots.has("detail")) {
      if (framePaths.length > 0) {
        await supabaseAdmin.storage.from("submission-images").remove(framePaths);
      }
      return await failVideoGrading(
        c,
        submissionId,
        ownerId,
        "The clip's frames could not be saved, so there was nothing to grade. Try again in a moment.",
        { ok: false, stage: "store", max_frames: videoMaxFrames },
        buyerVideoDebit,
      );
    }

    const { error: frameInsertError } = await supabaseAdmin
      .from("submission_images")
      .insert(frameRecords);
    if (frameInsertError) {
      console.error("[video-grade] frame records insert failed:", frameInsertError);
      if (framePaths.length > 0) {
        await supabaseAdmin.storage.from("submission-images").remove(framePaths);
      }
      return await failVideoGrading(
        c,
        submissionId,
        ownerId,
        "The clip's frames could not be saved, so there was nothing to grade. Try again in a moment.",
        { ok: false, stage: "insert", max_frames: videoMaxFrames },
        buyerVideoDebit,
      );
    }

    // Only NOW is the submission genuinely video-graded. The pipeline reads this
    // flag (not the opt-in) to meter under feature='video_grading' and to
    // evaluate the Video-Verified badge.
    const { error: videoGradedPatchError } = await supabaseAdmin
      .from("submissions")
      .update({
        video_graded: true,
        video_frames: {
          ok: true,
          max_frames: videoMaxFrames,
          duration_seconds: videoUpload.durationSeconds,
          extracted: extraction.extracted,
          selected: frameRecords.length,
          reason: extraction.selection.reason,
          dropped: extraction.selection.dropped,
          frames: extraction.selection.frames.map((f) => ({
            slot: f.slot,
            at: Number(f.atSeconds.toFixed(3)),
            sharpness: Math.round(f.sharpness),
            luma: Math.round(f.luma),
          })),
        },
      })
      .eq("id", submissionId)
      .eq("user_id", ownerId);
    if (videoGradedPatchError) {
      console.error("[video-grade] failed to mark video_graded:", videoGradedPatchError);
    }
    console.log(
      `[video-grade] ${submissionId}: ${frameRecords.length} frame(s) from ` +
        `${extraction.extracted} decode(s), cap ${videoMaxFrames}`,
    );
  }

  // US-2504: link the finished submission to the seller’s item.
  //
  // PLACED HERE ON PURPOSE - past every abstain and every frame-storage
  // failure, which return earlier, and before payment. Linking sooner would
  // leave an item marked "grading" against a submission that abstained, and a
  // bridge row pointing at a submission the failure paths delete.
  //
  // Two writes, both of which the pipeline already reads:
  //   - flipdesk_grading_submissions is what the in-app status poll reads and
  //     what grading-pipeline.ts flips to completed / pending_review.
  //   - inventory_items.submission_id is what the pipeline’s item sync keys on
  //     to write grade_value / grade_label / grade_report_id back.
  // Mirrors steps 4 and 5 of the FlipDesk path so one grade does not reach an
  // item by two different mechanisms.
  if (inventoryItemId) {
    try {
      await supabaseAdmin.from("flipdesk_grading_submissions").insert({
        inventory_item_id: inventoryItemId,
        submission_id: submissionId,
        tier,
        status: "pending",
        cost: TIER_CREDIT_COST[tier] ?? 0,
        submitted_at: new Date().toISOString(),
      });
      await supabaseAdmin
        .from("inventory_items")
        .update({ status: "grading", submission_id: submissionId })
        .eq("id", inventoryItemId)
        .eq("user_id", ownerId);
    } catch (linkErr) {
      // The GRADE is not conditional on the link. A failed bridge write leaves
      // a certificate the seller can still attach by hand; throwing here would
      // lose a grade they have already paid for.
      console.error(
        `[grade] inventory link failed for ${submissionId}:`,
        linkErr instanceof Error ? linkErr.message : String(linkErr),
      );
    }
  }

  // US-949: now that the retake submission exists with its images, mark the
  // prior submission superseded so it drops out of active counts (preserved as
  // history, not deleted). Tenant-scoped by user_id (US-268) and guarded on the
  // retakeable status so a racing supersede can't clobber an unrelated row.
  if (retakeTargetId) {
    const { error: supersedeError } = await supabaseAdmin
      .from("submissions")
      .update({
        superseded_at: new Date().toISOString(),
        superseded_by_submission_id: submissionId,
      })
      .eq("id", retakeTargetId)
      .eq("user_id", ownerId)
      .in("status", ["needs_photos", "expired"]);
    if (supersedeError) {
      // Non-fatal: the new submission stands on its own; the old one just
      // remains visible. Log for follow-up rather than failing the grade.
      console.error(
        `Failed to supersede prior submission ${retakeTargetId}:`,
        supersedeError,
      );
    }
  }

  // US-1841: on the buyer path the video-grade credit spent at the gate IS the
  // payment, so the seller precedence must NOT also run — a Guard buyer with no
  // FlipDesk plan would otherwise be asked to buy a grade they already paid for
  // with the credit their plan includes. Recorded as its own payment_status
  // (00536) rather than folded into 'credits', which means the seller's
  // grade_credit_balance was debited and is what refund_grade would try to return.
  if (buyerVideoDebit) {
    const { error: buyerPaidError } = await supabaseAdmin
      .from("submissions")
      .update({ payment_status: "buyer_credits", paid_at: new Date().toISOString() })
      .eq("id", submissionId)
      .eq("user_id", ownerId);
    if (buyerPaidError) {
      // The credit is spent and the frames are stored; refusing to grade now
      // would take the credit and give nothing back, so log and grade anyway.
      // The row simply reads 'unpaid' until the reaper reconciles it.
      console.error("[video-grade] buyer-credit paid flip failed:", buyerPaidError);
    }
    kickPipeline(submissionId, readCtxVar(c, "correlationId"));
    return c.json({
      submissionId,
      status: "processing",
      payment: {
        paid: true,
        method: "buyer_credits",
        source: buyerVideoDebit,
      },
      closetItemId,
    }, 201);
  }

  // Run payment precedence against the WORKSPACE OWNER's account — they pay,
  // they have the plan and credit balance.
  let precedence: PrecedenceResult;
  try {
    // Same derived key as the /pay retry below (US-2298), so the unit of
    // charge is the SUBMISSION rather than the route that happened to charge
    // for it. This path is not racy on its own — each request mints its own
    // submissionId, and two concurrent submissions are two grades and two
    // legitimate charges — but sharing the key makes "one debit per
    // submission" an invariant instead of a property of one handler. A retry
    // that reaches either entry point for an already-paid submission now
    // debits nothing.
    precedence = await runPaymentPrecedence(
      ownerId,
      submissionId,
      tier,
      `grade_pay:${submissionId}`,
    );
  } catch (err) {
    console.error(`Payment precedence failed for ${submissionId}:`, err);
    return c.json({ error: "Payment processing error" }, 500);
  }

  if (precedence.paid) {
    kickPipeline(submissionId, readCtxVar(c, "correlationId"));
    return c.json({
      submissionId,
      status: "processing",
      payment: {
        paid: true,
        method: precedence.method,
        ...(precedence.method === "included"
          ? { newIncludedUsed: precedence.newIncludedUsed }
          : { newBalance: precedence.newBalance }),
      },
    }, 201);
  }

  // Not paid — submission sits at status=pending, payment_status=unpaid.
  // Frontend opens checkout (per-grade or credit pack). Webhook unlocks +
  // /pay/:id retry-precedence handles pack-then-retry flow.
  return c.json({
    submissionId,
    status: "pending",
    payment: {
      paid: false,
      checkoutRequired: true,
      tier: precedence.suggestedTier,
      tierPriceCents: precedence.tierPriceCents,
      suggestedPack: precedence.suggestedPack,
    },
  }, 201);
});

// ── POST /pay/:id ────────────────────────────────────────────────
//
// Re-run payment precedence on an existing unpaid submission. The frontend
// calls this after a credit-pack purchase completes (Stripe returns to a
// success URL) so the new balance is consumed without a second click.
gradeRoutes.post("/pay/:id", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;

  // US-507: same grading kill-switch as /submit (this path also kicks the
  // pipeline). US-2406: scoped to the workspace owner, same as /submit.
  if (!(await isFeatureEnabled("grading", { userId: ownerId }))) {
    return c.json(featureDisabledBody("grading"), 503);
  }
  // Inline AI budget kill-switch (see /submit) — block before charging for the
  // pay-then-grade path too.
  if (await isAiBudgetExhausted("grading")) {
    return c.json(aiBudgetExceededBody("grading"), 503);
  }
  // US-1616 / C3: a read-only viewer must not spend the owner's grade credits.
  // Mirrors the /submit gate — owner/admin/listing_manager/member qualify.
  if ((c.get("workspaceRole") ?? "owner") === "viewer") {
    return c.json({ error: "Viewers cannot pay for or start grades in this workspace" }, 403);
  }
  const submissionId = c.req.param("id");

  let body: { tier?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const tierRaw = body.tier ?? "standard";
  const tier: GradeTier = GRADE_TIERS.includes(tierRaw as GradeTier)
    ? (tierRaw as GradeTier)
    : "standard";

  const { data: submission, error } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, status, payment_status")
    .eq("id", submissionId)
    .eq("user_id", ownerId)
    .single();

  if (error || !submission) {
    return c.json({ error: "Submission not found" }, 404);
  }
  if (submission.payment_status !== "unpaid") {
    return c.json({
      submissionId,
      status: submission.status,
      payment: { paid: true, method: submission.payment_status },
    });
  }

  let precedence: PrecedenceResult;
  try {
    // US-2298 AC1: one credit debit per submission, enforced by the database.
    //
    // The check above is a read, and the debit below is a separate write, so
    // two concurrent /pay calls could both see `unpaid` and both charge. The
    // window is narrow and the charge is real money, which is the worst
    // combination to leave to chance — it fires rarely enough never to be
    // noticed and reproduced, and each time it does, a customer paid twice.
    //
    // WHY THE ROW LOCK ALREADY IN debit_grade_credits IS NOT THE ANSWER, and
    // this is worth stating because the function LOOKS safe: it does
    // `SELECT grade_credit_balance … FOR UPDATE` on the users row, so anyone
    // reading it concludes the debit is protected. FOR UPDATE serialises the
    // two debits; it does not deduplicate them. Both take the lock in turn,
    // both find sufficient balance, both write a ledger row. The lock protects
    // the balance ARITHMETIC, which was its job (US-207); nothing protects the
    // DECISION to charge. Do not remove this key as redundant with it.
    //
    // The key is derived, not random: the same submission retried later
    // produces the same string, which is what makes the second call a no-op
    // rather than a second charge. The machinery already exists — US-2289 gave
    // the RPC its `p_idempotency_key` parameter (00516) and the partial unique
    // index came with 00216 — so this path was simply never passing one.
    precedence = await runPaymentPrecedence(
      ownerId,
      submissionId,
      tier,
      `grade_pay:${submissionId}`,
    );
  } catch (err) {
    console.error(`Retry precedence failed for ${submissionId}:`, err);
    return c.json({ error: "Payment processing error" }, 500);
  }

  if (precedence.paid) {
    kickPipeline(submissionId, readCtxVar(c, "correlationId"));
    return c.json({
      submissionId,
      status: "processing",
      payment: {
        paid: true,
        method: precedence.method,
        ...(precedence.method === "included"
          ? { newIncludedUsed: precedence.newIncludedUsed }
          : { newBalance: precedence.newBalance }),
      },
    });
  }

  return c.json({
    submissionId,
    status: "pending",
    payment: {
      paid: false,
      checkoutRequired: true,
      tier: precedence.suggestedTier,
      tierPriceCents: precedence.tierPriceCents,
      suggestedPack: precedence.suggestedPack,
    },
  });
});

// ── GET /status/:id ──────────────────────────────────────────────
gradeRoutes.get("/status/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;

  const { data: submission, error } = await supabaseAdmin
    .from("submissions")
    .select(
      "id, status, payment_status, paid_at, quality_feedback, created_at, updated_at",
    )
    .eq("id", id)
    .eq("user_id", ownerId)
    .single();

  if (error || !submission) {
    return c.json({ error: "Submission not found" }, 404);
  }

  let gradeReport = null;
  // Mandatory review: the owner sees their grade once it exists — both the
  // PRELIMINARY grade while it's in review (status='pending_review') and the
  // final grade once finalized (status='completed'). review_status on the report
  // tells the UI whether to badge it "pending review" or show it as official.
  if (
    submission.status === "completed" ||
    submission.status === "pending_review"
  ) {
    // US-1638: whitelist tenant-facing columns instead of select("*"). The
    // service-role client bypasses RLS, so "*" here handed the tenant internal
    // ops/anti-fraud fields — reviewed_by/reviewed_at/review_due_at (the admin
    // reviewer's identity + queue timing), forensic_analysis (explicitly never
    // exposed), per_image_analysis (eval/training trace) and prompt_version.
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select(
        "id, submission_id, overall_score, grade_tier, fabric_condition_score, " +
          "structural_integrity_score, cosmetic_appearance_score, " +
          "functional_elements_score, odor_cleanliness_score, ai_summary, " +
          "buyer_writeup, detailed_notes, detected_style_attributes, defects_found, " +
          "confidence_score, needs_human_review, image_authenticity, " +
          "verified_capture, original_photos, authenticity_assessment, " +
          "human_reviewed, review_status, finalized_at, certificate_id, " +
          "content_hash, content_signature, integrity_version, model_version, " +
          "view_count, garment_id, created_at",
      )
      .eq("submission_id", id)
      // US-479: a regraded submission keeps superseded history — return only the
      // active report.
      .is("superseded_at", null)
      .maybeSingle();
    gradeReport = report || null;
  }

  return c.json({
    id: submission.id,
    status: submission.status,
    payment_status: submission.payment_status,
    paid_at: submission.paid_at,
    grade_report: gradeReport,
    // US-332: actionable photo requests when the quality gate abstained.
    quality_feedback: submission.quality_feedback ?? null,
    created_at: submission.created_at,
    updated_at: submission.updated_at,
  });
});

// ── POST /snap — Snap-to-Value (US-612) ──────────────────────────────
//
// A logged-in user uploads a garment photo and instantly gets a condition grade
// ESTIMATE + a condition-adjusted resale value range — no submission row, no
// certificate, no billing (quickGrade is certificate-free). This is the free,
// signup-gated viral funnel; certified grades + listing are the upsell.
//
// Auth + rate limiting come from the /api/grade/* middleware groups. The image
// is validated + EXIF-stripped (US-276) before it's sent to the model, even
// though it is never stored.
function decodeBase64Image(input: string): Uint8Array | null {
  const m = input.match(/^data:image\/\w+;base64,(.+)$/);
  const b64 = (m ? m[1] : input).trim();
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Chunked base64 encode — spreading multi-MB bytes into String.fromCharCode
// overflows the call stack.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

gradeRoutes.post("/snap", async (c) => {
  const snapOwnerId = c.get("workspaceOwnerId") ?? c.get("userId");
  // US-507: Snap rides the grading vision, so it honors the grading kill-switch.
  // US-2406: owner-scoped so targeting applies (see /submit).
  if (!(await isFeatureEnabled("grading", { userId: snapOwnerId }))) {
    return c.json(featureDisabledBody("grading"), 503);
  }
  // Inline AI budget kill-switch (see /submit) — snap rides grading vision too.
  if (await isAiBudgetExhausted("grading")) {
    return c.json(aiBudgetExceededBody("grading"), 503);
  }
  // US-1616 / C3: Snap runs the (owner-billed) grading vision, so a read-only
  // viewer must not be able to drain the workspace's AI budget with it.
  if ((c.get("workspaceRole") ?? "owner") === "viewer") {
    return c.json({ error: "Viewers cannot use Snap-to-Value in this workspace" }, 403);
  }

  let body: { image?: unknown; brand?: unknown; keyword?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.image !== "string" || body.image.length === 0) {
    return c.json({ error: "image (base64 or data URI) is required" }, 400);
  }
  const brand = typeof body.brand === "string" ? body.brand.trim() : undefined;
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : undefined;

  // US-276: sniff the real bytes (reject SVG/non-image, cap size/dims) + strip
  // EXIF/GPS before the photo ever reaches the model. Never stored.
  const rawBytes = decodeBase64Image(body.image);
  if (!rawBytes) return c.json({ error: "image is not valid base64" }, 400);
  const verdict = validateImageUpload(rawBytes, { allow: ["jpeg", "png", "webp"] });
  if (!verdict.ok) return c.json({ error: `Invalid image: ${verdict.reason}` }, 400);
  const { bytes: clean } = stripImageMetadata(rawBytes, verdict.format);
  const dataUri = `data:${verdict.contentType};base64,${bytesToBase64(clean)}`;

  // US-614: per-plan monthly snap cap. Free is the funnel — generous but bounded;
  // paid tiers get more / unlimited. Reserve BEFORE the (paid-for-us) grade so an
  // over-cap user can't burn AI budget; refund on failure.
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data: planRow } = await supabaseAdmin
    .from("users")
    .select("flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
    .eq("id", ownerId)
    .maybeSingle();
  const effPlan = effectivePlanFor(
    (planRow?.flipdesk_plan as string) ?? "free",
    (planRow?.subscription_status as string) ?? "none",
    (planRow?.trial_ends_at as string | null) ?? null,
    new Date(),
    (planRow?.past_due_since as string | null) ?? null,
  );
  const snapCap = SNAP_CAP[effPlan] ?? SNAP_CAP.free;

  // Anti-account-farming: the monthly snap cap is per-account, so signing up N
  // free accounts multiplies free vision calls. Add a per-IP DAILY ceiling on
  // the FREE tier (a second, non-account dimension) so one network can't farm
  // free Snaps across many fresh accounts. Keyed on the Cloudflare-attested IP
  // (un-spoofable; X-Forwarded-For is not trusted in prod). Checked BEFORE the
  // monthly reservation so a blocked request doesn't consume the monthly count.
  // No trusted IP (dev / direct-origin) → skip, matching the rate limiter.
  if (effPlan === "free") {
    const ip = clientIp(c as unknown as Context);
    if (ip) {
      const ipDailyCap = getSettingSync<number>("snap_ip_daily_cap", 30);
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const { data: ipCount } = await supabaseAdmin.rpc("increment_rate_limit", {
        p_bucket_key: `snap-ip:${ip}`,
        p_window_start: dayStart.toISOString(),
      });
      if (typeof ipCount === "number" && ipCount > ipDailyCap) {
        return c.json(
          {
            error:
              "Daily free Snap-to-Value limit reached for your network. Try again tomorrow, or upgrade for more.",
            code: "SNAP_IP_LIMIT_REACHED",
            action: "upgrade",
          },
          429,
        );
      }
    }
  }

  const { data: reserved } = await supabaseAdmin.rpc("reserve_snap", {
    p_user_id: ownerId,
    p_limit: snapCap,
  });
  if (reserved !== true) {
    return c.json(
      {
        error:
          `You've used all ${snapCap} free Snap-to-Value checks this month. Upgrade for more, or get a full certified grade.`,
        code: "SNAP_LIMIT_REACHED",
        action: "upgrade",
      },
      429,
    );
  }

  let grade;
  // US-952: AI-detect the garment type/category alongside the grade so the
  // certified-grade upgrade can prefill the form. Best-effort and run in
  // parallel so it hides under the grade latency; its own failure never fails
  // the snap (the .catch keeps Promise.all from rejecting on it).
  let garmentClassification: GarmentClassification | null = null;
  try {
    const [gradeResult, classification] = await Promise.all([
      quickGrade({
        images: [{ dataUri, type: "front" }],
        garment: { brand: brand ?? null, title: keyword ?? "" },
      }),
      classifyGarment(dataUri).catch((err) => {
        captureException(err, { level: "warn", route: "grade.snap.classify" });
        return null;
      }),
    ]);
    grade = gradeResult;
    garmentClassification = classification;
  } catch (err) {
    // Refund the reserved snap so a transient grading failure isn't counted.
    //
    // US-2345 AC2: this used to be `.then(() => {}, () => {})` — both callbacks
    // empty, so a refund that never happened looked exactly like one that did.
    // The user is already being told the grade failed; what they must not also
    // get is a silently consumed snap, and nobody would ever hear about it.
    //
    // Still non-blocking: the 502 below is the honest answer to the caller
    // whether or not the refund lands, and holding the response on a second
    // database call would make a bad path slower for no benefit. What changed is
    // that a failure is now REPORTED — the user's snap balance is wrong and an
    // operator can put it right, which they cannot do if nothing was recorded.
    // US-2345 AC1: moved to lib/grade-refund.ts so the FAILURE branch is
    // testable. It reached the service-role client directly here, which is why
    // the path that matters most had no test — exercising it needed a database.
    // Behaviour is unchanged: still non-blocking, still reports.
    await refundReservedSnap(ownerId);
    captureException(err, { route: "grade.snap", correlationId: readCtxVar(c, "correlationId") });
    return c.json({ error: "Couldn't grade that photo. Try a clearer, well-lit shot." }, 502);
  }

  // Condition-adjusted value range — only when we can identify the item enough
  // to comp it (brand and/or keyword). Otherwise return the grade alone.
  let value = null;
  if (brand || keyword) {
    try {
      const query = [brand, keyword].filter(Boolean).join(" ").trim();
      const cats = await suggestCategories(query);
      const categoryId = cats[0]?.categoryId;
      if (categoryId) {
        value = await valueAtGrade({ categoryId, q: keyword, brand }, grade.overallScore);
      }
    } catch (err) {
      // Value is a bonus — a comp/taxonomy hiccup shouldn't fail the snap.
      captureException(err, { level: "warn", route: "grade.snap.value" });
    }
  }

  return c.json({
    grade: {
      overall_score: grade.overallScore,
      grade_tier: grade.gradeTier,
      confidence: grade.confidence,
      factor_scores: grade.factorScores,
    },
    value, // { lowCents, medianCents, highCents, sampleSize, confidence, sufficient } | null
    // US-952: best-effort AI-detected garment type/category to prefill the
    // certified-grade form. null when the model couldn't classify it.
    garment: garmentClassification
      ? {
          type: garmentClassification.garmentType,
          category: garmentClassification.garmentCategory,
        }
      : null,
    estimate: true,
    disclaimer:
      "This is an AI condition + value ESTIMATE from one photo — not a certified GradeThread grade or a guaranteed sale price. Get a full certified grade to list with confidence.",
  });
});

// US-1437: file a grade dispute server-side. This MUST be server-side for two
// reasons the previous browser→bucket path got wrong:
//   (1) Security (US-276): evidence photos reached storage with NO magic-byte
//       validation or EXIF/GPS stripping. Every image is now sniffed + stripped
//       here (same as the grading uploads) before it is stored.
//   (2) Tenant correctness: the disputes + storage RLS is auth.uid() = user_id,
//       but a dispute (and its evidence) belongs to the WORKSPACE OWNER's account.
//       A non-owner MEMBER's client-side insert/upload therefore failed RLS — they
//       could not file a dispute at all. workspaceMiddleware has already verified
//       this caller is a member of workspaceOwnerId's workspace, so we file as the
//       owner via the service-role client AFTER confirming the owner actually owns
//       the grade report (US-268).
const MAX_DISPUTE_EVIDENCE = 8;

// US-2153: the CANONICAL dispute filing window. The server is the source of
// truth — web (submission-detail.tsx) and iOS (DisputeReason.days) each keep a
// local copy for the affordance's enabled/disabled state, but only this value
// decides whether a filing is accepted, and it is echoed back in the typed
// rejection so a client can display the real window instead of hardcoding it.
const DISPUTE_WINDOW_DAYS = 7;

gradeRoutes.post("/dispute", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;
  // US-1616 / C3: filing a dispute acts on the owner's grade report + can
  // trigger refunds/credits — not a read-only viewer action.
  if ((c.get("workspaceRole") ?? "owner") === "viewer") {
    return c.json({ error: "Viewers cannot file disputes in this workspace" }, 403);
  }

  let body: {
    gradeReportId?: unknown;
    grade_report_id?: unknown;
    reason?: unknown;
    images?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // US-2688: BOTH spellings, and the fix belongs here rather than on the client.
  //
  // This route read camelCase while the rest of the edge reads snake_case, and
  // iOS encodes every request with JSONEncoder.iso8601 (.convertToSnakeCase), so
  // every filing from the phone arrived as `grade_report_id` and was answered
  // 400 "gradeReportId is required" - shown to the customer verbatim, since the
  // sheet renders the server's own string.
  //
  // ⚠ THE CLIENT-SIDE FIX DOES NOT EXIST, which is why this is server-side.
  // Explicit CodingKeys do NOT protect a key from the strategy: Swift applies
  // .convertToSnakeCase to the CodingKey's stringValue, so `case gradeReportId =
  // "gradeReportId"` still goes out as grade_report_id. (`data_url` in the
  // support composer survives only because it is ALREADY snake_case.) The only
  // client-side options were a per-call encoder override or hand-built JSON,
  // both of which leave the next caller to rediscover this.
  //
  // Accepting both costs one `??` and cannot be undone by a client refactor.
  const rawGradeReportId =
    typeof body.gradeReportId === "string"
      ? body.gradeReportId
      : typeof body.grade_report_id === "string"
        ? body.grade_report_id
        : "";
  const gradeReportId = rawGradeReportId.trim();
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!gradeReportId) {
    return c.json(
      { error: "gradeReportId (or grade_report_id) is required" },
      400,
    );
  }
  if (!reason) return c.json({ error: "reason is required" }, 400);
  const images = Array.isArray(body.images)
    ? body.images.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : [];
  if (images.length > MAX_DISPUTE_EVIDENCE) {
    return c.json(
      { error: `At most ${MAX_DISPUTE_EVIDENCE} evidence photos are allowed` },
      400,
    );
  }

  // Ownership (US-268): grade_reports has no user_id, so verify the report's
  // submission belongs to this workspace owner. A miss is reported as not-found
  // so an id probe can't distinguish "doesn't exist" from "not yours".
  const { data: gr } = await supabaseAdmin
    .from("grade_reports")
    .select("id, submission_id, created_at")
    .eq("id", gradeReportId)
    .maybeSingle();
  const report = gr as
    | { submission_id: string; created_at: string }
    | null;
  const submissionId = report?.submission_id ?? null;
  if (!submissionId) return c.json({ error: "Grade report not found" }, 404);
  const { data: sub } = await supabaseAdmin
    .from("submissions")
    .select("id")
    .eq("id", submissionId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!sub) return c.json({ error: "Grade report not found" }, 404);

  // US-2153: enforce the filing window server-side. The 7-day rule was only in
  // client UI, so a slow/older report could still be disputed via a direct API
  // call. The window is echoed so the client can word its own message.
  const ageMs = Date.now() - new Date(report!.created_at).getTime();
  if (ageMs > DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    return c.json(
      {
        error: `The ${DISPUTE_WINDOW_DAYS}-day window to dispute this grade has passed.`,
        code: "DISPUTE_WINDOW_EXPIRED",
        windowDays: DISPUTE_WINDOW_DAYS,
      },
      422,
    );
  }

  // US-2153: refuse a second GRADE dispute for the same (owner, report). The
  // client gate is advisory — a double-tap, a two-device race, or a direct API
  // call could each insert a duplicate that lands in the human review queue.
  // Scoped to kind='grade' so it never collides with an authenticity appeal
  // (00489) on the same report. The unique index (00493) is the race-proof
  // backstop; this SELECT gives a clean message on the common case.
  const { data: existing } = await supabaseAdmin
    .from("disputes")
    .select("id")
    .eq("user_id", ownerId)
    .eq("grade_report_id", gradeReportId)
    .eq("kind", "grade")
    .maybeSingle();
  if (existing) {
    return c.json(
      {
        error: "You've already filed a dispute for this grade.",
        code: "DISPUTE_ALREADY_EXISTS",
      },
      409,
    );
  }

  // Validate + strip + store each evidence image (US-276). Stored under the
  // owner's folder, matching the submission's own images. The service-role write
  // bypasses storage RLS; a bad image is dropped (counted) rather than failing
  // the whole filing.
  const evidencePaths: string[] = [];
  let failures = 0;
  for (let i = 0; i < images.length; i++) {
    const rawBytes = decodeBase64Image(images[i]!);
    if (!rawBytes) {
      failures++;
      continue;
    }
    const verdict = validateImageUpload(rawBytes, {
      allow: ["jpeg", "png", "webp"],
    });
    if (!verdict.ok) {
      failures++;
      continue;
    }
    const { bytes: clean } = stripImageMetadata(rawBytes, verdict.format);
    const ext = verdict.format === "jpeg" ? "jpg" : verdict.format;
    const path = `${ownerId}/${submissionId}/dispute_${Date.now()}_${i}.${ext}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(path, clean, { contentType: verdict.contentType });
    if (upErr) {
      failures++;
      continue;
    }
    evidencePaths.push(path);
  }

  // File the dispute as the owner (verified above) + flip the submission to
  // disputed. Both writes are service-role and tenant-scoped to ownerId.
  const { data: dispute, error: dErr } = await supabaseAdmin
    .from("disputes")
    .insert({
      grade_report_id: gradeReportId,
      user_id: ownerId,
      reason,
      evidence_paths: evidencePaths,
    })
    .select()
    .single();
  if (dErr || !dispute) {
    // US-2153: the unique index (00493) catches a duplicate that raced past the
    // SELECT above (two devices, a double-tap). Report it as the same 409 the
    // pre-check returns rather than a 500 the client would surface as a failure.
    if ((dErr as { code?: string } | null)?.code === "23505") {
      return c.json(
        {
          error: "You've already filed a dispute for this grade.",
          code: "DISPUTE_ALREADY_EXISTS",
        },
        409,
      );
    }
    captureException(dErr, { route: "grade.dispute", userId });
    return c.json({ error: "Couldn't file the dispute" }, 500);
  }
  await supabaseAdmin
    .from("submissions")
    .update({ status: "disputed" })
    .eq("id", submissionId)
    .eq("user_id", ownerId);

  return c.json({ dispute, evidence_failures: failures });
});

// US-2145: contest an AUTHENTICITY verdict.
//
// The only path in the module that protects a SELLER. A red_flags verdict is
// published on a public certificate, comes from a pass with no measured error
// rate, and since US-2141/2142 is sealed into certificate integrity and written
// to an append-only passport ledger. Until now there was no way to contest it.
//
// Files as disputes.kind='authenticity' (00489) rather than a parallel appeals
// table, and HIDES the verdict while open (decided 2026-07-19, §1b) — we stop
// publishing a claim we are actively reconsidering. Hiding is reversible; a
// rejected appeal restores exactly what was there.
gradeRoutes.post("/authenticity-appeal", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;
  if ((c.get("workspaceRole") ?? "owner") === "viewer") {
    return c.json({ error: "Viewers cannot file appeals in this workspace" }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const invalid = validateAppeal({
    grade_report_id: body.gradeReportId,
    reason: body.reason,
  });
  if (invalid) return c.json({ error: invalid }, 400);
  const gradeReportId = String(body.gradeReportId).trim();
  const reason = String(body.reason).trim().slice(0, 2000);

  // Ownership (US-268): grade_reports carries no user_id, so verify through the
  // submission. A miss reports not-found so an id probe cannot distinguish
  // "doesn't exist" from "not yours".
  const { data: gr } = await supabaseAdmin
    .from("grade_reports")
    .select("id, submission_id, certificate_id, authenticity_assessment")
    .eq("id", gradeReportId)
    .maybeSingle();
  const report = gr as {
    submission_id: string;
    certificate_id: string | null;
    authenticity_assessment: Record<string, unknown> | null;
  } | null;
  if (!report) return c.json({ error: "Grade report not found" }, 404);

  const { data: owned } = await supabaseAdmin
    .from("submissions")
    .select("id")
    .eq("id", report.submission_id)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!owned) return c.json({ error: "Grade report not found" }, 404);

  if (!report.authenticity_assessment) {
    return c.json({ error: "This grade has no authenticity assessment to contest." }, 422);
  }

  // Rate limit: hiding the verdict while an appeal is open means an unlimited
  // appeal is a free way to suppress every verdict indefinitely.
  const { count } = await supabaseAdmin
    .from("disputes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ownerId)
    .eq("kind", "authenticity")
    .in("status", ["open", "under_review"]);
  const gate = canOpenAppeal(count ?? 0);
  if (!gate.ok) return c.json({ error: gate.reason }, 429);

  const { data: appeal, error: aErr } = await supabaseAdmin
    .from("disputes")
    .insert({
      grade_report_id: gradeReportId,
      user_id: ownerId,
      kind: "authenticity",
      reason,
    })
    .select("id")
    .single();
  if (aErr || !appeal) {
    captureException(aErr, { route: "grade.authenticity_appeal", userId });
    return c.json({ error: "Couldn't file the appeal" }, 500);
  }

  // Hide the verdict, then RESEAL — integrity v4 covers the verdict, so a
  // change without a reseal leaves a hash over something no longer displayed
  // and verification starts failing on the certificate we just corrected.
  const hidden = hideAssessmentForAppeal(report.authenticity_assessment, new Date().toISOString());
  const update: Record<string, unknown> = { authenticity_assessment: hidden };
  if (report.certificate_id) {
    // Pass the HIDDEN assessment — resealing against the stored (still visible)
    // one would write a signature over a verdict we are about to replace.
    const resealed = await resealAfterAuthenticityChange(
      gradeReportId,
      hidden as { verdict?: string | null; verdict_confidence?: number | null } | null,
    );
    if (resealed) Object.assign(update, resealed);
  }
  const { error: uErr } = await supabaseAdmin
    .from("grade_reports")
    .update(update)
    .eq("id", gradeReportId);
  if (uErr) {
    captureException(uErr, { route: "grade.authenticity_appeal.hide", userId });
    // The appeal is on record even if hiding failed — better a visible verdict
    // with a filed appeal than a silent appeal nobody will action.
    return c.json({ appeal_id: appeal.id, hidden: false }, 201);
  }

  return c.json({ appeal_id: (appeal as { id: string }).id, hidden: true }, 201);
});

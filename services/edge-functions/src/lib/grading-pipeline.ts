import { supabaseAdmin } from "./supabase.ts";
import { captureException } from "./observability.ts";
import { deleteCertImages } from "./cloudflare-purge.ts";
import {
  analyzeImage,
  compositeGrade,
  mergeAuthenticityReread,
  mergeLabelReread,
  mergeZoomIntoIssue,
  partitionImageResults,
  selectDefectsForZoom,
  selectImagesForAuthenticityReread,
  selectLabelsForReread,
  selectMacrosForReread,
  selectVerificationImages,
  PARTIAL_IMAGE_CONFIDENCE_CAP,
  type SettledImage,
  type PerImageAnalysis,
  type GarmentInfo,
  type CompositeGradeResult,
  type VerificationImage,
} from "./ai-grading.ts";
import { Image } from "imagescript";
import {
  resolveTrustedStyle,
  baselineReferenceBlock,
  getGarmentBaseline,
} from "./garment-baselines.ts";
import {
  composeConfidenceCap,
  DEFAULT_PEER_NORM_CONFIG,
  evaluatePeerNorm,
  fetchPeerDistribution,
  type PeerNormConfig,
} from "./peer-norm.ts";
import { getDefaultModel, reconcileNeedsReview } from "./ai-config.ts";
import {
  assessMacroDensity,
  type DeliveredImage,
} from "./macro-evidence-density.ts";
import {
  evaluateSecondOpinion,
  resolveSecondOpinionConfig,
  type SecondOpinionConfig,
  shouldSeekSecondOpinion,
} from "./second-opinion.ts";
import { gradingUsageFeature } from "./video-grading-cost.ts";
import { getSetting } from "./system-settings.ts";
import {
  applyDecoderContradictionCap,
  assessAuthenticity,
  authenticityNeedsReview,
  type AuthenticityAssessment,
  type DecoderContradiction,
} from "./ai-authenticity.ts";
import { getEffectiveTellsForBrand } from "./brand-authenticity.ts";
import { runShadowGrades } from "./grading-shadow.ts";
import { runPerImageShadowGrades } from "./grading-shadow-per-image.ts";
import { notifyWebhooks } from "./webhook-delivery.ts";
import {
  sendGradeFinalizedEmail,
  sendGradePreliminaryEmail,
} from "./email.ts";
import { TIER_SLA_HOURS } from "./grade-pricing.ts";
import { notifyAdminsGradeReviewNeeded } from "./grade-review-notify.ts";
import { autoApproveThreshold, shouldAutoApprove } from "./grade-auto-approve.ts";
import { submitUrls, certificateUrl } from "./indexnow.ts";
import {
  generateUniqueCertNumber,
  isCertificateNumberConflict,
} from "./cert-number.ts";
import {
  appendRegradeEvent,
  createSingleHopPassport,
  storeGarmentFingerprint,
} from "./passport-write.ts";
import { appendAuthenticityEvent } from "./passport-authenticity.ts";
import { writeGradeToClosetItem } from "./closet-grade-link.ts";
import { notifyAuthenticityFlagged } from "./authenticity-notify.ts";
import { authenticityGateStatus } from "./authenticity-eval.ts";
import { detectPhotoReuse, originalPhotosVerified } from "./photo-reuse.ts";
import {
  evaluateLiveCapture,
  evaluateVerifiedCapture,
  evaluateVideoCapture,
  liveCaptureBoost,
  verifiedCaptureBoost,
} from "./verified-capture.ts";
import { buildCertIntegrity } from "./cert-integrity.ts";
import {
  fuseTamperSignals,
  runForensicPass,
  type ForensicInputImage,
} from "./forensics.ts";
import {
  evaluateImageQuality,
  fabricCloseupMissingFor,
  REQUIRED_IMAGE_TYPES,
} from "./image-quality.ts";
import { withImageBufferSlot } from "./grading-capacity.ts";
import { grantReward, hasFullGradeCoverage } from "./rewards-engine.ts";
import { mediaTypeForVision, uint8ToBase64 } from "./grading-image-encoding.ts";
// Re-exported because grading-media-type_test.ts imports it from here and the
// function is the same function; moving the home should not move the test.
export { mediaTypeForVision };
import { captureServer } from "./posthog.ts";
import { emitEvent, firstOccurrenceKey } from "./user-events.ts";
import { autoRefundPaidStripe } from "./grade-refund.ts";
import {
  notifyGradeFinalized,
  notifyGradePreliminary,
  notifyGradingFailed,
  notifyGradingIncomplete,
} from "./grading-lifecycle-notify.ts";
import { recordAiUsage, type AiTokenUsage } from "./ai-usage.ts";
import {
  extractTagGroundTruth,
  GRADING_TAG_PHOTO_TYPES,
  type TagOcrResult,
} from "./ai-tag-ocr.ts";
import {
  acceptedTagFields,
  buildPersistedTagRead,
  tagDiscrepancies,
  tagGroundTruthBlock,
  tagOcrGradingEnabled,
} from "./tag-ground-truth.ts";
import {
  assessRegisteredNumber,
  getRegisteredNumberContext,
  recordRegisteredNumberSighting,
  type RegisteredNumberAssessment,
} from "./registered-numbers.ts";
import {
  eraDecoderConflict,
  matchTagEra,
  normalizeTagEras,
  tagEraReferenceBlock,
  type EraDecoderConflict,
  type MatchedTagEra,
  type TagEra,
} from "./tag-era.ts";
import {
  decoderSpecsFromPack,
  resolveBrandKnowledgePack,
  type BrandKnowledgePack,
} from "./brand-knowledge.ts";
import { crossCheckDecodeResult, decodeTagCode } from "./brand-decoders.ts";
import { getAuthenticityReferences } from "./authenticity-references.ts";
import { brandKey } from "./brand-normalize.ts";
import { estimateSize, type SizeEstimate } from "./ai-size-estimate.ts";
import { isMeasurementPhoto } from "./ai-size-estimate-core.ts";
import {
  resolveSizeVerification,
  sizeVerifyGradingEnabled,
  type SizeVerification,
} from "./grading-size.ts";
import { decideEscalation, getCascadeConfig } from "./model-routing.ts";
import {
  computeCoverage,
  type CoverageImageSignal,
  type CoverageResult,
} from "./coverage.ts";
import {
  type Capture360Report,
  evaluateVerified360,
  verified360Boost,
} from "./verified-360.ts";

// uint8ToBase64 and mediaTypeForVision moved to grading-image-encoding.ts in
// US-2443. They had already been copied once (into grading-eval.ts, under a
// comment saying so) and the per-image shadow path would have made it a third.

// US-1035: crop a normalized-bbox defect region from a full-res image, padded
// for context and upscaled if tiny, so the vision model sees real detail on a
// small defect instead of a sub-pixel speck. Returns JPEG bytes, or null on any
// decode/crop failure (the zoom for that defect is then skipped).
const ZOOM_PAD_FRAC = 0.3; // context around the defect box
// US-2154: 320px was far below the vision model's usable resolution (~1568px),
// so a magnified defect crop was still handed to the model as a thumbnail. Raise
// the upscale floor so a small crop actually fills real pixels, and cap the long
// edge so a large region stays token-bounded (the crop-tool cookbook's magnify
// insight, both directions). Crops sit between [ZOOM_MIN_PX, ZOOM_MAX_PX].
const ZOOM_MIN_PX = 768; // upscale crops whose long edge is below this
const ZOOM_MAX_PX = 1536; // downscale crops whose long edge exceeds this
const ZOOM_MAX_DOWNLOADS = 4; // cap distinct originals fetched per submission

async function cropDefectRegion(
  bytes: Uint8Array,
  bbox: [number, number, number, number],
): Promise<Uint8Array | null> {
  try {
    const img = await Image.decode(bytes);
    const W = img.width;
    const H = img.height;
    let [x, y, w, h] = bbox;
    const padW = w * ZOOM_PAD_FRAC;
    const padH = h * ZOOM_PAD_FRAC;
    x = Math.max(0, x - padW);
    y = Math.max(0, y - padH);
    w = Math.min(1 - x, w + 2 * padW);
    h = Math.min(1 - y, h + 2 * padH);
    const px = Math.max(0, Math.min(W - 1, Math.round(x * W)));
    const py = Math.max(0, Math.min(H - 1, Math.round(y * H)));
    let pw = Math.max(1, Math.round(w * W));
    let ph = Math.max(1, Math.round(h * H));
    pw = Math.min(pw, W - px);
    ph = Math.min(ph, H - py);
    if (pw < 2 || ph < 2) return null;
    const crop = img.clone().crop(px, py, pw, ph);
    const longEdge = Math.max(crop.width, crop.height);
    // US-2154: magnify a tiny crop up to the floor, or shrink an oversized one to
    // the cap, so the re-analysis sees real detail without wasting tokens.
    const scale = longEdge < ZOOM_MIN_PX
      ? ZOOM_MIN_PX / longEdge
      : longEdge > ZOOM_MAX_PX
      ? ZOOM_MAX_PX / longEdge
      : 1;
    if (scale !== 1) {
      crop.resize(
        Math.max(1, Math.round(crop.width * scale)),
        Math.max(1, Math.round(crop.height * scale)),
      );
    }
    return await crop.encodeJPEG(92);
  } catch {
    return null;
  }
}

interface ZoomImageRow {
  image_type: string;
  storage_path: string;
  original_storage_path?: string | null;
  // US-2135 AC2: the measured 0..1 sharpness (US-2136, migration 00568). Null
  // on any row written before that landed, and null never selects.
  quality_score?: number | null;
}

/**
 * US-1035: re-analyze small / low-confidence defects at high resolution. For each
 * selected defect, crop its region from the retained ORIGINAL (or the stored
 * image) and run a focused per-image analysis on the crop, then merge the
 * higher-fidelity size/severity read back. Best-effort and bounded: capped at a
 * few zooms, downloads cached, and any failure leaves the original read intact —
 * a zoom must never fail a paid grade. Returns the (possibly) updated results.
 */
async function runDefectZoomPass(
  perImageResults: PerImageAnalysis[],
  images: ZoomImageRow[],
  submission: { garment_type: string; garment_category: string },
  styleHint: string[],
  // US-896: stable canary bucket key so the zoom re-analysis uses the SAME
  // (active vs canary) per-image prompt the submission was graded with.
  bucketKey?: string,
  // US-1066: the model the submission is being graded on for this pass (cascade
  // first-pass model, or the escalation model on a re-grade). Undefined → default.
  modelOverride?: string,
): Promise<PerImageAnalysis[]> {
  const candidates = selectDefectsForZoom(perImageResults);
  if (candidates.length === 0) return perImageResults;

  // image_type → best source (prefer the retained uncompressed original).
  const srcByType = new Map<string, string>();
  for (const img of images) {
    if (img.storage_path && !srcByType.has(img.image_type)) {
      srcByType.set(img.image_type, img.original_storage_path || img.storage_path);
    }
  }

  // Copy so we never mutate the array element identities mid-pass.
  const updated = perImageResults.map((r) => ({
    ...r,
    detected_issues: r.detected_issues.map((d) => ({ ...d })),
  }));
  const byType = new Map(updated.map((r) => [r.image_type, r]));
  const bytesCache = new Map<string, Uint8Array | null>();

  for (const cand of candidates) {
    try {
      const srcPath = srcByType.get(cand.image_type);
      if (!srcPath) continue;
      let bytes = bytesCache.get(srcPath);
      if (bytes === undefined) {
        if (bytesCache.size >= ZOOM_MAX_DOWNLOADS) continue;
        const { data: blob, error } = await supabaseAdmin.storage
          .from("submission-images")
          .download(srcPath);
        bytes = error || !blob ? null : new Uint8Array(await blob.arrayBuffer());
        bytesCache.set(srcPath, bytes);
      }
      if (!bytes) continue;
      const cropBytes = await cropDefectRegion(bytes, cand.bbox);
      if (!cropBytes) continue;
      const dataUri = `data:image/jpeg;base64,${uint8ToBase64(cropBytes)}`;
      const zoom = await analyzeImage(
        dataUri,
        "defect",
        submission.garment_type,
        submission.garment_category,
        styleHint,
        undefined,
        modelOverride,
        bucketKey,
      );
      const target = byType.get(cand.image_type);
      const issue = target?.detected_issues[cand.issueIndex];
      if (target && issue) {
        target.detected_issues[cand.issueIndex] = mergeZoomIntoIssue(issue, zoom);
      }
    } catch (err) {
      console.error(
        `[Pipeline] defect zoom failed (${cand.image_type}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return updated;
}

// US-2154: re-encode a full retained ORIGINAL for a whole-image re-read (label
// legibility / authenticity). Magnifies a small original up to the floor and
// caps a large one, mirroring cropDefectRegion's sizing. Returns JPEG bytes or
// null on any decode failure (the re-read for that image is then skipped).
async function reencodeOriginalForReread(
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const img = await Image.decode(bytes);
    const longEdge = Math.max(img.width, img.height);
    const scale = longEdge > ZOOM_MAX_PX
      ? ZOOM_MAX_PX / longEdge
      : longEdge < ZOOM_MIN_PX
      ? ZOOM_MIN_PX / longEdge
      : 1;
    if (scale !== 1) {
      img.resize(
        Math.max(1, Math.round(img.width * scale)),
        Math.max(1, Math.round(img.height * scale)),
      );
    }
    return await img.encodeJPEG(92);
  } catch {
    return null;
  }
}

/**
 * US-2154: high-res re-read of illegible labels (recover the fiber composition
 * that feeds the composite's fabric criteria) and possibly-manipulated photos
 * (sharpen the tamper tells before the grade is held for review). Re-reads the
 * retained ORIGINAL of the flagged image with the existing per-image prompt, then
 * merges the sharper read back. Same best-effort + bounded contract as the defect
 * zoom: capped candidates, downloads cached/capped, and any failure leaves the
 * first-pass read intact — a re-read must never fail a paid grade.
 */
async function runRereadPass(
  perImageResults: PerImageAnalysis[],
  images: ZoomImageRow[],
  submission: { garment_type: string; garment_category: string },
  styleHint: string[],
  bucketKey?: string,
  modelOverride?: string,
): Promise<PerImageAnalysis[]> {
  const labelCands = selectLabelsForReread(perImageResults);
  const authCands = selectImagesForAuthenticityReread(perImageResults);
  // US-2135 AC2: a soft authenticity macro. Selected off the MEASURED sharpness
  // on the row rather than off anything the first pass said — see
  // selectMacrosForReread for why that is the only signal available here
  // without serialising a second vision call on the paid path.
  const macroCands = selectMacrosForReread(images);
  if (
    labelCands.length === 0 && authCands.length === 0 && macroCands.length === 0
  ) {
    return perImageResults;
  }

  // image_type → best source (prefer the retained uncompressed original).
  const srcByType = new Map<string, string>();
  for (const img of images) {
    if (img.storage_path && !srcByType.has(img.image_type)) {
      srcByType.set(img.image_type, img.original_storage_path || img.storage_path);
    }
  }

  const updated = perImageResults.map((r) => ({ ...r }));
  const byType = new Map(updated.map((r) => [r.image_type, r]));
  const bytesCache = new Map<string, Uint8Array | null>();
  const rereadCache = new Map<string, PerImageAnalysis | null>();

  // Re-read one image's original at high resolution (cached per image_type so a
  // label that's both illegible AND flagged only costs one extra vision call).
  const rereadImage = async (
    image_type: string,
  ): Promise<PerImageAnalysis | null> => {
    if (rereadCache.has(image_type)) return rereadCache.get(image_type) ?? null;
    let result: PerImageAnalysis | null = null;
    const srcPath = srcByType.get(image_type);
    if (srcPath) {
      let bytes = bytesCache.get(srcPath);
      if (bytes === undefined && bytesCache.size < ZOOM_MAX_DOWNLOADS) {
        const { data: blob, error } = await supabaseAdmin.storage
          .from("submission-images")
          .download(srcPath);
        bytes = error || !blob ? null : new Uint8Array(await blob.arrayBuffer());
        bytesCache.set(srcPath, bytes);
      }
      if (bytes) {
        const encoded = await reencodeOriginalForReread(bytes);
        if (encoded) {
          const dataUri = `data:image/jpeg;base64,${uint8ToBase64(encoded)}`;
          result = await analyzeImage(
            dataUri,
            image_type,
            submission.garment_type,
            submission.garment_category,
            styleHint,
            undefined,
            modelOverride,
            bucketKey,
          );
        }
      }
    }
    rereadCache.set(image_type, result);
    return result;
  };

  for (const cand of labelCands) {
    try {
      const rr = await rereadImage(cand.image_type);
      const target = byType.get(cand.image_type);
      if (rr && target) Object.assign(target, mergeLabelReread(target, rr));
    } catch (err) {
      console.error(
        `[Pipeline] label re-read failed (${cand.image_type}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  for (const cand of authCands) {
    try {
      const rr = await rereadImage(cand.image_type);
      const target = byType.get(cand.image_type);
      if (rr && target) Object.assign(target, mergeAuthenticityReread(target, rr));
    } catch (err) {
      console.error(
        `[Pipeline] authenticity re-read failed (${cand.image_type}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  // US-2135 AC2: soft authenticity macros. Merged through
  // mergeAuthenticityReread, the SAME one-directional merge the flagged-photo
  // path uses, and that is deliberate rather than convenient — a sharper look
  // at a serial may corroborate a tell but must never launder one away. The
  // grading invariant is "when in doubt, LESS confident, never more", and a
  // re-read is exactly the moment someone would be tempted to relax it because
  // the second look was better evidence. It is better evidence for FINDING
  // something, not for clearing it.
  //
  // rereadImage is cached per image_type, so a macro that is both soft AND
  // flagged as manipulated still costs one extra vision call, not two.
  for (const cand of macroCands) {
    try {
      const rr = await rereadImage(cand.image_type);
      const target = byType.get(cand.image_type);
      if (rr && target) Object.assign(target, mergeAuthenticityReread(target, rr));
    } catch (err) {
      console.error(
        `[Pipeline] macro re-read failed (${cand.image_type}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return updated;
}

// US-1066: re-grade a submission on the (stronger) escalation model after a
// low-confidence / high-value first pass. Re-downloads + re-analyzes every image
// on the escalation model (under the same memory gate), re-runs the defect-zoom
// pass on that model, and re-composites. Returns the escalated per-image +
// composite results, or null when escalation can't produce a usable grade (a
// required-angle re-analysis failed, or the composite errored) — in which case
// the caller keeps the first-pass grade. Never lets an escalation failure fail
// the paid grade. The escalation is the low-confidence minority, so the extra
// download + AI cost is bounded; the savings come from the confident majority
// that never reaches here.
async function escalateGrade(
  images: ZoomImageRow[],
  submission: { garment_type: string; garment_category: string },
  garmentInfo: GarmentInfo,
  styleHint: string[],
  submissionId: string,
  model: string,
  // US-1296: only re-run the paid defect-zoom pass on escalation when the
  // Forensic add-on was purchased — mirrors the gate on the first-pass path.
  wantForensic: boolean,
  // US-1533: the baseline block the first pass used — escalation grades the
  // same item, so it sees the same trusted reference ("" → unchanged).
  baselineBlock = "",
  // US-2210: likewise the label transcription. The escalation re-runs the whole
  // per-image pass on the stronger model but does NOT re-read the tag — a
  // verbatim transcription does not get truer on a bigger model, and paying for
  // a second vision call to re-read the same label would be the escalation
  // spending money to learn what it already knows.
  tagBlock = "",
): Promise<
  {
    perImageResults: PerImageAnalysis[];
    compositeResult: CompositeGradeResult;
    // US-1642: whether the escalation dropped an optional image (→ partial cap).
    partialSuccess: boolean;
  } | null
> {
  const settled = await withImageBufferSlot(async () => {
    const imageDataPromises = images.map(async (image) => {
      const { data: fileData, error: downloadError } = await supabaseAdmin.storage
        .from("submission-images")
        .download(image.storage_path);
      if (downloadError || !fileData) {
        throw new Error(`Failed to download image: ${image.storage_path}`);
      }
      const arrayBuffer = await fileData.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const base64 = uint8ToBase64(bytes);
      const mediaType = mediaTypeForVision(bytes, image.storage_path);
      return {
        imageType: image.image_type,
        dataUri: `data:${mediaType};base64,${base64}`,
      };
    });

    const imageData = await Promise.all(imageDataPromises);
    const perImagePromises = imageData.map((img) =>
      analyzeImage(
        img.dataUri,
        img.imageType,
        submission.garment_type,
        submission.garment_category,
        styleHint,
        undefined,
        model,
        submissionId,
        baselineBlock,
      )
    );
    const results = await Promise.allSettled(perImagePromises);
    return results.map((s, i): SettledImage => ({
      imageType: imageData[i].imageType,
      result: s.status === "fulfilled" ? s.value : null,
    }));
  });

  const { usable, failedRequired, failedOptional } = partitionImageResults(
    settled,
    REQUIRED_IMAGE_TYPES,
  );
  // A required angle failed to re-analyze (or nothing succeeded) — abandon the
  // escalation and keep the first-pass grade rather than ship a worse one.
  if (failedRequired.length > 0 || usable.length === 0) return null;

  let perImageResults = usable;
  if (wantForensic) {
    perImageResults = await runDefectZoomPass(
      perImageResults,
      images,
      submission,
      styleHint,
      submissionId,
      model,
    ).catch(() => perImageResults);
    // US-2154: label-legibility + authenticity re-read (same paid gate).
    perImageResults = await runRereadPass(
      perImageResults,
      images,
      submission,
      styleHint,
      submissionId,
      model,
    ).catch(() => perImageResults);
  }

  const compositeResult = await compositeGrade(
    perImageResults,
    garmentInfo,
    undefined,
    model,
    submissionId,
    baselineBlock,
    // US-1537: escalation stays text-only by design (see the first-pass call).
    [],
    false,
    tagBlock,
    // US-2397: recomputed from THIS pass's analyzed set, not inherited from the
    // first one — the escalation can drop an optional detail image, and an
    // escalated grade must never be the way an uncapped fabric guess ships.
    fabricCloseupMissingFor(perImageResults.map((r) => r.image_type)),
  );
  // US-1642: surface whether the ESCALATION dropped an optional image. The
  // caller ORs this into partialSuccess so a defect/detail image that failed to
  // re-analyze on the escalation model still applies the partial-image cap +
  // forced review, instead of shipping an incomplete escalated grade uncapped.
  return {
    perImageResults,
    compositeResult,
    partialSuccess: failedOptional.length > 0,
  };
}

/**
 * Processes a submission through the full grading pipeline:
 * 1. Fetch submission record and images from DB
 * 2. Download images from storage and convert to base64
 * 3. Run analyzeImage() on each image in parallel
 * 4. Run compositeGrade() with all per-image results
 * 5. Create grade_report record with scores and AI summary
 * 6. Update submission status to 'completed' (or 'failed' on error)
 * 7. Return the created grade report
 */
// Reverse the charge taken BEFORE the pipeline ran (runPaymentPrecedence in
// grade.ts / the FlipDesk grading path) whenever a submission ends up WITHOUT a
// grade — whether the pipeline failed (catch) or the image-quality gate
// abstained (US-332). Included grades go back to the monthly bundle; credit
// grades are re-granted. Idempotent via submissions.refunded_at, so calling it
// for an abstention and again on a later failure is safe. One-time Stripe
// payments can't be reversed by minting credits — they surface here for manual
// handling. Never throws — a refund hiccup must not mask the original outcome.
export async function reverseChargeForUngradedSubmission(
  submissionId: string,
  reason: string,
): Promise<void> {
  try {
    const { data: refundResult, error: refundError } = await supabaseAdmin.rpc(
      "refund_grade",
      { p_submission_id: submissionId },
    );
    if (refundError) {
      console.error(
        `[Pipeline] REFUND FAILED for submission ${submissionId} (${reason}) — manual review needed:`,
        refundError.message,
      );
    } else if (refundResult === "no_refund_paid_stripe") {
      // US-771: a real-money per-grade payment with no grade — issue the Stripe
      // refund automatically (idempotent), or queue it for an operator on
      // failure. Never throws.
      await autoRefundPaidStripe(submissionId, reason);
    } else {
      console.log(
        `[Pipeline] Refund for submission ${submissionId} (${reason}): ${refundResult}`,
      );
    }
  } catch (refundErr) {
    console.error(
      `[Pipeline] Refund error for submission ${submissionId} (${reason}) — manual review needed:`,
      refundErr instanceof Error ? refundErr.message : String(refundErr),
    );
  }
}

// US-569: grading durability knobs.
//
// LEASE_SECONDS — how long one grade run owns the row before it's presumed dead
// and re-claimable. Must comfortably exceed worst-case grade wall-time (AI
// timeout ~120s + retries), but short enough that a crashed grade resumes
// reasonably soon. MAX_ATTEMPTS — how many times a poison submission (one that
// crashes the container every run) is resumed before the reaper fails + refunds
// it for good. Both must match the values the reaper uses (stuck-submissions.ts).
// US-2570: how many times a grade_reports insert may regenerate its certificate
// number before giving up. Three is not a tuning knob so much as a sanity bound:
// two independent collisions in a row is ~1e-9 at current volume, so a third
// failure means something other than chance and should surface as an error
// rather than be retried into a loop.
export const CERT_NUMBER_INSERT_ATTEMPTS = 3;

export function gradingLeaseSeconds(): number {
  const raw = Number(Deno.env.get("GRADING_LEASE_SECONDS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 900; // 15 min
}
export function gradingMaxAttempts(): number {
  const raw = Number(Deno.env.get("GRADING_MAX_ATTEMPTS"));
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 3;
}

// US-569 (was US-773): the atomic grading claim, extracted (with an injectable
// updater) so the lease/idempotency logic is unit-testable without a DB. The
// default updater calls the claim_grade_lease RPC (migration 00161): a single
// conditional UPDATE that LEASES a gradeable row to one caller. Of N concurrent
// kicks exactly one gets 'claimed'; the rest see the live lease (or an existing
// report) and no-op. Because the lease EXPIRES, a crashed run can be re-claimed
// and resumed later — the difference from the old set-once grading_started_at.
//
// The RPC returns the rich codes claimed | done | leased | exhausted | gone; the
// caller only needs four outcomes, so we collapse leased/exhausted/gone into the
// single no-op "already" (the reaper does its own attempt accounting):
//
//   "claimed" → we own the grade run
//   "done"    → an active report already exists → finalize, don't re-grade
//   "already" → a live lease / poison / terminal row → no-op
//   "error"   → transient DB error claiming → caller reports it
export type GradingClaimResult = "claimed" | "done" | "already" | "error";

// RPC status → caller outcome.
type RpcClaimStatus = "claimed" | "done" | "leased" | "exhausted" | "gone";

export type GradingClaimUpdater = (submissionId: string) => Promise<{
  // 'status' is the rich RPC result. 'row' is kept for backward-compatible fakes
  // that only model the claimed/not-claimed (set-once) contract — a non-null row
  // is treated as 'claimed', a null row as 'already' (no-op).
  status?: RpcClaimStatus;
  row?: { id: string } | null;
  error: { message?: string } | null;
}>;

const defaultGradingClaimUpdater: GradingClaimUpdater = async (submissionId) => {
  const { data, error } = await supabaseAdmin.rpc("claim_grade_lease", {
    p_submission_id: submissionId,
    p_lease_seconds: gradingLeaseSeconds(),
    p_max_attempts: gradingMaxAttempts(),
  });
  return { status: (data as RpcClaimStatus | null) ?? undefined, error };
};

export async function claimSubmissionForGrading(
  submissionId: string,
  update: GradingClaimUpdater = defaultGradingClaimUpdater,
): Promise<GradingClaimResult> {
  const { status, row, error } = await update(submissionId);
  if (error) return "error";
  if (status) return status === "claimed" || status === "done" ? status : "already";
  // Backward-compat for row-shaped fakes (the old set-once model).
  return row ? "claimed" : "already";
}

// US-479: admin reject-and-regrade. The old admin "re-trigger grading" action
// was a DIRECT browser write that flipped status to 'processing' and stopped —
// nothing re-ran the pipeline, so the submission hung in 'processing' forever
// (no worker). This re-invokes the grading pipeline server-side and SUPERSEDES
// the prior report.
//
// The orchestration is extracted behind an injectable store so the supersede →
// reset → re-kick contract is unit-testable WITHOUT a DB or a live Claude call
// (mirrors the AbandonedSweepStore idiom in stuck-submissions.ts). The default
// store wires it to supabaseAdmin + processSubmission.
export interface RegradeStore {
  /** The submission to regrade, or null if it doesn't exist. */
  loadSubmission: (
    submissionId: string,
  ) => Promise<{ id: string; status: string | null; title: string | null } | null>;
  /**
   * Mark every ACTIVE (superseded_at IS NULL) report for the submission as
   * superseded and withhold its certificate (null certificate_id) so the stale
   * public certificate stops verifying. Returns the superseded report ids.
   * Non-destructive — referencing disputes/human_reviews/grade_outcomes survive.
   */
  supersedePriorReports: (submissionId: string) => Promise<string[]>;
  /**
   * Reset the submission so the pipeline's atomic claim (grading_started_at IS
   * NULL + status pending/processing) will pick it up again on the re-kick.
   * Clears any prior abstention feedback + moderation flag.
   */
  resetForRegrade: (submissionId: string) => Promise<void>;
  /** Re-invoke the grading pipeline (the in-process worker). */
  kick: (submissionId: string) => Promise<void> | void;
}

export type RegradeResult =
  | { ok: true; supersededReportIds: string[]; previousStatus: string | null; title: string | null }
  | { ok: false; status: number; error: string };

export async function regradeSubmission(
  submissionId: string,
  store: RegradeStore,
): Promise<RegradeResult> {
  const submission = await store.loadSubmission(submissionId);
  if (!submission) {
    return { ok: false, status: 404, error: "Submission not found" };
  }

  // Supersede BEFORE the re-kick so the about-to-be-created report is the only
  // active one the moment the pipeline inserts it.
  const supersededReportIds = await store.supersedePriorReports(submissionId);

  // Reset so the pipeline can re-claim the row. After this the submission is
  // 'pending' (not stuck in 'processing' with no worker): the re-kick runs the
  // pipeline to a terminal status, and the stuck/stranded-paid sweeps are the
  // backstop if the container dies mid-grade.
  await store.resetForRegrade(submissionId);

  await store.kick(submissionId);

  return {
    ok: true,
    supersededReportIds,
    previousStatus: submission.status,
    title: submission.title,
  };
}

// Default store: supabaseAdmin reads/writes + processSubmission re-kick.
export const defaultRegradeStore: RegradeStore = {
  loadSubmission: async (submissionId) => {
    const { data } = await supabaseAdmin
      .from("submissions")
      .select("id, status, title")
      .eq("id", submissionId)
      .maybeSingle();
    return (
      (data as { id: string; status: string | null; title: string | null } | null) ?? null
    );
  },
  supersedePriorReports: async (submissionId) => {
    // US-2569: read the CERTIFIED FACTS FIRST. The update below nulls
    // certificate_id, and once it has there is nothing left to record — the
    // number a buyer has printed on a hangtag would be unrecoverable, which is
    // precisely the state that made a regraded certificate 404.
    const { data: active } = await supabaseAdmin
      .from("grade_reports")
      .select(
        "id, certificate_id, certificate_number, overall_score, grade_tier",
      )
      .eq("submission_id", submissionId)
      .is("superseded_at", null);
    const rows = (active ?? []) as Array<{
      id: string;
      certificate_id: string | null;
      certificate_number: string | null;
      overall_score: number | string | null;
      grade_tier: string | null;
    }>;
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      const supersededAt = new Date().toISOString();

      // Record BEFORE retiring, so a crash between the two leaves a revision
      // row pointing at a still-live certificate (harmless — the public path
      // prefers the live report) rather than a retired certificate with no
      // record (a 404 nobody can explain).
      const { error: revErr } = await supabaseAdmin
        .from("grade_report_revisions")
        .upsert(
          rows.map((r) => ({
            submission_id: submissionId,
            superseded_report_id: r.id,
            superseded_certificate_id: r.certificate_id,
            superseded_certificate_number: r.certificate_number,
            superseded_overall_score: r.overall_score,
            superseded_grade_tier: r.grade_tier,
            reason: "regrade",
            superseded_at: supersededAt,
          })),
          // One row per retired report (00600's unique index). A replayed
          // regrade must not raise here and abort the supersede it is part of.
          { onConflict: "superseded_report_id", ignoreDuplicates: true },
        );
      if (revErr) {
        // Non-fatal, and loudly so. The regrade must still proceed — refusing
        // would leave the submission stuck with a stale report — but a missing
        // revision row means that certificate will 404 for good.
        console.error(
          `[Pipeline] REVISION RECORD FAILED for submission ${submissionId} — ` +
            `retired certificate(s) will not resolve: ${revErr.message}`,
        );
        captureException(revErr, {
          route: "grading.supersede",
          extra: { submissionId, reportIds: ids },
        });
      }

      await supabaseAdmin
        .from("grade_reports")
        .update({ superseded_at: supersededAt, certificate_id: null })
        .in("id", ids);
      // Regrade retires the old cert(s) — drop their edge-stored rendered images.
      for (const r of rows) {
        if (r.certificate_id) deleteCertImages(r.certificate_id).catch(() => {});
      }
    }
    return ids;
  },
  resetForRegrade: async (submissionId) => {
    await supabaseAdmin
      .from("submissions")
      .update({
        status: "pending",
        grading_started_at: null,
        // US-569: clear the lease + attempt budget so the re-kick can re-claim.
        // Without this, a submission that previously hit the attempt cap (status
        // 'failed') would claim → 'exhausted' on regrade and never re-run.
        grading_lease_until: null,
        grading_attempts: 0,
        quality_feedback: null,
        flagged: false,
        flag_reason: null,
        moderation_status: null,
      })
      .eq("id", submissionId);
  },
  kick: (submissionId) => {
    // Fire-and-forget; processSubmission's atomic claim guards a concurrent kick.
    processSubmission(submissionId).catch((err) => {
      console.error(
        `[Pipeline] regrade re-kick failed for submission ${submissionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  },
};

// US-569: the terminal "this submission is graded" write, shared by the normal
// completion path and the idempotent resume/finalize path. Advances status to
// 'completed', clears any abstention feedback, RELEASES the grading lease, and
// re-syncs the linked FlipDesk item + grading-bridge rows. Every write is
// idempotent (re-running just re-asserts the same terminal state), so a resume
// after a crash between the report insert and the status flip is safe. Returns
// the linked inventory item id (for the grade-ready deep link), or null.
async function applyTerminalCompletion(
  submissionId: string,
  grade: {
    gradeReportId: string;
    overallScore: number;
    gradeTier: string;
    certificateUrl: string | null;
  },
): Promise<string | null> {
  // Status + lease. Clearing grading_lease_until stops the reaper from ever
  // re-touching a completed row.
  await supabaseAdmin
    .from("submissions")
    .update({ status: "completed", quality_feedback: null, grading_lease_until: null })
    .eq("id", submissionId);

  // Sync a linked inventory item, if any.
  let linkedItemId: string | null = null;
  try {
    const { data: linkedItem, error: linkedErr } = await supabaseAdmin
      .from("inventory_items")
      .select("id, status, user_id")
      .eq("submission_id", submissionId)
      .maybeSingle();
    // US-2007 AC3: the same swallowed-PGRST116 shape as finalizeIfAlreadyGraded.
    // Two items sharing a submission makes maybeSingle() error, and discarding
    // it here would silently skip the item write-back — the grade would be
    // stored but the item would never show its grade_value/grade_label. 00483
    // makes the duplicate impossible; this makes any residual read failure
    // visible instead of looking identical to "no linked item".
    if (linkedErr) {
      captureException(linkedErr, {
        route: "grading-pipeline.syncLinkedItem",
        extra: { submission_id: submissionId, code: linkedErr.code },
      });
    }
    if (linkedItem) {
      linkedItemId = (linkedItem as { id: string }).id;
      const itemUpdate: Record<string, unknown> = {
        grade_report_id: grade.gradeReportId,
        grade_value: grade.overallScore,
        grade_label: grade.gradeTier,
        certificate_url: grade.certificateUrl,
      };
      if ((linkedItem as { status?: string }).status === "grading") {
        itemUpdate.status = "graded";
      }
      await supabaseAdmin
        .from("inventory_items")
        .update(itemUpdate)
        .eq("id", linkedItemId);

      // US-1502: a grade just LANDED (or was CORRECTED by human review — both
      // finalize paths funnel here). If this item already has a LIVE GT-origin
      // eBay listing (list-first-then-grade, or a re-review of a listed item),
      // push the new grade onto it — the Condition Grade item specific + cert
      // line — so the live listing never lacks or overstates the grade. Best-
      // effort + lazily imported to avoid a routes→lib static cycle; a failure
      // here must NEVER break grade completion.
      const ownerId = (linkedItem as { user_id?: string }).user_id;
      if (ownerId) {
        try {
          const { resyncGradeToLiveListing } = await import(
            "../routes/flipdesk-ebay.ts"
          );
          const r = await resyncGradeToLiveListing(ownerId, linkedItemId);
          if (r.resynced) {
            console.log(
              `[Pipeline] grade resynced to live eBay listing for item ${linkedItemId}`,
            );
          }
        } catch (resyncErr) {
          console.error(
            `[Pipeline] grade→listing resync error for item ${linkedItemId} (non-fatal):`,
            resyncErr instanceof Error ? resyncErr.message : String(resyncErr),
          );
        }
      }
    }
  } catch (itemErr) {
    console.error(
      `[Pipeline] Inventory item sync error for submission ${submissionId}:`,
      itemErr instanceof Error ? itemErr.message : String(itemErr),
    );
  }

  // Sync the linked flipdesk_grading_submissions bridge row, if any.
  try {
    const nowIso = new Date().toISOString();
    const { data: fdLink } = await supabaseAdmin
      .from("flipdesk_grading_submissions")
      .select("id")
      .eq("submission_id", submissionId)
      .maybeSingle();
    if (fdLink) {
      await supabaseAdmin
        .from("flipdesk_grading_submissions")
        .update({ status: "completed", graded_at: nowIso, webhook_received_at: nowIso })
        .eq("id", (fdLink as { id: string }).id);
    }
  } catch (fdErr) {
    console.error(
      `[Pipeline] FlipDesk grading sync error for submission ${submissionId}:`,
      fdErr instanceof Error ? fdErr.message : String(fdErr),
    );
  }

  return linkedItemId;
}

// Mandatory review: park a freshly-graded submission in `pending_review` without
// going live. Releases the grading lease + clears abstention feedback (so the
// reaper leaves it alone), but does NOT advance to 'completed', sync the linked
// item to 'graded', or publish the certificate — that all waits for a human to
// finalize the grade (finalizeGradeReview). Returns the linked inventory item id
// (for the preliminary deep link), or null.
async function applyPreliminaryReview(submissionId: string): Promise<string | null> {
  await supabaseAdmin
    .from("submissions")
    .update({ status: "pending_review", quality_feedback: null, grading_lease_until: null })
    .eq("id", submissionId);

  let linkedItemId: string | null = null;
  try {
    const { data: linkedItem } = await supabaseAdmin
      .from("inventory_items")
      .select("id")
      .eq("submission_id", submissionId)
      .maybeSingle();
    if (linkedItem) linkedItemId = (linkedItem as { id: string }).id;
  } catch (itemErr) {
    console.error(
      `[Pipeline] Inventory item lookup error for submission ${submissionId}:`,
      itemErr instanceof Error ? itemErr.message : String(itemErr),
    );
  }

  // Reflect the preliminary state on the FlipDesk bridge row so the in-app /
  // web status poll shows "submitted for human review" instead of an endless
  // "grading in progress" — the grade is DONE, it's just awaiting a human to
  // finalize it. applyTerminalCompletion flips this to 'completed' on finalize.
  try {
    const { data: fdLink } = await supabaseAdmin
      .from("flipdesk_grading_submissions")
      .select("id")
      .eq("submission_id", submissionId)
      .maybeSingle();
    if (fdLink) {
      await supabaseAdmin
        .from("flipdesk_grading_submissions")
        .update({ status: "pending_review" })
        .eq("id", (fdLink as { id: string }).id);
    }
  } catch (fdErr) {
    console.error(
      `[Pipeline] FlipDesk preliminary bridge sync error for submission ${submissionId}:`,
      fdErr instanceof Error ? fdErr.message : String(fdErr),
    );
  }

  return linkedItemId;
}

export interface FinalizeGradeReviewResult {
  ok: boolean;
  alreadyFinal?: boolean;
  linkedItemId?: string | null;
}

// Mandatory review: a human reviewer (super-admin/reviewer) has approved or
// adjusted the grade — make it OFFICIAL. This is the one place the deferred
// "go-live" wiring runs: flip the report to approved/modified + stamp the
// reviewer, advance the submission to 'completed', sync the linked item to
// 'graded' + publish the certificate (applyTerminalCompletion), fire the drip /
// activation events, ping IndexNow, deliver external webhooks with the FINAL
// grade, and tell the seller their grade is final + live.
//
// Idempotent: a report that's already finalized is a no-op (so a double-click /
// retry never double-fires go-live or duplicate notifications). The adjust path
// has already written the new scores + resealed the certificate BEFORE calling
// this; approve leaves the AI scores untouched.
export async function finalizeGradeReview(
  reportId: string,
  // reviewerId is null for an AUTO-APPROVED grade (no human reviewer); a string
  // when a super-admin/reviewer finalized it. reviewed_by null + approved is the
  // derivable "auto-approved" marker.
  opts: { reviewerId: string | null; modified: boolean },
): Promise<FinalizeGradeReviewResult> {
  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select("id, submission_id, overall_score, grade_tier, certificate_id, finalized_at")
    .eq("id", reportId)
    .maybeSingle();
  if (!report) return { ok: false };

  const r = report as {
    id: string;
    submission_id: string;
    overall_score: number;
    grade_tier: string;
    certificate_id: string | null;
    finalized_at: string | null;
  };
  // Already finalized — don't re-run go-live or re-notify.
  if (r.finalized_at) return { ok: true, alreadyFinal: true };

  const overallScore = Number(r.overall_score);
  const nowIso = new Date().toISOString();
  // US-1643: gate go-live on the finalize UPDATE actually succeeding. Previously
  // its {error} was ignored, so a transient DB failure would leave the report
  // UN-finalized yet still run go-live (public cert + item completion + FINAL
  // notifications). The `.is("finalized_at", null)` filter also makes this
  // atomic: exactly ONE finalize flips the row and proceeds, so a concurrent /
  // retried call can't double-fire go-live.
  const { data: finalized, error: finalizeErr } = await supabaseAdmin
    .from("grade_reports")
    .update({
      review_status: opts.modified ? "modified" : "approved",
      finalized_at: nowIso,
      reviewed_by: opts.reviewerId,
      reviewed_at: nowIso,
      human_reviewed: true,
      needs_human_review: false,
      review_claimed_by: null,
      review_claimed_at: null,
    })
    .eq("id", r.id)
    .is("finalized_at", null)
    .select("id")
    .maybeSingle();
  if (finalizeErr) {
    console.error(
      `[Pipeline] finalizeGradeReview UPDATE failed for report ${r.id} — NOT going live: ${finalizeErr.message}`,
    );
    return { ok: false };
  }
  if (!finalized) {
    // A concurrent finalize won the race and is (or already) running go-live —
    // don't double-fire.
    return { ok: true, alreadyFinal: true };
  }

  const certUrl = r.certificate_id ? certificateUrl(r.certificate_id) : null;
  const linkedItemId = await applyTerminalCompletion(r.submission_id, {
    gradeReportId: r.id,
    overallScore,
    gradeTier: r.grade_tier,
    certificateUrl: certUrl,
  });

  const { data: sub } = await supabaseAdmin
    .from("submissions")
    .select("user_id, title")
    .eq("id", r.submission_id)
    .maybeSingle();
  const s = sub as { user_id: string; title: string | null } | null;

  if (s?.user_id) {
    // Drip / activation events (moved from the preliminary pipeline path —
    // "completed" means finalized). first_grade is once-per-user.
    void emitEvent(s.user_id, "grade_completed", {
      properties: { grade_report_id: r.id, overall_score: overallScore },
    });
    void emitEvent(s.user_id, "first_grade", {
      dedupeKey: firstOccurrenceKey("first_grade", s.user_id),
    });

    // External webhooks get the FINAL grade.
    notifyWebhooks(s.user_id, r.submission_id, report as Record<string, unknown>).catch(
      (err) =>
        console.error(
          `[Pipeline] Webhook delivery error for submission ${r.submission_id}:`,
          err instanceof Error ? err.message : String(err),
        ),
    );
  }

  // The certificate is public now — ping IndexNow (no-op without INDEXNOW_KEY).
  if (r.certificate_id) {
    submitUrls([certificateUrl(r.certificate_id)]).catch((e) =>
      console.warn("[Pipeline] IndexNow submit failed:", e),
    );
  }

  // Tell the seller their grade is final + live (email + in-app).
  if (s?.user_id) {
    const link = linkedItemId
      ? `/dashboard/flipdesk/items/${linkedItemId}`
      : `/dashboard/submissions/${r.submission_id}`;
    void notifyGradeFinalized(
      s.user_id,
      s.title,
      `Final grade ${overallScore.toFixed(1)} · ${r.grade_tier}.`,
      link,
    );
    (async () => {
      try {
        const { data: user } = await supabaseAdmin
          .from("users")
          .select("email, full_name, notification_preferences")
          .eq("id", s.user_id)
          .single();
        const emailEnabled =
          user?.notification_preferences?.grade_complete?.email !== false;
        if (user?.email && emailEnabled) {
          await sendGradeFinalizedEmail(user.email, {
            userName: user.full_name || "there",
            submissionTitle: s.title ?? "Your submission",
            overallScore,
            gradeTier: r.grade_tier,
            submissionId: r.submission_id,
            certificateId: r.certificate_id,
            wasModified: opts.modified,
            itemLink: linkedItemId ? `/dashboard/flipdesk/items/${linkedItemId}` : null,
          });
        }
      } catch (e) {
        console.error(
          `[Pipeline] Finalized email error for submission ${r.submission_id}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    })();
  }

  console.log(
    `[Pipeline] Grade FINALIZED (${opts.modified ? "modified" : "approved"}) for submission ${r.submission_id}`,
  );
  return { ok: true, linkedItemId };
}

// US-569: idempotent resume. When a kick finds an already-graded submission (a
// crash landed between the grade_report insert and the status flip), re-assert
// the correct terminal state WITHOUT re-running or re-billing the AI. With
// mandatory review the pipeline's own terminal state is now `pending_review`
// (NOT completed) — go-live only happens via finalizeGradeReview — so resume
// just re-parks a not-yet-finalized grade in pending_review, and re-finishes the
// go-live wiring only for a grade that was already finalized. Returns true if an
// active report existed, false if there's nothing to do (the normal no-op).
export async function finalizeIfAlreadyGraded(submissionId: string): Promise<boolean> {
  const { data: report, error: reportErr } = await supabaseAdmin
    .from("grade_reports")
    .select("id, overall_score, grade_tier, certificate_id, review_status")
    .eq("submission_id", submissionId)
    .is("superseded_at", null)
    .maybeSingle();
  // US-2007: do NOT swallow this. maybeSingle() returns PGRST116 when more than
  // one active report exists, and discarding the error turned that into
  // `report == null` -> "nothing to do" -> the grade stranded UNFINALIZED
  // forever, with every retry reproducing the same false no-op. 00478 makes the
  // duplicate impossible at the DB level; this makes the residual case (and any
  // other read failure) LOUD rather than a silent success, because "we could not
  // tell" and "there is nothing here" must never look the same.
  if (reportErr) {
    captureException(reportErr, {
      route: "grading-pipeline.finalizeIfAlreadyGraded",
      extra: { submission_id: submissionId, code: reportErr.code },
    });
    throw new Error(
      `finalizeIfAlreadyGraded: could not read the active grade report for ` +
        `${submissionId}: ${reportErr.message}` +
        (reportErr.code === "PGRST116"
          ? " (multiple active reports — 00478's unique index should prevent this)"
          : ""),
    );
  }
  if (!report) return false;

  const r = report as {
    id: string;
    overall_score: number;
    grade_tier: string;
    certificate_id: string | null;
    review_status: string | null;
  };
  const { data: sub } = await supabaseAdmin
    .from("submissions")
    .select("status")
    .eq("id", submissionId)
    .maybeSingle();
  const status = (sub as { status?: string } | null)?.status;

  // Terminal states — nothing to re-assert. (The reaper ignores non-'processing'
  // rows, so a lingering lease is harmless.) A 'pending_review' row is already
  // correctly parked and waiting on a human; don't touch it.
  if (status === "completed" || status === "pending_review") return true;

  if (r.review_status === "approved" || r.review_status === "modified") {
    // Already human-finalized, but the go-live wiring didn't finish — re-run it.
    await applyTerminalCompletion(submissionId, {
      gradeReportId: r.id,
      overallScore: Number(r.overall_score),
      gradeTier: r.grade_tier,
      certificateUrl: r.certificate_id ? certificateUrl(r.certificate_id) : null,
    });
    console.log(`[Pipeline] Resumed + re-finalized already-graded submission ${submissionId}`);
  } else {
    // A preliminary grade exists but the pending_review flip was lost — re-park it.
    await applyPreliminaryReview(submissionId);
    console.log(`[Pipeline] Resumed preliminary grade (pending review) for submission ${submissionId}`);
  }
  return true;
}

export async function processSubmission(submissionId: string) {
  const startTime = Date.now();

  console.log(`[Pipeline] Starting grading pipeline for submission ${submissionId}`);

  // US-569: lease-based claim. The lease guards against a double-kick (webhook +
  // client ?pay_retry=1 both call processSubmission, and a second grade run would
  // double-bill Claude) AND, because it expires, lets a crashed run be resumed
  // later. Exactly one caller wins 'claimed'; duplicates/resumes no-op or
  // finalize.
  const claimResult = await claimSubmissionForGrading(submissionId);
  if (claimResult === "error") {
    // Transient DB error claiming the row — propagate so the caller's .catch
    // reports it. We have NOT started grading, so there's no spend to reverse.
    throw new Error(`Failed to claim submission ${submissionId} for grading`);
  }
  if (claimResult === "done" || claimResult === "already") {
    // 'done'  → an active grade_report already exists; a crash landed between the
    //           report insert and the status='completed' flip. Finalize cheaply
    //           (status + link sync) WITHOUT re-running or re-billing the AI.
    // 'already' → a live lease, a poison (exhausted) row, or a terminal row.
    //           finalizeIfAlreadyGraded no-ops when there's no active report, so
    //           it's safe to call here too (it covers a race where a fake/older
    //           claim path reports 'already' for a row that did get a report).
    const finalized = await finalizeIfAlreadyGraded(submissionId);
    console.log(
      `[Pipeline] Submission ${submissionId} claim=${claimResult} — ${
        finalized ? "finalized existing grade (no re-grade)" : "skipping duplicate grade run"
      }`,
    );
    return;
  }

  try {
    // --- Step 1: Fetch submission record ---
    const { data: submission, error: submissionError } = await supabaseAdmin
      .from("submissions")
      .select("id, user_id, garment_type, garment_category, brand, title, description, status, style_attributes, verified_capture_opt_in, live_capture_opt_in, verified_360_opt_in, capture_360, authenticity_addon, forensic_addon, service_tier, created_at, regrade_of_garment_id, video_graded, video_duration_seconds, video_capture_source, closet_item_id")
      .eq("id", submissionId)
      .single();

    if (submissionError) {
      // A DB error here is NOT "row missing" — most often it's a schema-drift
      // 42703 (the prod DB is behind this build, so a selected column doesn't
      // exist yet). Surface the real Postgres message so the failure is
      // diagnosable instead of being mislabeled as a missing submission.
      throw new Error(
        `Submission load failed for ${submissionId}: ${submissionError.message}` +
          (submissionError.code ? ` (${submissionError.code})` : ""),
      );
    }
    if (!submission) {
      throw new Error(`Submission not found: ${submissionId}`);
    }

    // --- Step 2: Fetch associated images ---
    const { data: images, error: imagesError } = await supabaseAdmin
      .from("submission_images")
      .select("id, image_type, image_role, storage_path, display_order, phash, exif, original_storage_path, capture_source, quality_score, width, height")
      .eq("submission_id", submissionId)
      .order("display_order", { ascending: true });

    if (imagesError || !images || images.length === 0) {
      throw new Error(`No images found for submission ${submissionId}`);
    }

    // Defense-in-depth cost cap (HIGH-1): the submit endpoints already bound and
    // de-dupe images per submission, but one Claude Vision call is issued per row
    // below while the submission is billed as a single grade. Hard-cap here too so
    // no future write path (or backfill) can turn a single paid grade into an
    // unbounded number of vision calls. MAX_PIPELINE_IMAGES matches the distinct
    // image-type slots accepted at submit.
    const MAX_PIPELINE_IMAGES = 14;
    if (images.length > MAX_PIPELINE_IMAGES) {
      console.warn(
        `[Pipeline] Submission ${submissionId} has ${images.length} images; capping to ${MAX_PIPELINE_IMAGES} for analysis`,
      );
      images.length = MAX_PIPELINE_IMAGES;
    }

    console.log(`[Pipeline] Found ${images.length} images for submission ${submissionId}`);

    // Seller-declared design features (e.g. distressed, raw-hem) flow through
    // as a hint so the grader doesn't read intentional distressing as damage.
    // Declared here (not inside the buffer-slot closure) because it's also used
    // by the composite grade below.
    const styleHint: string[] = Array.isArray(submission.style_attributes)
      ? (submission.style_attributes as string[])
      : [];

    // US-1066: confidence-gated model cascade. When enabled (config-driven via
    // system_settings, off by default), grade the first pass on the cheap model
    // and escalate to the stronger model only when confidence is low / the item
    // is high-value. `firstPassModel` undefined ⇒ default single-model behavior.
    const cascade = await getCascadeConfig();
    const firstPassModel = cascade.enabled ? cascade.firstPassModel : undefined;

    // US-601: premium authenticity / counterfeit-confidence add-on. Only runs
    // when the seller purchased it at submit (gated to Premium/Express tiers in
    // grade.ts). A SEPARATE garment-authenticity vision pass — distinct from the
    // condition grade and from the photo-tamper check (image_authenticity).
    const wantAuthenticity =
      (submission as { authenticity_addon?: boolean }).authenticity_addon === true;
    // US-1296: Forensic Grade add-on. The US-1035 defect-zoom re-analysis only
    // runs when the seller purchased it (gated to Premium/Express + the feature
    // flag + original retention in grade.ts). Without it the pipeline skips the
    // extra crop downloads + vision calls entirely — accuracy is monetized, not
    // absorbed on every grade.
    const wantForensic =
      (submission as { forensic_addon?: boolean }).forensic_addon === true;
    const authenticityGarmentInfo: GarmentInfo = {
      garment_type: submission.garment_type,
      garment_category: submission.garment_category,
      brand: submission.brand,
      title: submission.title,
      description: submission.description,
      style_attributes: styleHint,
    };

    // US-1769: ground the authenticity add-on (US-601) in structured brand tells
    // (US-1768) so it returns per-tell findings + a confidence-capped verdict.
    // Best-effort + only when the add-on was purchased — a miss (or an
    // unrecognizable brand) yields empty tells, keeping the assessment on the
    // byte-identical ungrounded v1 prompt.
    const authenticityTells = wantAuthenticity
      ? await getEffectiveTellsForBrand(submission.brand).catch(() => [])
      : [];
    // US-2218: the known-genuine references we hold for this brand. Empty on a
    // miss or a failure, which marks every visual tell unverifiable — widening
    // the disclosed limitations and capping confidence, never raising risk.
    const authenticityReferences = wantAuthenticity
      ? await getAuthenticityReferences(brandKey(submission.brand ?? "")).catch(
        () => [],
      )
      : [];

    // US-2210: read the garment's OWN label as trusted identity context. Gated
    // on GRADING_TAG_OCR (default OFF — the composite prompt changes, so it goes
    // live only after the golden-set eval + canary, exactly like US-1533) AND on
    // the submission actually having a label photo, so a submission with nothing
    // to read never pays for a vision call. `label` is a REQUIRED image type, so
    // in practice this is on for every well-formed submission once the flag is.
    //
    // KNOWN COST EDGE: like the authenticity add-on, this runs in parallel with
    // the per-image pass and therefore BEFORE the image-quality gate — so a
    // submission that later abstains on an illegible label has already paid for
    // the read. Sequencing the gate first would serialize the pipeline's hot
    // path on every grade to save a call on the abstaining minority, which is
    // the wrong trade; the same reasoning is recorded in fabric-criteria.ts.
    const tagPhotoTypes = images
      .map((i) => (i as { image_type: string }).image_type)
      .filter((t) => GRADING_TAG_PHOTO_TYPES.has(t));
    const wantTagOcr = tagOcrGradingEnabled() && tagPhotoTypes.length > 0;

    // US-2213: derive the size from the flat-lay measurement photos against the
    // brand's own chart. Gated on GRADING_SIZE_VERIFY (its own flag — a separate
    // vision call with a separate cost, so an operator can buy one without the
    // other) AND on the submission actually carrying a measurement photo. Those
    // slots are OPTIONAL at submit, so most submissions never reach the call at
    // all and the feature costs nothing on them.
    const hasMeasurementPhotos = images.some((i) =>
      isMeasurementPhoto((i as { image_type: string }).image_type)
    );
    const wantSizeVerify = sizeVerifyGradingEnabled() && hasMeasurementPhotos;

    // US-2212: the brand's known tag generations, so the label read can date the
    // garment. Fetched ONCE here (outside the buffer closure) alongside the other
    // knowledge lookups, and only when the tag read is going to run at all — a
    // brand with no seeded eras yields [], the reference block renders "", and
    // the tag-OCR prompt is byte-identical to US-2210's.
    // US-2214: resolved when EITHER identity feature is on — the pack carries the
    // DB-first sizing charts as well as the tag eras, and passing them into
    // estimateSize is what makes an operator's admin chart edit actually reach
    // the size call (it previously read the frozen in-code seed directly).
    let brandTagEras: TagEra[] = [];
    let brandPack: BrandKnowledgePack | null = null;
    if (wantTagOcr || wantSizeVerify) {
      try {
        brandPack = await resolveBrandKnowledgePack(submission.brand, {
          category: submission.garment_category,
        });
        brandTagEras = normalizeTagEras(brandPack?.tagEras);
      } catch (err) {
        console.error(
          `[Pipeline] tag-era pack resolve failed for submission ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const eraReferenceBlock = tagEraReferenceBlock(brandTagEras);

    // US-1533: trusted garment expectation baseline (flag-gated, default OFF;
    // cache-first with lazy generation). Fetched ONCE before the memory-gated
    // closure so both the per-image calls and the composite share it. Strictly
    // additive — a null baseline leaves every prompt byte-identical.
    const baselineBlock = baselineReferenceBlock(
      (await getGarmentBaseline({
        brand: submission.brand,
        garmentCategory: submission.garment_category,
      })) ?? "",
    );

    // US-1537: composite visual verification config (default OFF — canary
    // rollout; adds image tokens to the composite call). When on, the buffer
    // closure below captures the ≤4 selected photos so the composite can
    // re-see pixels; the array stays empty when disabled.
    const visualCfg = {
      enabled: false,
      maxImages: 4,
      ...(await getSetting<{ enabled?: boolean; maxImages?: number }>(
        "grading_composite_visual",
        {},
      )),
    };
    const verificationImages: VerificationImage[] = [];

    // --- Steps 3+4: download → base64 → per-image analysis, under a
    // process-wide memory gate (US-573). The base64 data URIs stay resident
    // for the whole analysis, so the slot is held across BOTH steps — this
    // bounds how many submissions buffer multi-MB image data at once and is
    // what keeps concurrent grading from OOM-ing the container. The closure
    // scopes `imageData` so the base64 is GC-eligible the moment it returns.
    const bufferResult = await withImageBufferSlot(async () => {
      // --- Step 3: Download images from storage and convert to base64 ---
      const imageDataPromises = images.map(async (image) => {
        const { data: fileData, error: downloadError } = await supabaseAdmin.storage
          .from("submission-images")
          .download(image.storage_path);

        if (downloadError || !fileData) {
          throw new Error(`Failed to download image: ${image.storage_path}`);
        }

        // Convert Blob to base64
        const arrayBuffer = await fileData.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const base64 = uint8ToBase64(bytes);

        // Determine media type from the actual bytes, not the (possibly lying)
        // file extension — a mismatch 400s the whole grading at the vision call.
        const mediaType = mediaTypeForVision(bytes, image.storage_path);

        // Return as data URI for analyzeImage
        return {
          imageType: image.image_type,
          // US-2471 (migration 00589): the role qualifier, so the per-image
          // prompt can name what the photo shows instead of which slot it
          // landed in. Null on every pre-00589 row and on every type that takes
          // no qualifier.
          imageRole: (image as { image_role?: string | null }).image_role ?? null,
          dataUri: `data:${mediaType};base64,${base64}`,
          // US-2136 AC4: carried alongside the bytes so the authenticity pass can
          // cap on the macro frames' MEASURED sharpness rather than on the mere
          // presence of a file in the slot. Null on any pre-00568 row.
          qualityScore: typeof image.quality_score === "number" ? image.quality_score : null,
        };
      });

      const imageData = await Promise.all(imageDataPromises);

      // --- Step 4: Run analyzeImage() on each image in parallel ---
      console.log(`[Pipeline] Running per-image analysis for ${imageData.length} images`);

      const perImagePromises = imageData.map((img) =>
        analyzeImage(
          img.dataUri,
          img.imageType,
          submission.garment_type,
          submission.garment_category,
          styleHint,
          // US-896: no prompt override on the live path; submissionId is the
          // stable canary bucket key so the whole submission resolves consistently.
          undefined,
          // US-1066: cheap first-pass model when the cascade is on (else default).
          firstPassModel,
          submissionId,
          baselineBlock,
          // US-2438: no per-block eval override on the live path.
          undefined,
          img.imageRole,
        )
      );

      // US-601: run the premium authenticity add-on (when purchased) in parallel
      // with per-image analysis, INSIDE this buffer slot so it reuses the same
      // resident base64 data (the memory gate stays the concurrency bound). The
      // add-on is opt-in/low-volume; on the rare quality-gate abstention the one
      // extra call is wasted but never charged separately. Best-effort: a failure
      // resolves to null so a flaky add-on never fails the paid grade.
      const authPromise: Promise<AuthenticityAssessment | null> = wantAuthenticity
        ? assessAuthenticity(
            imageData.map((img) => ({
              imageType: img.imageType,
              dataUri: img.dataUri,
              qualityScore: img.qualityScore,
            })),
            authenticityGarmentInfo,
            { tells: authenticityTells, references: authenticityReferences },
          ).catch((err) => {
            console.error(
              `[Pipeline] authenticity add-on failed for submission ${submissionId}:`,
              err instanceof Error ? err.message : String(err),
            );
            return null;
          })
        : Promise.resolve(null);

      // US-2210: the label transcription runs INSIDE this buffer slot, in
      // parallel with the per-image pass, over the label photos' already-
      // resident base64 — so it adds one vision call and ZERO extra downloads,
      // and stays under the same memory gate that bounds grading concurrency.
      // Best-effort: a failure resolves to null and the grade proceeds with no
      // tag block, byte-identical to the feature being off.
      const tagPromise: Promise<TagOcrResult | null> = wantTagOcr
        ? extractTagGroundTruth(
            imageData
              .filter((img) => GRADING_TAG_PHOTO_TYPES.has(img.imageType))
              .map((img) => ({ url: img.dataUri, type: img.imageType })),
            eraReferenceBlock,
          ).catch((err) => {
            console.error(
              `[Pipeline] tag OCR failed for submission ${submissionId}:`,
              err instanceof Error ? err.message : String(err),
            );
            return null;
          })
        : Promise.resolve(null);

      // US-2213: the size pass, like the tag read, runs INSIDE this buffer slot
      // over already-resident base64 — no extra downloads, same memory gate. It
      // sees the measurement/flat-lay photos plus the front and back for
      // silhouette; prioritizeMeasurementPhotos (inside estimateSize) puts the
      // measurement shots first. Best-effort: a failure resolves to null and the
      // grade proceeds with no verified size.
      const sizePromise: Promise<SizeEstimate | null> = wantSizeVerify
        ? estimateSize({
          photos: imageData
            .filter((img) =>
              isMeasurementPhoto(img.imageType) ||
              img.imageType === "front" ||
              img.imageType === "back"
            )
            .map((img) => ({ url: img.dataUri, type: img.imageType })),
          brand: submission.brand,
          category: submission.garment_category,
          // US-2214: DB-first charts; [] falls back to the in-code seed inside
          // estimateSize, exactly as before.
          charts: brandPack?.sizingCharts ?? [],
          // US-2924: PINNED, and it must stay pinned.
          //
          // estimateSize now defaults to the cheap model, which is right for
          // AutoLister and the FlipDesk route — a wrong size there is a listing
          // field the seller sees and edits. Here it is not a field. This result
          // reaches tagGroundTruthBlock below and goes into the GRADING PROMPT as
          // trusted ground truth, so changing the model that produces it moves
          // grades: no shadow compare, no golden-set eval, and no prompt_version
          // suffix to attribute the era to afterwards. That is precisely the
          // silent change the prompt-version lifecycle exists to prevent.
          //
          // Moving grading onto a cheaper model may well be right. It is a
          // decision that goes through the eval gate, not one that arrives as a
          // side effect of a cost cut. src/tests/size-estimate-model_test.ts
          // fails if this line is removed.
          model: getDefaultModel(),
        }).catch((err) => {
          console.error(
            `[Pipeline] size estimate failed for submission ${submissionId}:`,
            err instanceof Error ? err.message : String(err),
          );
          return null;
        })
        : Promise.resolve(null);

      // US-485: allSettled (not all) so one flaky image doesn't fail the whole
      // paid grade. analyzeImage already retries + has a bounded timeout via the
      // Anthropic SDK (getAiMaxRetries / getAiTimeoutMs).
      const [settled, authenticityAssessment, tagOcr, sizeEstimate] = await Promise
        .all([
          Promise.allSettled(perImagePromises),
          authPromise,
          tagPromise,
          sizePromise,
        ]);
      const results: SettledImage[] = settled.map((s, i) => ({
        imageType: imageData[i].imageType,
        result: s.status === "fulfilled" ? s.value : null,
      }));
      settled.forEach((s, i) => {
        if (s.status === "rejected") {
          console.error(
            `[Pipeline] analyzeImage failed for ${imageData[i].imageType} ` +
              `(submission ${submissionId}): ${s.reason}`,
          );
        }
      });

      // US-1537: capture the ≤4 verification photos WHILE the base64 data is
      // still resident (imageData is scoped to this closure). Deterministic
      // selection: front/back + the worst-genuine-defect angles.
      if (visualCfg.enabled) {
        const analyses = results
          .map((r) => r.result)
          .filter((r): r is PerImageAnalysis => r !== null);
        const wantedTypes = selectVerificationImages(analyses, visualCfg.maxImages);
        for (const t of wantedTypes) {
          const img = imageData.find((d) => d.imageType === t);
          if (img) verificationImages.push({ imageType: t, dataUri: img.dataUri });
        }
      }

      return { settledImages: results, authenticityAssessment, tagOcr, sizeEstimate };
    });

    const settledImages: SettledImage[] = bufferResult.settledImages;
    // US-2138: `let`, not `const`, because a deterministic decoder contradiction
    // caps this AFTER the tag code has been decoded further down. The decode
    // cannot happen earlier — authPromise and tagPromise are awaited together,
    // so the style code does not exist while the assessment is being produced.
    // Every consumer of this binding is below the cap site.
    let authenticityAssessment: AuthenticityAssessment | null =
      bufferResult.authenticityAssessment;
    const tagOcr: TagOcrResult | null = bufferResult.tagOcr;
    const sizeEstimate: SizeEstimate | null = bufferResult.sizeEstimate;

    // US-2210: keep only reads that cleared TAG_GROUND_TRUTH_MIN_CONFIDENCE — an
    // illegible label yields no identity rather than a guessed one — then record
    // where the label and the seller disagree. A disagreement is REPORTED, never
    // resolved: we neither overwrite the seller's brand with the tag's nor drop
    // the tag read in favour of the seller's (see tag-ground-truth.ts).
    const acceptedTag = tagOcr ? acceptedTagFields(tagOcr.fields) : [];
    const tagMismatches = tagDiscrepancies(acceptedTag, { brand: submission.brand });

    // US-2212: resolve the model's era pick back to a SEEDED entry. matchTagEra
    // returns null for an unknown id, a hallucinated one, or a confidence below
    // ERA_MATCH_MIN_CONFIDENCE (0.7 — stricter than the 0.4 field bar, because
    // dating is an inference over a reference list, not a transcription, and a
    // half-sure decade is a fabricated provenance claim on a public certificate).
    // So the model cannot introduce an era we did not curate.
    const matchedEra: MatchedTagEra | null = tagOcr
      ? matchTagEra(brandTagEras, tagOcr.eraId, tagOcr.eraConfidence)
      : null;
    if (matchedEra) {
      void captureServer("grading-engine", "grading.tag_era_matched", {
        submission_id: submissionId,
        era: matchedEra.era,
        years: matchedEra.years,
        confidence: matchedEra.confidence,
      });
    }

    // US-2212 AC4: the one place an era can be CHECKED rather than recorded.
    // When the style code decodes to a production year AND the label's design
    // matched a dated generation, those are two independent readings of the same
    // garment and they have to agree. A FLAG for review, never a verdict — the
    // US-1770 no-auto-authenticate posture holds; the innocent explanation
    // (a relabelled or franken-tagged garment) is at least as likely as the
    // guilty one, and nothing here can tell them apart.
    let eraConflict: EraDecoderConflict | null = null;
    // US-2138: the decode is hoisted out of the `matchedEra` guard. It used to
    // sit inside it because its only consumer was the era comparison — but a
    // decoder CONTRADICTION (a code dating to the future, or to before the brand
    // existed) is impossible regardless of whether a tag era also matched, and
    // leaving the decode behind that guard would have silently scoped the new
    // cross-check to the subset of items that happen to match an era.
    // decodeTagCode is pure, so hoisting changes nothing about eraConflict.
    // The FLAGS themselves, not just how many — a capped verdict has to be
    // explainable to an operator, and "confidence was capped" without saying
    // which rule fired is not an explanation (US-2138 AC7).
    let decoderFlags: DecoderContradiction[] = [];
    if (brandPack) {
      try {
        const styleCode = acceptedTag.find((a) => a.field === "style_code")?.value;
        if (styleCode) {
          const decoded = decodeTagCode(
            brandPack.key,
            styleCode,
            decoderSpecsFromPack(brandPack),
          );
          const decodedYear = decoded?.year ? Number(decoded.year) : null;

          // ⚠ NO CLAIM CONTEXT IS PASSED, and that is the injection defence
          // (US-346) rather than an omission. crossCheckDecodeResult's
          // claimedYear / claimedGender / claimedStyleCode compare the decode
          // against SELLER-SUPPLIED listing text, and each produces `warn`.
          // Feeding them would let a seller move their own authenticity verdict
          // by typing a wrong year into their listing. Only the server-held
          // facts are passed, and those are exactly the ones that produce the
          // `flag` severity the cap acts on.
          //
          // ONLY `date_in_future` CAN FIRE TODAY. The other flag check,
          // `date_before_brand`, needs brandFoundedYear — and BrandKnowledgePack
          // has no founding-year field, so there is nothing honest to pass.
          // Stated rather than stubbed: adding it is a brand-KB change (a column
          // plus sourced per-brand values under the 00578 provenance rule), not
          // a wiring one, and inventing a year here would manufacture the
          // contradiction the cap then punishes.
          if (decoded) {
            decoderFlags = crossCheckDecodeResult(decoded, {
              currentYear: new Date().getUTCFullYear(),
            })
              .filter((i) => i.severity === "flag")
              .map((i) => ({ code: i.code, message: i.message }));
          }

          eraConflict = matchedEra
            ? eraDecoderConflict(
              matchedEra,
              Number.isFinite(decodedYear) ? decodedYear : null,
              new Date().getUTCFullYear(),
            )
            : null;
          if (eraConflict) {
            console.warn(
              `[Pipeline] tag-era conflict on submission ${submissionId}: ${eraConflict.message}`,
            );
            void captureServer("grading-engine", "grading.tag_era_conflict", {
              submission_id: submissionId,
              decoded_year: eraConflict.decodedYear,
              era: eraConflict.era,
              era_years: eraConflict.eraYears,
            });
          }
        }
      } catch (err) {
        console.error(
          `[Pipeline] tag-era decoder cross-check failed for submission ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // US-2138 AC6: a deterministic contradiction DOMINATES model optimism.
    //
    // The decoder said the code is impossible. That is a fact about the code,
    // not a reading of a photograph, so it caps the verdict rather than being
    // offered to the model as something to weigh. Composes as a min and never
    // raises — applyDecoderContradictionCap owns that and explains why only
    // `flag` severity is allowed to reach it.
    if (authenticityAssessment && decoderFlags.length > 0) {
      const before = authenticityAssessment.verdict_confidence;
      const after = applyDecoderContradictionCap(before, decoderFlags.length);
      // The contradictions are recorded even when the verdict was ALREADY at or
      // below the cap: the cap not moving is not the same as no contradiction,
      // and an operator looking at a low-confidence verdict still needs to know
      // a decoder said the code is impossible.
      authenticityAssessment = {
        ...authenticityAssessment,
        verdict_confidence: after,
        decoder_contradictions: decoderFlags,
      };
      if (after < before) {
        console.warn(
          `[Pipeline] decoder contradiction on submission ${submissionId}: ` +
            `verdict confidence ${before} -> ${after} (${decoderFlags.length} flag(s))`,
        );
        void captureServer("grading-engine", "grading.decoder_contradiction", {
          submission_id: submissionId,
          flag_count: decoderFlags.length,
          verdict_confidence_before: before,
          verdict_confidence_after: after,
        });
      }
    }

    // US-2213: combine the label's size read with the measurement-derived one.
    // There is no seller-declared size to contradict — `submissions` has no size
    // column at all — so the comparison is between OUR two readings. When they
    // disagree the label is shown (a transcription beats an inference) but the
    // confidence drops to the lower of the two and the disagreement is recorded;
    // a relabelled garment, a shrunk one and a bad tape read all look the same
    // from here, so neither reading is treated as the correction.
    const sizeVerification: SizeVerification | null = resolveSizeVerification(
      acceptedTag.find((a) => a.field === "size"),
      sizeEstimate,
    );
    if (sizeVerification?.disagreement) {
      console.warn(
        `[Pipeline] size disagreement on submission ${submissionId}: ` +
          `label="${sizeVerification.disagreement.label}" ` +
          `measurements="${sizeVerification.disagreement.measurements}"`,
      );
      void captureServer("grading-engine", "grading.size_disagreement", {
        submission_id: submissionId,
      });
    }

    // US-2217: a STYLE-KEYED baseline for the composite, when the style can be
    // identified from trusted signals.
    //
    // WHY ONLY THE COMPOSITE: the only server-derived style signal is the tag
    // read (US-2210), and that runs inside the buffer closure alongside the
    // per-image calls — so it does not exist yet when the per-image baseline is
    // resolved. Rather than serialize the hot path to learn the style first, the
    // per-image pass keeps the brand+category brief and the composite gets the
    // style-scoped one. That split is defensible on its own terms: per-image is
    // photo-level observation, while the composite is where the
    // as-manufactured framing is actually applied to the score.
    //
    // The style is resolved from the tag read ALONE, never from the seller's
    // title — see resolveTrustedStyle for why choosing which trusted block gets
    // injected is itself a privileged act.
    let compositeBaselineBlock = baselineBlock;
    if (brandPack) {
      const trustedStyle = resolveTrustedStyle(brandPack.styles, [
        acceptedTag.find((a) => a.field === "style_code")?.value ?? null,
      ]);
      if (trustedStyle) {
        const styled = await getGarmentBaseline({
          brand: submission.brand,
          garmentCategory: submission.garment_category,
          style: trustedStyle,
        }).catch(() => null);
        if (styled) {
          compositeBaselineBlock = baselineReferenceBlock(styled);
          void captureServer("grading-engine", "grading.style_baseline", {
            submission_id: submissionId,
            style: trustedStyle,
          });
        }
      }
    }

    const tagBlock = tagGroundTruthBlock(acceptedTag, matchedEra, sizeVerification);
    if (tagMismatches.length > 0) {
      console.warn(
        `[Pipeline] tag/seller mismatch on submission ${submissionId}: ` +
          tagMismatches
            .map((d) => `${d.field} label="${d.read}" seller="${d.declared}"`)
            .join("; "),
      );
      void captureServer("grading-engine", "grading.tag_discrepancy", {
        submission_id: submissionId,
        fields: tagMismatches.map((d) => d.field),
      });
    }
    // US-2211: cross-check the transcribed RN/CA against the brand KB. An RN is
    // registry-issued, so unlike every other field on the label a seller cannot
    // type it into existence — which makes it the cheapest DETERMINISTIC identity
    // signal available, and it had never been compared to anything.
    //
    // Best-effort and strictly informational: it can corroborate, it can flag a
    // contradiction for review, and it can NEVER rewrite the brand. Most reads
    // return `no_reference` (six brands carry a seeded number today) and that
    // outcome carries no information in either direction.
    let registeredNumber: RegisteredNumberAssessment | null = null;
    const rnRead = acceptedTag.find((a) => a.field === "rn_number");
    if (rnRead) {
      try {
        // US-2244: the context carries the operator-resolved registrants (00502)
        // alongside the brand index, so a resolved number reads as "registered to
        // <company>" instead of silently as "no reference".
        const rnContext = await getRegisteredNumberContext();
        registeredNumber = assessRegisteredNumber(
          rnRead.value,
          submission.brand,
          rnContext.index,
          rnContext.registrants,
        );
        // US-2243: a number we have no reference for is the NORMAL case and the
        // only one worth recording — it becomes the admin resolve queue, so
        // coverage grows in the order real tags arrive. Fire-and-forget.
        void recordRegisteredNumberSighting(registeredNumber, submission.brand);
        if (registeredNumber.outcome === "contradicts") {
          console.warn(
            `[Pipeline] RN cross-check contradicts on submission ${submissionId}: ` +
              registeredNumber.note,
          );
          void captureServer("grading-engine", "grading.rn_contradiction", {
            submission_id: submissionId,
            normalized: registeredNumber.normalized,
            owner_brands: registeredNumber.owners.map((o) => o.brandKey),
          });
        }
      } catch (err) {
        console.error(
          `[Pipeline] RN cross-check failed for submission ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const tagRead = tagOcr && (acceptedTag.length > 0 || matchedEra)
      ? buildPersistedTagRead(
        acceptedTag,
        tagMismatches,
        tagOcr.model,
        new Date().toISOString(),
        undefined,
        registeredNumber,
        matchedEra,
        eraConflict,
      )
      : null;

    const { usable, failedRequired, failedOptional } = partitionImageResults(
      settledImages,
      REQUIRED_IMAGE_TYPES,
    );

    // A core angle's analysis failed (or nothing succeeded) — can't grade
    // reliably. Preserve prior behavior: throw so the catch reverses the charge.
    if (failedRequired.length > 0 || usable.length === 0) {
      throw new Error(
        `Required image analysis failed for submission ${submissionId}: ` +
          (failedRequired.join(", ") || "no images analyzed"),
      );
    }

    // Only optional images failed — degrade gracefully (US-485). US-1642: `let`
    // so an ESCALATION that drops an optional image can OR itself in (below),
    // keeping the partial-image cap on the escalated grade too.
    let partialSuccess = failedOptional.length > 0;
    if (partialSuccess) {
      console.warn(
        `[Pipeline] partial-success grade for ${submissionId}: dropped ` +
          `${failedOptional.length} optional image(s): ${failedOptional.join(", ")}`,
      );
      void captureServer("grading-engine", "grading.partial_success", {
        submission_id: submissionId,
        dropped_count: failedOptional.length,
        dropped_types: failedOptional,
        graded_count: usable.length,
      });
    }

    let perImageResults: PerImageAnalysis[] = usable;

    console.log(`[Pipeline] Per-image analysis complete for submission ${submissionId}`);

    // --- Step 4b: Pre-grade image-quality gate + active abstention (US-332) ---
    // If a core photo is unusable (severe blur / too dark / cut off / illegible
    // label) or a required angle is missing, abstain rather than emit a
    // low-confidence guess. This is NOT a failed grade and creates no
    // grade_report — so no paid grade credit is consumed (when auto-debit
    // US-207 lands it must run AFTER this gate / on a created report only).
    const qualityGate = evaluateImageQuality(
      perImageResults.map((r) => ({
        image_type: r.image_type,
        quality: r.quality,
      })),
    );
    if (qualityGate.abstain) {
      console.log(
        `[Pipeline] Submission ${submissionId} ABSTAINED on image quality: ${qualityGate.summary}`,
      );
      await supabaseAdmin
        .from("submissions")
        .update({
          status: "needs_photos",
          quality_feedback: {
            summary: qualityGate.summary,
            photo_requests: qualityGate.photo_requests,
            issues: qualityGate.issues,
            assessed_at: new Date().toISOString(),
          },
        })
        .eq("id", submissionId);
      // Mirror the abstention onto the FlipDesk bridge row so the in-app /
      // web status poll reaches a TERMINAL state instead of hanging at
      // "processing" forever (the bug behind "certified grade just keeps
      // spinning"). Unlike the completed / pending_review / failed paths, the
      // needs_photos path previously left the bridge row at 'processing', so a
      // FlipDesk-originated grade that abstained never resolved on the client.
      // We carry the human-readable summary in `error` so even clients that
      // don't model needs_photos surface a clear "needs clearer photos" message.
      try {
        const { data: fdLink } = await supabaseAdmin
          .from("flipdesk_grading_submissions")
          .select("id")
          .eq("submission_id", submissionId)
          .maybeSingle();
        if (fdLink) {
          await supabaseAdmin
            .from("flipdesk_grading_submissions")
            .update({
              status: "needs_photos",
              error: qualityGate.summary.slice(0, 500),
            })
            .eq("id", (fdLink as { id: string }).id);
        }
      } catch (fdErr) {
        console.error(
          `[Pipeline] FlipDesk abstention bridge sync error for submission ${submissionId}:`,
          fdErr instanceof Error ? fdErr.message : String(fdErr),
        );
      }
      // AC #4: abstention must not consume a paid grade. Reverse the charge
      // taken at submit (included grade returned / credits re-granted; a
      // Stripe per-grade payment is flagged for manual refund).
      await reverseChargeForUngradedSubmission(submissionId, "quality abstention");
      // US-1056: tell the seller the grade was withheld for clearer photos
      // (not silently stuck). Best-effort — never blocks the abstention.
      void notifyGradingIncomplete(
        submission.user_id,
        submission.title,
        qualityGate.summary,
        `/dashboard/submissions/${submissionId}`,
      );
      return null;
    }

    // --- Step 4c: high-res region-zoom for small / uncertain defects (US-1035) ---
    // A sub-3mm defect can be lost to the vision API's downscale of a whole-
    // garment shot; re-analyze just the defect region from the original at high
    // resolution and merge the better size/severity read. Best-effort + bounded;
    // a failure leaves the original read intact.
    //
    // US-1296: this is now the PAID Forensic Grade add-on — it only runs when the
    // seller purchased it. Skipping it on a standard grade avoids the extra crop
    // downloads + vision calls that the pipeline used to eat on every submission.
    if (wantForensic) {
      perImageResults = await runDefectZoomPass(
        perImageResults,
        images as ZoomImageRow[],
        submission,
        styleHint,
        submissionId,
        firstPassModel,
      ).catch((err) => {
        console.error(
          `[Pipeline] defect zoom pass error for submission ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        );
        return perImageResults;
      });
      // US-2154: high-res re-read of illegible labels (recover fiber composition
      // for the composite's fabric criteria) and possibly-manipulated photos
      // (sharpen the tamper tells before review). Same paid-Forensic gate +
      // best-effort contract as the defect zoom above.
      perImageResults = await runRereadPass(
        perImageResults,
        images as ZoomImageRow[],
        submission,
        styleHint,
        submissionId,
        firstPassModel,
      ).catch((err) => {
        console.error(
          `[Pipeline] re-read pass error for submission ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        );
        return perImageResults;
      });
    }

    // --- Step 5: Run compositeGrade() with all per-image results ---
    const garmentInfo: GarmentInfo = {
      garment_type: submission.garment_type,
      garment_category: submission.garment_category,
      brand: submission.brand,
      title: submission.title,
      description: submission.description,
      style_attributes: styleHint,
    };

    console.log(`[Pipeline] Running composite grading for submission ${submissionId}`);

    let compositeResult: CompositeGradeResult = await compositeGrade(
      perImageResults,
      garmentInfo,
      // US-896: live path — no override; submissionId buckets the canary slice.
      undefined,
      // US-1066: cheap first-pass model when the cascade is on (else default).
      firstPassModel,
      submissionId,
      // US-1533/US-2217: the trusted baseline — style-scoped when the tag read
      // identified one, else the same brand+category brief the per-image pass saw.
      compositeBaselineBlock,
      // US-1537: the visual-verification photo set ([] when disabled). The
      // escalation re-grade below stays text-only by design — it re-runs the
      // whole per-image pass on the stronger model anyway.
      verificationImages,
      // Live grading always carries the active exemplar block (eval/dry-run
      // legs are the ones that suppress it).
      false,
      // US-2210: trusted label transcription ("" when off / unread).
      tagBlock,
      // US-2397: grading without a fabric close-up is allowed now, but never at
      // full confidence — this caps it and forces the human check.
      qualityGate.fabricCloseupMissing,
    );

    // US-1066: escalate a low-confidence / high-value first-pass grade to the
    // stronger model. The first-pass usages are captured for the ledger so the
    // savings (grades that DON'T escalate) and the escalation overhead are both
    // measurable. Off-by-default + best-effort: any failure keeps the first pass.
    let firstPassUsages: Array<{ phase: string; usage: AiTokenUsage }> = [];
    if (cascade.enabled) {
      // Item value for the high-value gate — only queried when value-routing is
      // configured. Uses the linked FlipDesk item's target (intended sale) price.
      let itemValueUsd: number | null = null;
      if (cascade.highValueUsd !== null) {
        const { data: valItem } = await supabaseAdmin
          .from("inventory_items")
          .select("target_price")
          .eq("submission_id", submissionId)
          .maybeSingle();
        const tp = (valItem as { target_price?: number | null } | null)?.target_price;
        itemValueUsd = typeof tp === "number" && Number.isFinite(tp) ? tp : null;
      }

      const decision = decideEscalation({
        confidence: compositeResult.confidence_score,
        itemValueUsd,
        config: cascade,
      });
      const firstPassConfidence = compositeResult.confidence_score;

      if (decision.escalate) {
        firstPassUsages = [
          ...perImageResults
            .filter((r) => r.usage)
            .map((r) => ({ phase: "per_image_firstpass", usage: r.usage! })),
          ...(compositeResult.usage
            ? [{ phase: "composite_firstpass", usage: compositeResult.usage }]
            : []),
        ];
        try {
          const escalated = await escalateGrade(
            images as ZoomImageRow[],
            submission,
            garmentInfo,
            styleHint,
            submissionId,
            cascade.escalationModel,
            wantForensic,
            compositeBaselineBlock,
            tagBlock,
          );
          if (escalated) {
            perImageResults = escalated.perImageResults;
            compositeResult = escalated.compositeResult;
            // US-1642: OR the escalation's dropped-optional signal in so the
            // partial-image cap + forced review below apply to an escalated
            // grade built from an incomplete set (never ship it uncapped).
            partialSuccess = partialSuccess || escalated.partialSuccess;
          } else {
            // Escalation couldn't produce a usable grade — drop the captured
            // first-pass usages so the ledger doesn't double-count this grade.
            firstPassUsages = [];
          }
        } catch (err) {
          console.error(
            `[Pipeline][cascade] escalation failed for submission ${submissionId} — keeping first pass:`,
            err instanceof Error ? err.message : String(err),
          );
          firstPassUsages = [];
        }
      }

      console.log(
        `[Pipeline][cascade] submission ${submissionId} | first_pass_model=${cascade.firstPassModel} | ` +
          `first_pass_confidence=${firstPassConfidence} | escalated=${decision.escalate && firstPassUsages.length > 0} | ` +
          `reason=${decision.reason}`,
      );
      // Escalation decision metric so escalation rate + cost savings are
      // measurable (the ledger rows below carry the per-call model + cost).
      void captureServer("grading-engine", "grading.model_escalation", {
        submission_id: submissionId,
        reason: decision.reason,
        escalated: decision.escalate && firstPassUsages.length > 0,
        first_pass_model: cascade.firstPassModel,
        escalation_model: cascade.escalationModel,
        first_pass_confidence: firstPassConfidence,
        final_confidence: compositeResult.confidence_score,
      });
    }

    // US-485: a grade produced from an incomplete image set must not ship
    // confidently — cap confidence below the review threshold and route to a
    // human so the dropped angle is checked.
    if (partialSuccess) {
      compositeResult.confidence_score = Math.min(
        compositeResult.confidence_score,
        PARTIAL_IMAGE_CONFIDENCE_CAP,
      );
      compositeResult.needs_human_review = true;
    }

    // US-1622 / C9: a running ceiling on confidence that every post-composite
    // LOWERING event (a verification-discrepancy shave, a peer-norm cap, a
    // forensic-tamper shave) tightens. The provenance BOOSTS below
    // (verified-capture / live-capture / verified-360) are clamped to this
    // ceiling, so a boost can never lift confidence back over a floor a lowering
    // event established — and the review gate re-derivation at the end then
    // catches any grade whose EFFECTIVE confidence still ended below threshold.
    // Honors the grading contract: "never raise confidence post-composite" past
    // where a penalty put it.
    //
    // US-2299: seeded from the ceiling compositeGrade ACTUALLY APPLIED, not
    // from 1. The four caps inside compositeGrade (authenticity 0.6, defaulted
    // factor 0.5, prompt injection 0.5, defect divergence 0.6) were baked into
    // the composite confidence but never recorded here, so the ceiling started
    // at 1 and a provenance boost could lift a grade capped at 0.5 for a
    // hallucinated factor all the way back to 1.0 and store it. The review gate
    // still held — but the STORED number feeds the public confidence label and
    // the calibration miner that derives future thresholds, so a wrong-but-
    // confident number there is exactly the failure the contract forbids.
    //
    // Seeded from the CEILING and not from the composite's confidence on
    // purpose: seeding from the value would freeze confidence and disable the
    // provenance boosts entirely, which are a deliberate feature. An uncapped
    // grade still earns its boost; a capped one cannot be lifted past its cap.
    let confidenceCeiling = Math.min(
      partialSuccess ? PARTIAL_IMAGE_CONFIDENCE_CAP : 1,
      compositeResult.confidence_ceiling ?? 1,
    );

    // --- Step 6: Create grade report record ---
    const certificateId = crypto.randomUUID();
    // PSA-style public verification number (00307) — the plain-text key that
    // rides in eBay listings and resolves on /verify. The UUID stays the URL id.
    const certificateNumber = await generateUniqueCertNumber();

    // Build detailed_notes from per-image analyses
    const detailedNotes: Record<string, string> = {};
    for (const result of perImageResults) {
      const issues = result.detected_issues
        .map((i) => `[${i.severity}] ${i.issue} (${i.location})`)
        .join("; ");
      const signals = result.condition_signals
        .map((s) => `[${s.sentiment}] ${s.signal}`)
        .join("; ");
      detailedNotes[result.image_type] = `Issues: ${issues || "None"}. Signals: ${signals || "None"}.`;
    }

    // Add defects summary
    if (compositeResult.defects_found.length > 0) {
      detailedNotes["defects_summary"] = compositeResult.defects_found
        .map((d) => `[${d.severity}] ${d.defect} at ${d.location} — ${d.impact_on_grade}`)
        .join("; ");
    }

    // US-1537: cross-photo contradictions found by the visual verification
    // pass are recorded on the report and lower confidence — a grade whose
    // own verification caught inconsistencies must not ship confidently.
    // Penalty mirrors the existing policy shape (bounded shave, floor 0);
    // ≥2 discrepancies also route to a human.
    const discrepancies = compositeResult.verification_discrepancies ?? [];
    if (discrepancies.length > 0) {
      detailedNotes["visual_verification"] =
        `Discrepancies found re-checking the photos: ${discrepancies.join("; ")}`;
      compositeResult.confidence_score = Math.max(
        0,
        compositeResult.confidence_score -
          Math.min(0.2, 0.1 * discrepancies.length),
      );
      // US-1622 / C9: this shave is a floor a later provenance boost must not
      // cross — even a single discrepancy that drops confidence below threshold.
      confidenceCeiling = Math.min(confidenceCeiling, compositeResult.confidence_score);
      if (discrepancies.length >= 2) compositeResult.needs_human_review = true;
      console.log(
        `[Pipeline] visual verification found ${discrepancies.length} discrepancy(ies) ` +
          `for submission ${submissionId}`,
      );
    }

    // US-1536: peer-norm sanity check — compare this grade against recent
    // FINAL grades for similar items (same category + defect profile, brand-
    // refined when sampled enough). A grade well outside the peer IQR is
    // confidence-capped below the review threshold and routed to a human with
    // the peer context in detailed_notes. Deliberately POST-composite (peer
    // grades never enter the prompt — that would anchor the model) and
    // best-effort: any failure skips the check, never the grade.
    try {
      const peerCfg: PeerNormConfig = {
        ...DEFAULT_PEER_NORM_CONFIG,
        ...(await getSetting<Partial<PeerNormConfig>>("grading_peer_norm", {})),
      };
      if (peerCfg.enabled) {
        const dist = await fetchPeerDistribution({
          garmentCategory: submission.garment_category,
          brand: submission.brand,
          defectSeverities: compositeResult.defects_found.map((d) => d.severity),
          minSampleSize: peerCfg.minSampleSize,
        });
        const verdict = evaluatePeerNorm(
          compositeResult.overall_score,
          dist,
          peerCfg,
        );
        if (verdict.flagged) {
          compositeResult.confidence_score = composeConfidenceCap(
            compositeResult.confidence_score,
            verdict.confidenceCap,
          );
          // US-1622 / C9: the peer-norm cap is a floor boosts can't cross.
          confidenceCeiling = Math.min(confidenceCeiling, compositeResult.confidence_score);
          compositeResult.needs_human_review = true;
          detailedNotes["peer_norm"] = verdict.reason ?? "peer_norm outlier";
          console.log(
            `[Pipeline] peer-norm flagged submission ${submissionId}: ${verdict.reason}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[Pipeline] peer-norm check failed for ${submissionId} (skipped):`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // US-2135 AC3, the reader half: condition confidence on the pixel density
    // that actually ARRIVED for the close-up slots, not on the cap the client
    // was aiming at. 00613 recorded width/height per image and left this open,
    // naming it a column with no consumer.
    //
    // Non-macro slots are ignored — a front shot is not trying to resolve stitch
    // pitch — and an image with no recorded dimensions is ignored rather than
    // treated as zero. Every row predating 00613 is null, and Number(null) is a
    // finite 0, which would cap every historical regrade at the worst possible
    // reading.
    try {
      const delivered: DeliveredImage[] = images.map((img) => {
        const row = img as { image_type: string | null; width: number | null; height: number | null };
        return { image_type: row.image_type, width: row.width, height: row.height };
      });
      const density = assessMacroDensity(delivered);
      if (density.confidenceCap !== null) {
        compositeResult.confidence_score = composeConfidenceCap(
          compositeResult.confidence_score,
          density.confidenceCap,
        );
        // US-2299: the ceiling too, or the next provenance boost lifts the stored
        // number back over a cap applied because the evidence was thin.
        confidenceCeiling = Math.min(confidenceCeiling, compositeResult.confidence_score);
        compositeResult.needs_human_review = true;
        detailedNotes["macro_evidence_density"] = density.note;
        console.log(
          `[Pipeline] thin macro evidence on ${submissionId}: ${density.thin} of ${density.measured} measured slot(s)`,
        );
      }
    } catch (err) {
      // Best-effort, same posture as peer-norm: a failure here skips the check,
      // never the grade.
      console.error(
        `[Pipeline] macro density check failed for ${submissionId} (skipped):`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // US-2279: selective second opinion — re-run the COMPOSITE stage under a
    // second allowlisted model on borderline (or high-value) grades and route
    // real disagreement to a human.
    //
    // Placed after peer-norm on purpose: peer-norm may already have routed this
    // grade, and shouldSeekSecondOpinion skips anything already going to a
    // person. Running first would pay for a second model call to reach a
    // conclusion the next block reaches for free.
    //
    // OFF unless a settings row says otherwise, and byte-identical when off —
    // no extra call, no note, no confidence change. Best-effort in the same
    // shape as peer-norm: any failure skips the check, never the grade.
    try {
      const { config: soCfg, refusal } = resolveSecondOpinionConfig(
        await getSetting<Partial<SecondOpinionConfig>>("grading_second_opinion", {}),
      );
      if (refusal) {
        // Loud, because a refusal means an operator turned this on and it is not
        // running — the silent-misconfiguration shape this repo keeps getting bitten by.
        console.warn(`[Pipeline] second opinion refused: ${refusal}`);
      }
      const decision = shouldSeekSecondOpinion(
        {
          confidence: compositeResult.confidence_score,
          // No value column exists on submissions today, so this is null in
          // practice and the band is the only live trigger. Passed explicitly
          // rather than omitted so the day a value source is wired, the change
          // is one expression here and not a redesign.
          itemValue: null,
          alreadyNeedsReview: compositeResult.needs_human_review,
        },
        soCfg,
      );
      if (decision.trigger) {
        console.log(
          `[Pipeline] second opinion for ${submissionId} (${soCfg.model}): ${decision.reason}`,
        );
        const second = await compositeGrade(
          perImageResults,
          garmentInfo,
          undefined,
          soCfg.model,
          submissionId,
        );
        const verdict = evaluateSecondOpinion(
          compositeResult.overall_score,
          second.overall_score,
          soCfg,
        );
        detailedNotes["second_opinion"] = verdict.note;
        if (verdict.disagree) {
          compositeResult.confidence_score = composeConfidenceCap(
            compositeResult.confidence_score,
            verdict.confidenceCap,
          );
          // US-2299: BOTH halves. Lowering the value without lowering the
          // ceiling would let the next provenance boost lift the stored number
          // back over a cap applied because two models disagreed.
          confidenceCeiling = Math.min(confidenceCeiling, compositeResult.confidence_score);
          compositeResult.needs_human_review = true;
        }
      }
    } catch (err) {
      console.error(
        `[Pipeline] second opinion failed for ${submissionId} (skipped):`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // US-1296: Forensic Grade summary — record that the paid high-resolution
    // defect-zoom re-analysis ran and which defects it refined. The per-defect
    // detail is also carried in per_image_analysis (DetectedIssue.zoom_refined).
    if (wantForensic) {
      const refinedDefects = perImageResults.flatMap((r) =>
        r.detected_issues
          .filter((d) => d.zoom_refined)
          .map((d) => `${d.issue} (${d.location})`)
      );
      detailedNotes["forensic_summary"] = refinedDefects.length > 0
        ? `Forensic grade: ${refinedDefects.length} defect(s) re-analyzed at high ` +
          `resolution — ${refinedDefects.join("; ")}.`
        : "Forensic grade: high-resolution defect re-analysis ran; no defects " +
          "required a size/severity refinement.";
    }

    // Add intentional-design summary so the certificate / report can show that
    // distressing was assessed as styling, not counted as damage.
    if (compositeResult.style_attributes.length > 0) {
      detailedNotes["style_attributes_summary"] = compositeResult.style_attributes
        .map((s) => `${s.attribute}${s.location ? ` (${s.location})` : ""}`)
        .join("; ");
    }

    // Add an authenticity note when the photo-authenticity check (US-336/338)
    // flagged anything, so admins/reviewers see why the grade was held.
    const authenticity = compositeResult.image_authenticity;
    if (authenticity.manipulation_suspected || authenticity.screenshot_or_watermark_detected) {
      const tells = authenticity.tells.length > 0 ? ` Tells: ${authenticity.tells.join("; ")}.` : "";
      const where =
        authenticity.flagged_image_types.length > 0
          ? ` Images: ${authenticity.flagged_image_types.join(", ")}.`
          : "";
      detailedNotes["authenticity_summary"] = `${authenticity.summary}${tells}${where}`;
    }

    // US-601: premium counterfeit-confidence add-on note (owner/admin facing).
    // Clearly labeled as garment authenticity, distinct from the photo-tamper
    // "authenticity_summary" note above.
    if (authenticityAssessment) {
      const flags = authenticityAssessment.red_flags.length > 0
        ? ` Red flags: ${authenticityAssessment.red_flags.join("; ")}.`
        : "";
      detailedNotes["counterfeit_confidence"] =
        `${authenticityAssessment.summary} ` +
        `Authenticity confidence ${(authenticityAssessment.authenticity_confidence * 100).toFixed(0)}% ` +
        `(counterfeit risk: ${authenticityAssessment.counterfeit_risk}).${flags}`;
    }

    // US-337: photo-reuse detection. The same photo appearing under a DIFFERENT
    // account is the strong stolen/recycled-listing signal; a same-account match
    // is just a relist (recorded but not flagged).
    const reuse = await detectPhotoReuse({
      submissionId,
      ownerId: submission.user_id,
      images: images.map((img) => ({
        image_type: img.image_type,
        phash: (img as { phash?: string | null }).phash ?? null,
      })),
    });
    if (reuse.matched) {
      const closest = Math.min(...reuse.matches.map((m) => m.distance));
      detailedNotes["photo_reuse"] =
        `${reuse.summary} (${reuse.matches.length} image(s), closest ${closest} bits).`;
    }

    // US-861: derive the POSITIVE "original photos verified" buyer-trust signal
    // from the same scan. True only when we actually compared hashable images
    // and none matched a DIFFERENT account (stock/stolen-listing tell). A
    // cross-account match instead flags the submission below (moderation), so
    // this badge only ever appears on cleared, un-reused photos. Positive-only:
    // when the scan couldn't run (checked === 0) the signal is simply absent —
    // never a negative public claim. The public cert exposes only the boolean.
    const originalPhotos = {
      verified: originalPhotosVerified(reuse),
      checked: reuse.checked,
      checked_at: new Date().toISOString(),
    };

    // US-340: Verified Capture — opt-in provenance booster + badge. A POSITIVE
    // signal only: it can earn a badge + a small confidence boost but NEVER
    // lowers a grade, and missing EXIF is never penalized. Anti-gaming checks
    // (consistent recent unedited device, no cross-account reuse) run here,
    // server-side, so the opt-in flag alone grants nothing.
    const verifiedCapture = evaluateVerifiedCapture({
      optedIn: (submission as { verified_capture_opt_in?: boolean })
        .verified_capture_opt_in === true,
      submittedAtMs: Date.parse(
        (submission as { created_at?: string }).created_at ?? "",
      ) || Date.now(),
      images: images.map((img) => ({
        image_type: img.image_type,
        exif: ((img as { exif?: Record<string, unknown> | null }).exif) ?? null,
      })),
      crossUserReuse: reuse.cross_user,
      // US-1642: deny the provenance badge when the vision pass already suspects
      // manipulation / a screenshot-or-watermark (available here from the
      // composite `authenticity` computed above). The later forensic pass
      // further penalizes confidence + tightens the ceiling; this closes the
      // badge itself so provenance never vouches for a tampered image.
      manipulationSuspected: authenticity.manipulation_suspected === true ||
        authenticity.screenshot_or_watermark_detected === true,
      nowMs: Date.now(),
    });
    if (verifiedCapture.verified) {
      // Bump confidence (never down), respecting the partial-image ceiling so an
      // incomplete image set can't be boosted past its review cap.
      // US-1622 / C9: clamp the provenance boost to the running confidence
      // ceiling (tightened by any post-composite lowering event), not just the
      // partial-image cap — so a boost can't lift confidence back over a floor.
      const ceiling = confidenceCeiling;
      compositeResult.confidence_score = Math.min(
        ceiling,
        Math.max(
          compositeResult.confidence_score,
          compositeResult.confidence_score + verifiedCaptureBoost(),
        ),
      );
      detailedNotes["verified_capture"] =
        `Verified Capture earned — ${verifiedCapture.reasons.join("; ")}.`;
    } else if (
      (submission as { verified_capture_opt_in?: boolean })
        .verified_capture_opt_in === true
    ) {
      // Opted in but didn't qualify — record why for admin review. Not a flag,
      // not a penalty; the grade is unaffected.
      detailedNotes["verified_capture"] =
        `Verified Capture not earned — ${verifiedCapture.reasons.join("; ")}.`;
    }

    // US-341: server-side forensic / manipulation pass on RETAINED ORIGINALS.
    // A second, byte/structure-level line of manipulation evidence that runs
    // only where an uncompressed original was kept (US-339) and is fused with
    // the US-336 vision authenticity signal into one tamper assessment. The
    // fusion adjusts confidence + review routing; on a compressed-only
    // submission the pass is skipped cleanly and the result equals the vision
    // signal (no behavior change). Never throws — best-effort.
    const forensicInputs: ForensicInputImage[] = images.map((img) => ({
      image_type: img.image_type,
      original_storage_path:
        (img as { original_storage_path?: string | null })
          .original_storage_path ?? null,
      exif: ((img as { exif?: Record<string, unknown> | null }).exif) ?? null,
    }));
    const forensic = await runForensicPass(
      forensicInputs,
      async (storagePath) => {
        const { data, error } = await supabaseAdmin.storage
          .from("submission-images")
          .download(storagePath);
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
      },
    ).catch((err) => {
      console.error(
        `[Pipeline] Forensic pass error for submission ${submissionId}:`,
        err instanceof Error ? err.message : String(err),
      );
      // Fall back to a not-run assessment so fusion is just the vision signal.
      return {
        ran: false,
        analyzed_count: 0,
        tamper_likelihood: 0,
        suspected: false,
        per_image: [],
        tells: [],
        flagged_image_types: [],
        summary: "Forensic pass failed; vision signal only.",
      };
    });

    const fusedTamper = fuseTamperSignals(forensic, authenticity);
    if (fusedTamper.forensic_ran) {
      // Forensic evidence (pixel-level provenance) corroborates or contradicts
      // the vision check. Route to a human and shave confidence by the fused
      // penalty (floored at 0). The penalty can override an earlier
      // verified-capture boost — manipulation evidence must win over provenance.
      if (fusedTamper.needs_review) {
        compositeResult.needs_human_review = true;
        compositeResult.confidence_score = Math.max(
          0,
          compositeResult.confidence_score - fusedTamper.confidence_penalty,
        );
        // US-1622 / C9: manipulation evidence is a floor boosts can't cross.
        confidenceCeiling = Math.min(confidenceCeiling, compositeResult.confidence_score);
      }
      detailedNotes["forensic_analysis"] = fusedTamper.tells.length > 0
        ? `${fusedTamper.summary} Tells: ${fusedTamper.tells.join("; ")}.`
        : fusedTamper.summary;
    }

    // US-1283: Live Capture — fraud-proof grading mode. Built ON the Verified
    // Capture result + device-attestation (every photo captured live in-app) +
    // the fused manipulation verdict. A Live-Verified submission earns the
    // distinct, stronger badge AND a larger confidence boost; any provenance /
    // attestation / manipulation failure DOWNGRADES it (never a silent pass) to
    // the standard Verified Capture badge when provenance still independently
    // passed, else no badge. Runs after the forensic pass so the manipulation
    // signal is final. Never lowers a grade.
    const manipulationSuspected = fusedTamper.manipulation_suspected === true ||
      authenticity.manipulation_suspected === true ||
      authenticity.screenshot_or_watermark_detected === true;
    const liveCapture = evaluateLiveCapture({
      liveCaptureOptIn: (submission as { live_capture_opt_in?: boolean })
        .live_capture_opt_in === true,
      verifiedCapture,
      images: images.map((img) => ({
        image_type: img.image_type,
        capture_source:
          (img as { capture_source?: string | null }).capture_source ?? null,
      })),
      manipulationSuspected,
      nowMs: Date.now(),
    });
    if (liveCapture.badge === "live_verified") {
      // Live-Verified is the strongest provenance tier — apply the INCREMENTAL
      // boost over the standard Verified Capture boost already added above (a
      // live_verified result implies verifiedCapture.verified). Respect the
      // partial-image ceiling so an incomplete set can't be boosted past its cap.
      // US-1622 / C9: clamp the provenance boost to the running confidence
      // ceiling (tightened by any post-composite lowering event), not just the
      // partial-image cap — so a boost can't lift confidence back over a floor.
      const ceiling = confidenceCeiling;
      const extra = Math.max(0, liveCaptureBoost() - verifiedCaptureBoost());
      compositeResult.confidence_score = Math.min(
        ceiling,
        compositeResult.confidence_score + extra,
      );
      detailedNotes["live_capture"] =
        `Live-Verified earned — ${liveCapture.reasons.join("; ")}.`;
    } else if (
      (submission as { live_capture_opt_in?: boolean })
        .live_capture_opt_in === true
    ) {
      // Opted into Live Capture but didn't earn the top badge — record exactly
      // why for admin review. Not a flag, not a penalty.
      detailedNotes["live_capture"] =
        `Live-Verified not earned — ${liveCapture.reasons.join("; ")}.`;
    }

    // US-1762: Video Capture — the walk-around-clip provenance tier. Reads
    // `video_graded` (set only once frames were actually extracted and stored),
    // NEVER the opt-in: wanting to grade from a clip is not evidence, having
    // done so is. The claim is narrow and checkable — every view the buyer sees
    // came out of one continuous take this server decoded itself, so no single
    // angle could be swapped for a better-looking garment. Positive-only: a clip
    // that falls short simply earns no badge and grades exactly as it otherwise
    // would, with the reason kept server-side.
    const videoGraded =
      (submission as { video_graded?: boolean }).video_graded === true;
    const videoCapture = evaluateVideoCapture({
      videoGraded,
      images: images.map((img) => ({
        image_type: img.image_type,
        capture_source:
          (img as { capture_source?: string | null }).capture_source ?? null,
      })),
      durationSeconds:
        (submission as { video_duration_seconds?: number | null })
          .video_duration_seconds ?? null,
      manipulationSuspected,
      crossUserReuse: reuse.cross_user === true,
      // US-1766: whether the clip was recorded live in the in-app recorder. A
      // modifier on the earned badge, never a gate on it — a library clip that
      // passes every check still earns Video-Verified.
      captureSource:
        (submission as { video_capture_source?: string | null })
          .video_capture_source ?? null,
      nowMs: Date.now(),
    });
    if (videoGraded) {
      detailedNotes["video_capture"] = videoCapture.badge === "video_verified"
        ? `Video-Verified${
          videoCapture.live_captured ? " (live)" : ""
        } earned — ${videoCapture.reasons.join("; ")}.`
        : `Video-Verified not earned — ${videoCapture.reasons.join("; ")}.`;
    }

    // US-484: evaluate moderation flags BEFORE the certificate becomes public.
    // The grade_reports insert below carries a non-null certificate_id, which is
    // what makes /api/content/public/certificates/:id resolvable. If we only
    // flagged the submission AFTER that insert (the old order), there was a
    // window — and, if that later update failed, a PERMANENT leak — where a
    // suspect certificate was live and un-withheld. So decide the flag now and
    // write the withhold state first; the cert is born already-withheld and the
    // public endpoint 404s it (see isCertificateWithheld) until a human clears
    // it. The terminal status="completed" write still happens after the report
    // exists (Step 7), so a "completed" submission always has a report row.
    const flagReasons: string[] = [];
    if (!compositeResult.image_validity.is_clothing) {
      flagReasons.push(
        compositeResult.image_validity.reason ||
          "Submitted images may not depict an item of clothing."
      );
    }
    // US-336/US-338: route suspected-manipulation / screenshot submissions into
    // the moderation queue (in addition to needs_human_review on the grade).
    if (authenticity.manipulation_suspected || authenticity.screenshot_or_watermark_detected) {
      flagReasons.push(authenticity.summary);
    }
    // US-341: the fused forensic+vision tamper signal can flag manipulation the
    // vision pass alone missed (forensic-only or corroborated).
    if (
      fusedTamper.forensic_ran &&
      fusedTamper.manipulation_suspected &&
      fusedTamper.forensic_suspected
    ) {
      flagReasons.push(fusedTamper.summary);
    }
    // US-337: a cross-account photo match is a moderation concern (possible
    // stolen/recycled listing). Same-account relists are not flagged.
    if (reuse.cross_user) {
      flagReasons.push(reuse.summary);
    }
    const flagReason = flagReasons.length > 0 ? flagReasons.join(" ") : null;
    if (flagReason) {
      console.warn(
        `[Pipeline] Submission ${submissionId} FLAGGED for moderation: ${flagReason}`
      );
      await supabaseAdmin
        .from("submissions")
        .update({ flagged: true, flag_reason: flagReason })
        .eq("id", submissionId);
    }

    // US-1276: compute which standard inspection zones the photos documented,
    // from each image's view (image_type) + the vision pass's per-image zone
    // hints (issue/style/signal locations). Scopes the grade — and any future
    // coverage-gated guarantee (US-1279/1280) — to what was actually shown.
    const coverageSignals: CoverageImageSignal[] = perImageResults.map((r) => ({
      image_type: r.image_type,
      zone_hints: [
        ...r.detected_issues.flatMap((d) => [d.location, d.issue]),
        ...(r.style_attributes ?? []).map((s) => s.location),
        ...r.condition_signals.map((s) => s.signal),
      ].filter((s): s is string => typeof s === "string" && s.length > 0),
    }));
    const coverage = computeCoverage(submission.garment_category, coverageSignals);

    // US-1281: Verified 360 — premium photogrammetric/LiDAR true-geometric
    // capture. On a capable device the seller may opt into a guided 360 capture
    // that reports surface-coverage metrics; this server-side evaluator is the
    // authoritative gate. A passing capture earns the distinct '360-Verified'
    // badge, a bounded confidence boost, AND upgrades the stored coverage to
    // geometric-complete (every applicable zone documented → the widest
    // coverage-gated guarantee scope, US-1279). Any shortfall falls back to the
    // 2D zone coverage above; never required, never lowers a grade.
    const verified360 = evaluateVerified360({
      optedIn:
        (submission as { verified_360_opt_in?: boolean }).verified_360_opt_in ===
          true,
      report:
        ((submission as { capture_360?: Capture360Report | null }).capture_360 ??
          null),
      nowMs: Date.now(),
    });
    let coverageFinal: CoverageResult = coverage;
    if (verified360.verified) {
      // True geometric coverage documents the whole garment, so every applicable
      // inspection zone is covered — raise coverage confidence accordingly.
      coverageFinal = {
        ...coverage,
        covered_zones: coverage.applicable_zones,
        missing_zones: [],
        coverage_pct: coverage.applicable_zones.length === 0 ? 0 : 100,
        verified_360: true,
        coverage_source: "geometric_360",
      };
      // US-1622 / C9: clamp the provenance boost to the running confidence
      // ceiling (tightened by any post-composite lowering event), not just the
      // partial-image cap — so a boost can't lift confidence back over a floor.
      const ceiling = confidenceCeiling;
      compositeResult.confidence_score = Math.min(
        ceiling,
        compositeResult.confidence_score + verified360Boost(),
      );
      detailedNotes["verified_360"] = `${verified360.reasons.join("; ")}.`;
    } else if (
      (submission as { verified_360_opt_in?: boolean }).verified_360_opt_in ===
        true
    ) {
      // Opted in but didn't clear the thresholds — record why for admin review.
      // Not a flag, not a penalty; the 2D coverage stands.
      detailedNotes["verified_360"] = `${verified360.reasons.join("; ")}.`;
    }

    // US-1622 / C9: FINAL review-gate re-derivation — after EVERY post-composite
    // adjustment (penalties AND provenance boosts). The initial gate was computed
    // once inside compositeGrade; a later confidence-lowering event (a single
    // verification discrepancy, a peer-norm cap, a forensic shave) could drop the
    // effective confidence below the review threshold without setting the flag,
    // and a provenance boost could otherwise auto-finalize (publish a cert for)
    // that grade. The confidenceCeiling above already stops the boost from lifting
    // confidence back over the floor; this catches whatever still landed short.
    compositeResult.needs_human_review = reconcileNeedsReview(
      compositeResult.needs_human_review,
      compositeResult.confidence_score,
    );

    // US-333 + US-1279: tamper-evident integrity. Hash the canonical
    // (already-public) grade fields and sign the hash if CERT_SIGNING_KEY is set.
    // The public /cert/:id/verify endpoint re-derives this from the stored row to
    // confirm the certificate hasn't been altered (or a screenshot forged).
    // Sealed AFTER coverageFinal is determined (incl. the Verified-360 upgrade)
    // so the documented coverage SCOPE is part of the hash (integrity v3) — that
    // scope is what the coverage-gated guarantee (US-1280) is underwritten on, so
    // it must be provable after the fact. Any reseal-on-edit path (human-review)
    // MUST likewise pass buyer_writeup + coverage so the recomputed hash matches.
    const integrity = await buildCertIntegrity({
      certificate_id: certificateId,
      overall_score: compositeResult.overall_score,
      grade_tier: compositeResult.grade_tier,
      fabric_condition_score: compositeResult.factor_scores.fabric_condition,
      structural_integrity_score:
        compositeResult.factor_scores.structural_integrity,
      cosmetic_appearance_score:
        compositeResult.factor_scores.cosmetic_appearance,
      functional_elements_score:
        compositeResult.factor_scores.functional_elements,
      odor_cleanliness_score: compositeResult.factor_scores.odor_cleanliness,
      ai_summary: compositeResult.ai_summary,
      buyer_writeup: compositeResult.buyer_writeup,
      // US-1279: seal the documented coverage scope (v3).
      coverage_pct: coverageFinal.coverage_pct,
      covered_zones: coverageFinal.covered_zones,
      // US-2141: seal the coarse authenticity verdict (v4). Null whenever the
      // add-on didn't run, which is the common case — that seals a defined
      // empty verdict, not a missing key.
      authenticity_verdict: authenticityAssessment?.verdict ?? null,
      authenticity_verdict_confidence: authenticityAssessment?.verdict_confidence ?? null,
    });

    // US-2570: a certificate-number collision must not fail a PAID grade.
    //
    // generateUniqueCertNumber() does a SELECT-then-INSERT, so the real
    // uniqueness guarantee has always been the partial unique index (00307), not
    // its ten-attempt loop. A collision therefore surfaced here as "Failed to
    // create grade report record" — the money came back via
    // reverseChargeForUngradedSubmission, but the customer lost the grade they
    // waited for and had to resubmit. At 32^7 that is ~3e-5 per grade once a
    // million certificates exist: rare enough to have gone unnoticed, common
    // enough at volume to be somebody's Tuesday.
    //
    // Regenerating the NUMBER is safe: cert-integrity hashes certificate_id, not
    // the number, so `integrity` computed above stays valid across a retry.
    let certificateNumberAttempt = certificateNumber;
    let gradeReport: { id: string } | null = null;
    let reportError: { code?: string | null; message?: string | null } | null = null;

    for (let attempt = 0; attempt < CERT_NUMBER_INSERT_ATTEMPTS; attempt++) {
      const inserted = await supabaseAdmin
      .from("grade_reports")
      .insert({
        submission_id: submissionId,
        overall_score: compositeResult.overall_score,
        grade_tier: compositeResult.grade_tier,
        fabric_condition_score: compositeResult.factor_scores.fabric_condition,
        structural_integrity_score: compositeResult.factor_scores.structural_integrity,
        cosmetic_appearance_score: compositeResult.factor_scores.cosmetic_appearance,
        functional_elements_score: compositeResult.factor_scores.functional_elements,
        odor_cleanliness_score: compositeResult.factor_scores.odor_cleanliness,
        ai_summary: compositeResult.ai_summary,
        // US-759: longer buyer-facing certified write-up.
        buyer_writeup: compositeResult.buyer_writeup,
        detailed_notes: detailedNotes,
        // Intentional design features the AI judged present (distressing, raw
        // hems, etc.) — these did NOT lower the grade.
        detected_style_attributes: compositeResult.style_attributes,
        // GENUINE wear/damage (structured) — powers the Auto-Disclosure Engine
        // (condition & flaws section + annotated defect photos).
        defects_found: compositeResult.defects_found,
        // Full per-image trace for eval/training + dispute explanation.
        per_image_analysis: perImageResults,
        // US-1276: per-garment inspection-zone coverage (covered/missing zones +
        // coverage_pct) scoped to what the submitted photos actually documented.
        // US-1281: upgraded to geometric-complete when a Verified 360 capture passed.
        coverage: coverageFinal,
        // US-1281: server-side Verified 360 evaluation { verified, badge,
        // geometric_coverage_pct, depth_used, angles, reasons[], checked_at }.
        // Structured detail kept for admin review; the public view exposes only
        // the earned '360-Verified' badge tier.
        verified_360: verified360,
        // US-1762: server-side Video Capture evaluation { badge, video_graded,
        // frames_used, duration_seconds, reasons[], checked_at }. Structured
        // detail for admin review; the public view exposes only the earned
        // 'Video-Verified' badge tier.
        video_capture: videoCapture,
        // US-1296: whether the paid Forensic defect-zoom re-analysis ran. Which
        // defects were zoom-refined is in per_image_analysis (zoom_refined) +
        // detailed_notes.forensic_summary.
        forensic_grade: wantForensic,
        confidence_score: compositeResult.confidence_score,
        // US-1770 (AC2): a red-flag or sub-threshold brand-authenticity verdict
        // also forces human review (the persisted authenticity_assessment shows
        // the reviewer why). Never lowers the condition-grade confidence — the
        // two axes are independent.
        needs_human_review:
          compositeResult.needs_human_review || authenticityNeedsReview(authenticityAssessment),
        // Mandatory-review lifecycle: every grade is born PRELIMINARY and waits
        // for a human to finalize it. review_due_at = now + the requested grade-
        // speed tier SLA, so the operator queue can prioritise express first.
        review_status: "pending",
        review_due_at: new Date(
          Date.now() +
            (TIER_SLA_HOURS[
              ((submission as { service_tier?: string }).service_tier ??
                "standard") as keyof typeof TIER_SLA_HOURS
            ] ?? TIER_SLA_HOURS.standard) * 3_600_000,
        ).toISOString(),
        // US-336/US-338: aggregated photo-authenticity assessment (manipulation /
        // screenshot / watermark). Surfaced on the certificate + admin review.
        image_authenticity: compositeResult.image_authenticity,
        // US-340: Verified Capture provenance result. Structured detail kept for
        // admin review; the public view exposes only the pass/fail boolean.
        verified_capture: verifiedCapture,
        // US-1283: Live Capture (fraud-proof mode) evaluation. Structured detail
        // (badge tier, device-attestation, downgrade reasons) kept for admin
        // review; the public view exposes only the earned badge tier.
        live_capture: liveCapture,
        // US-861: POSITIVE "original photos verified" anti-fraud signal derived
        // from the photo-reuse scan. Only the `verified` boolean is exposed on
        // the public certificate (no hashes/match details leak).
        original_photos: originalPhotos,
        // US-601: premium authenticity / counterfeit-confidence add-on result.
        // Null when the add-on was not purchased. A confidence signal only;
        // limitations are embedded. The public cert view exposes only coarse,
        // buyer-safe fields (label/risk/summary/limitations), never raw red_flags.
        authenticity_assessment: authenticityAssessment,
        // US-341: forensic manipulation pass fused with the vision signal.
        // Stored only when an original was retained (else the pass didn't run);
        // internal anti-fraud data, never exposed on the public certificate.
        forensic_analysis: forensic.ran
          ? { ...fusedTamper, forensic }
          : null,
        // Record the real model + prompt version (e.g.
        // "claude-sonnet-4-6|composite_v2") so accuracy-tracking can
        // distinguish model changes, not just prompt revisions. prompt_version
        // is also stored on its own column for the accuracy join.
        model_version: `${compositeResult.model}|${compositeResult.prompt_version}`,
        prompt_version: compositeResult.prompt_version,
        // US-2432: the digest of the USER-message surface no version string
        // covers. prompt_version answers "which system prompt, and which blocks
        // were on"; this answers "which content did those blocks hold". Both are
        // needed before a grade record can say what produced it.
        //
        // SPREAD, not a plain key, for the same reason as tag_read below: until
        // 00562 applies, naming the column 42703s the whole insert and takes a
        // paid grade down with it. Omitting the key is what makes this commit
        // safe to deploy ahead of the SQL.
        ...(compositeResult.prompt_surface_hash
          ? { prompt_surface_hash: compositeResult.prompt_surface_hash }
          : {}),
        // US-2210: the verbatim label transcription this grade was identified
        // from, with per-field confidences and any seller disagreement. Absent
        // when the feature is off, there was no label photo, or nothing cleared
        // the confidence bar. INTERNAL for now — deliberately NOT added to the
        // public certificate's column allowlist (content-public.ts
        // CERT_REPORT_COLUMNS): publishing a machine read of someone's tag as
        // certified identity is a product decision that waits for the eval
        // numbers, not a side effect of storing it.
        //
        // US-2213: the verified size and its provenance. Its OWN column, not a
        // key inside tag_read — a measurement-derived size is not something the
        // tag said, and 00497's header records why that distinction is worth a
        // column. Same conditional-spread reasoning as tag_read below.
        ...(sizeVerification ? { size_verification: sizeVerification } : {}),
        // SPREAD, not a plain `tag_read: tagRead`: with the feature off tagRead
        // is null, and a null-VALUED key still NAMES the column in the PostgREST
        // payload — which 42703s the whole insert, and with it the paid grade, on
        // any environment where 00496 has not been applied. Omitting the key
        // entirely is what makes this commit safe to deploy ahead of the SQL.
        ...(tagRead ? { tag_read: tagRead } : {}),
        certificate_id: certificateId,
        certificate_number: certificateNumberAttempt,
        // US-333: tamper-evident integrity columns (migration 00068).
        content_hash: integrity.content_hash,
        content_signature: integrity.content_signature,
        integrity_version: integrity.integrity_version,
      })
      .select()
      .single();

      gradeReport = inserted.data as { id: string } | null;
      reportError = inserted.error;
      if (!reportError) break;

      // Anything that is NOT a certificate-number collision is a real failure.
      // Narrowed by CONSTRAINT NAME rather than by 23505 alone, so this can
      // never quietly paper over a different integrity violation.
      if (!isCertificateNumberConflict(reportError)) break;

      // Measurable: without this line the collision rate is invisible, and the
      // decision to widen the code space would have no evidence behind it.
      console.warn(
        `[Pipeline] certificate number collision on ${certificateNumberAttempt} ` +
          `for submission ${submissionId} (attempt ${attempt + 1}/` +
          `${CERT_NUMBER_INSERT_ATTEMPTS}) — regenerating.`,
      );
      certificateNumberAttempt = await generateUniqueCertNumber();
    }

    if (reportError || !gradeReport) {
      console.error("[Pipeline] Failed to create grade report:", reportError);
      // Exhausting the retries still throws, so the existing refund path is
      // unchanged: reverseChargeForUngradedSubmission returns the money exactly
      // as it did before this retry existed.
      throw new Error("Failed to create grade report record");
    }

    // US-2569: RESOLVE any open revision for this submission.
    //
    // The supersede that retired the previous certificate ran minutes ago, when
    // this replacement did not exist yet, so its row was written with the
    // superseding half NULL. Filling it here is what turns "revised, new grade
    // pending" into "the current grade is GT-XXXXXXX" on the retired
    // certificate's public page.
    //
    // Only rows that are still unresolved are touched: 00600's trigger refuses a
    // second resolution, so re-pointing an already-resolved revision would raise
    // — and this runs on every completed grade for the submission, including
    // ones that superseded nothing.
    //
    // Best-effort. A paid, completed grade must not fail because a history row
    // could not be updated; the cost of the failure is one certificate that
    // keeps saying "pending", which is still truthful.
    {
      const { error: resolveErr } = await supabaseAdmin
        .from("grade_report_revisions")
        .update({
          superseding_report_id: gradeReport.id,
          superseding_certificate_id: certificateId,
          superseding_certificate_number: certificateNumber,
          superseding_overall_score: compositeResult.overall_score,
          superseding_grade_tier: compositeResult.grade_tier,
          resolved_at: new Date().toISOString(),
        })
        .eq("submission_id", submission.id)
        .is("superseding_report_id", null);
      if (resolveErr) {
        console.error(
          `[Pipeline] revision resolve failed for submission ${submission.id}:`,
          resolveErr.message,
        );
        captureException(resolveErr, {
          route: "grading.revision-resolve",
          extra: { submissionId: submission.id, reportId: gradeReport.id },
        });
      }
    }

    // US-932: the "grade_completed" / "first_grade" drip + activation events now
    // fire from finalizeGradeReview (when a human makes the grade official), not
    // here — a preliminary grade isn't a completed grade.

    // US-1091/US-1282: seed (or grow) this certificate's Garment Passport and
    // link it via grade_reports.garment_id. Best-effort — neither path throws; a
    // passport failure must never fail a completed paid grade (the 00257 backfill
    // is idempotent and repairs any gaps later).
    //
    // US-1282: when the submission declares a re-grade of an EXISTING garment
    // (regrade_of_garment_id), APPEND a 'graded' event to that garment's ledger
    // so its condition history accumulates on one identity (the over-time curve)
    // instead of minting a second, unrelated passport. appendRegradeEvent is
    // tenant-scoped (created_by) and returns null for a forged/foreign id, in
    // which case we fall back to a fresh single-hop passport.
    const seedInput = {
      gradeReportId: gradeReport.id,
      createdByUserId: submission.user_id,
      skuClass: {
        brand: submission.brand ?? undefined,
        garment_type: submission.garment_type,
        category: submission.garment_category,
      },
      overallScore: compositeResult.overall_score,
      gradeTier: compositeResult.grade_tier,
      confidenceScore: compositeResult.confidence_score,
      certificateId: certificateId,
    };
    const regradeOfGarmentId =
      (submission as { regrade_of_garment_id?: string | null }).regrade_of_garment_id ?? null;
    let passportGarmentId: string | null = null;
    if (regradeOfGarmentId) {
      passportGarmentId = await appendRegradeEvent({
        ...seedInput,
        garmentId: regradeOfGarmentId,
      });
    }
    // First grade, or a re-grade whose target wasn't owned/resolvable → fresh seed.
    if (!passportGarmentId) {
      passportGarmentId = await createSingleHopPassport(seedInput);
    }

    // US-1841: a buyer-requested grade answers a question about one item in
    // their portfolio, so land the answer there too. Best-effort and tenant-
    // scoped; no-ops on every seller grade (closet_item_id is null).
    const closetItemId =
      (submission as { closet_item_id?: string | null }).closet_item_id ?? null;
    if (closetItemId) {
      await writeGradeToClosetItem({
        closetItemId,
        ownerUserId: submission.user_id,
        certificateId: certificateId,
        overallScore: compositeResult.overall_score,
      });
    }

    // US-2145 §1a: tell the seller when their item drew a red-flag verdict. A
    // seller cannot contest what they were never told about, and this verdict is
    // published on a public certificate, sealed into certificate integrity, and
    // written to the passport ledger — finding that out by accident is the
    // failure the appeal path exists to fix. Fires only on red_flags;
    // best-effort, so a notification problem never breaks a paid grade.
    void notifyAuthenticityFlagged(
      submission.user_id,
      authenticityAssessment?.verdict ?? null,
      submission.title ?? null,
      `/dashboard/submissions/${submission.id}`,
    );

    // US-2142: append the coarse authenticity verdict to the passport ledger so
    // provenance carries it alongside condition. Best-effort and no-ops when the
    // add-on didn't run or no brand was recognizable. The event records the
    // prompt version and whether the eval gate was satisfied, so entries written
    // by an as-yet-ungated pass (US-2130) stay identifiable rather than blending
    // into the record.
    if (passportGarmentId && authenticityAssessment) {
      const gate = await authenticityGateStatus(authenticityAssessment.prompt_version)
        .catch(() => ({ gated: false }));
      await appendAuthenticityEvent(passportGarmentId, authenticityAssessment, gate.gated);
    }

    // US-1848: the reward loop starts here. A grade that reached this point was
    // charged for at submit and never reversed, so `paid: true` is the truth —
    // which is the gate that makes grade-XP self-limiting: junk that abstains or
    // fails gets its charge reversed and earns nothing.
    //
    // The award is `coverage_completed`, not "graded", and it requires the full
    // front/back/label + ≥1 detail set. Rewarding coverage rather than volume
    // points the incentive at the thing that actually improves grade quality;
    // a three-photo minimum submission still grades, it just earns no XP for it.
    // Idempotent on the submission id, so a re-grade of the same submission
    // never double-awards.
    if (hasFullGradeCoverage(images)) {
      void grantReward(submission.user_id, "coverage_completed", {
        referenceId: submissionId,
        paid: true,
        source: "grading",
        metadata: { certificate_id: certificateId },
      }).catch((err) =>
        console.error(
          `[Pipeline] reward grant failed for ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        )
      );
    }

    // US-1097: store the garment's visual fingerprint (perceptual hashes of the
    // structured photos — reusing the phash already computed at upload — plus the
    // defect map + wear score) for later probabilistic same-item matching.
    // Best-effort; never affects the grade.
    if (passportGarmentId) {
      await storeGarmentFingerprint({
        garmentId: passportGarmentId,
        gradeReportId: gradeReport.id,
        images: images.map((i) => ({ image_type: i.image_type, phash: i.phash })),
        defects: compositeResult.defects_found,
        overallScore: compositeResult.overall_score,
      });
    }

    // US-1037: dual-write genuine defects to the normalized grade_defects table
    // (queryable type/size/area for analytics + calibration). defects_found jsonb
    // remains the disclosure source — this is a mirror, not a cutover. Best-effort:
    // a failure here must never fail or slow a completed paid grade.
    if (compositeResult.defects_found.length > 0) {
      const defectRows = compositeResult.defects_found.map((d) => ({
        grade_report_id: gradeReport.id,
        defect: d.defect,
        defect_type: d.defect_type ?? "other",
        severity: d.severity,
        repairability: d.repairability ?? null,
        size_bucket: d.size_bucket ?? "unknown",
        area_pct: d.area_pct ?? null,
        location: d.location ?? null,
        impact_on_grade: d.impact_on_grade ?? null,
      }));
      supabaseAdmin
        .from("grade_defects")
        .insert(defectRows)
        .then(({ error }) => {
          if (error) {
            console.error(
              `[Pipeline] grade_defects dual-write failed for ${submissionId}:`,
              error.message,
            );
          }
        });
    }

    // US-583: record per-call Anthropic token usage so the admin dashboard can
    // report per-grade AI cost + gross margin. Fire-and-forget — a cost-tracking
    // write must never fail or slow a completed paid grade.
    void recordAiUsage({
      userId: submission.user_id,
      submissionId,
      // US-1765: a grade produced from a clip is metered under its OWN feature.
      // The vision work is identical, but the COST SHAPE is not — one video
      // grade is N frames' worth of Vision calls against one grade's revenue,
      // so folding it into 'grading' would hide the only number that decides
      // whether video grading pays for itself. The ai_budgets rows and the
      // admin AI-spend / profitability breakout key off this exact string.
      feature: gradingUsageFeature(videoGraded),
      usages: [
        // US-1066: when the grade escalated, the cheap first-pass calls are
        // recorded under *_firstpass phases so the cascade's extra cost — and,
        // by contrast, the savings on grades that never escalate — are visible.
        ...firstPassUsages,
        ...perImageResults
          .filter((r) => r.usage)
          .map((r) => ({ phase: "per_image", usage: r.usage! })),
        ...(compositeResult.usage
          ? [{ phase: "composite", usage: compositeResult.usage }]
          : []),
      ],
    });

    // US-1771 (AC2): the premium authenticity add-on is metered under its OWN
    // feature ('authenticity') — not folded into the grade's 'grading' cost — so
    // the add-on's usage + margin are attributable on their own. (Was previously
    // a phase inside the grading call above; split out here, not double-counted.)
    if (authenticityAssessment?.usage) {
      void recordAiUsage({
        userId: submission.user_id,
        submissionId,
        feature: "authenticity",
        usages: [{ phase: "authenticity", usage: authenticityAssessment.usage }],
      });
    }

    // US-2210: the tag read is one extra vision call per grade, so it gets its
    // own feature row rather than being folded into the grading phases — the
    // point of turning it on is to be able to see what it costs against what it
    // is worth, and a cost buried inside "per_image" cannot be evaluated.
    if (tagOcr) {
      void recordAiUsage({
        userId: submission.user_id,
        submissionId,
        feature: "tag_ocr",
        usages: [{
          phase: "tag_ocr",
          usage: {
            model: tagOcr.model,
            // TagOcrResult.tokensIn already SUMS plain input + cache read +
            // cache creation, so the cache fields are zeroed here rather than
            // double-counted. extractTagGroundTruth sets no cache_control, so
            // in practice the whole count is plain input tokens anyway.
            inputTokens: tagOcr.tokensIn,
            outputTokens: tagOcr.tokensOut,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
          },
        }],
      });
    }

    // US-2213: the size pass is its own vision call, so it gets its own feature
    // row — the point of turning it on is to weigh what it costs against a
    // verified size being worth having, and a cost folded into "grading" cannot
    // be weighed.
    if (sizeEstimate) {
      void recordAiUsage({
        userId: submission.user_id,
        submissionId,
        feature: "size_estimate",
        usages: [{
          phase: "size_estimate",
          usage: {
            model: sizeEstimate.model,
            // tokensIn already sums plain + cache read + cache creation.
            inputTokens: sizeEstimate.tokensIn,
            outputTokens: sizeEstimate.tokensOut,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
          },
        }],
      });
    }

    // --- Step 7: Shadow / A-B grading (US-330, fire-and-forget) ---
    // Re-run ONLY the composite stage with any shadow candidate prompt on a
    // sampled fraction of live traffic, reusing the per-image analyses. Stored
    // separately in grading_shadow_results; NEVER affects this customer's grade
    // or certificate. Runs regardless of the review path. Never blocks/fails.
    void runShadowGrades({
      submissionId,
      userId: submission.user_id,
      gradeReportId: gradeReport.id,
      activePromptVersion: compositeResult.prompt_version,
      activeOverallScore: compositeResult.overall_score,
      activeGradeTier: compositeResult.grade_tier,
      activeFactorScores: compositeResult.factor_scores,
      perImageResults,
      garmentInfo,
    }).catch((err) =>
      console.error(
        `[Pipeline] shadow grading error for submission ${submissionId}:`,
        err instanceof Error ? err.message : String(err),
      )
    );

    // US-2443: the PER-IMAGE half. Re-analyzes the same photos under a
    // challenger per-image prompt (or block) and re-composites, so a per-image
    // change finally has live-traffic evidence. Re-downloads the images: the
    // base64 is long gone by now, on purpose (the buffer slot above scopes it),
    // and threading it here would defeat that memory gate for every submission
    // rather than the sampled few. OFF unless
    // PER_IMAGE_SHADOW_DAILY_VISION_CAP is set — it costs a vision call per
    // photo, not one cheap text call like the composite path above.
    //
    // Fire-and-forget, exactly like the call above, and this is the property
    // AC2 names: the grade this seller receives is already written and the
    // shadow leg is not awaited on ANY path. runPerImageShadowGrades also never
    // throws; both halves are test-guarded (grading-shadow-per-image_test.ts,
    // grading-shadow-isolation_test.ts).
    void runPerImageShadowGrades({
      submissionId,
      userId: submission.user_id,
      gradeReportId: gradeReport.id,
      images: images.map((i) => ({
        imageType: i.image_type,
        storagePath: i.storage_path,
      })),
      garmentInfo,
      styleHint,
      activePromptVersion: compositeResult.prompt_version,
      activeOverallScore: compositeResult.overall_score,
      activeGradeTier: compositeResult.grade_tier,
      activeFactorScores: compositeResult.factor_scores,
    }).catch((err) =>
      console.error(
        `[Pipeline] per-image shadow error for submission ${submissionId}:`,
        err instanceof Error ? err.message : String(err),
      )
    );

    // --- Step 8: Route the grade — auto-finalize or human review ---
    // A HIGH-CONFIDENCE, CLEAN grade (>= threshold, not routed to human review,
    // not flagged) skips the queue and finalizes immediately. Anything the
    // system is unsure about or has flagged still waits for a super-admin
    // (mandatory review). The threshold is GRADE_AUTO_APPROVE_CONFIDENCE
    // (default 0.9; "off" → fully-manual review).
    const reviewThreshold = autoApproveThreshold();
    const autoApprove = shouldAutoApprove(
      {
        confidenceScore: compositeResult.confidence_score,
        needsHumanReview: compositeResult.needs_human_review,
        flagged: Boolean(flagReason),
      },
      reviewThreshold,
    );
    const totalMs = Date.now() - startTime;

    if (autoApprove) {
      // Finalize now (reviewerId null = auto-approved, no human). All the go-live
      // wiring AND the seller's "now official" email + in-app notice run inside
      // finalizeGradeReview, so there's no preliminary/admin notification.
      await finalizeGradeReview(gradeReport.id, { reviewerId: null, modified: false });
      console.log(
        `[Pipeline] AUTO-APPROVED grade for submission ${submissionId} | ` +
          `overall_score=${compositeResult.overall_score} | grade_tier=${compositeResult.grade_tier} | ` +
          `confidence=${compositeResult.confidence_score} >= ${reviewThreshold} | total_ms=${totalMs}`,
      );
      return gradeReport;
    }

    // --- Preliminary review path (mandatory review) ---
    // Park the submission in `pending_review` (lease released, feedback cleared).
    // The certificate stays withheld and NOTHING goes live on the linked item
    // until a human finalizes it — all the go-live wiring moves to
    // finalizeGradeReview. linkedItemId is captured for the preliminary deep link.
    const linkedItemId = await applyPreliminaryReview(submissionId);
    console.log(
      `[Pipeline] Preliminary grade READY (pending review) for submission ${submissionId} | ` +
        `overall_score=${compositeResult.overall_score} | grade_tier=${compositeResult.grade_tier} | ` +
        `confidence=${compositeResult.confidence_score} | total_ms=${totalMs}`
    );

    const previewLink = linkedItemId
      ? `/dashboard/flipdesk/items/${linkedItemId}`
      : `/dashboard/submissions/${submissionId}`;

    // Tell the SELLER their preliminary grade is ready — email (respecting the
    // grade pref) + the in-app "pending review" notice.
    (async () => {
      try {
        const { data: user } = await supabaseAdmin
          .from("users")
          .select("email, full_name, notification_preferences")
          .eq("id", submission.user_id)
          .single();

        const emailEnabled =
          user?.notification_preferences?.grade_complete?.email !== false;

        if (user?.email && emailEnabled) {
          await sendGradePreliminaryEmail(user.email, {
            userName: user.full_name || "there",
            submissionTitle: submission.title,
            overallScore: compositeResult.overall_score,
            gradeTier: compositeResult.grade_tier,
            submissionId,
          });
        }
      } catch (emailErr) {
        console.error(
          `[Pipeline] Preliminary email error for submission ${submissionId}:`,
          emailErr instanceof Error ? emailErr.message : String(emailErr)
        );
      }
    })();

    void notifyGradePreliminary(submission.user_id, submission.title, previewLink)
      .catch((notifyErr) =>
        console.error(
          `[Pipeline] Preliminary notify error for submission ${submissionId}:`,
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        )
      );

    // Alert REVIEWERS — a grade is waiting to be finalized. In-app for every
    // admin + super-admin; email to the super-admins. Best-effort.
    void notifyAdminsGradeReviewNeeded({
      submissionTitle: submission.title,
      overallScore: compositeResult.overall_score,
      gradeTier: compositeResult.grade_tier,
      serviceTier:
        (submission as { service_tier?: string }).service_tier ?? "standard",
      confidenceScore: compositeResult.confidence_score,
      flagged: Boolean(flagReason),
    });

    return gradeReport;
  } catch (error) {
    const totalMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error(
      `[Pipeline] Grading pipeline FAILED for submission ${submissionId} | ` +
        `total_ms=${totalMs} | error=${errorMessage}`
    );

    // US-1643: if a grade report was ALREADY inserted, the grade was produced and
    // the failure is in a POST-grade side effect (notify / webhook / item-sync /
    // finalize). Marking the submission 'failed', reversing the charge, syncing
    // FlipDesk to 'failed', or telling the seller "grading failed" would all be
    // wrong — they'd create a "refunded + graded" / "failed + graded" state
    // nothing reconciles. The grade stands; just log the side-effect error and
    // rethrow so the caller/reaper still sees it.
    const { data: existingReport } = await supabaseAdmin
      .from("grade_reports")
      .select("id")
      .eq("submission_id", submissionId)
      .is("superseded_at", null)
      .maybeSingle();
    if (existingReport) {
      console.warn(
        `[Pipeline] submission ${submissionId} failed AFTER its grade report was inserted — ` +
          `grade stands; NOT marking failed, reversing charge, or notifying failure. error=${errorMessage}`,
      );
      throw error;
    }

    // Update submission status to 'failed'
    try {
      await supabaseAdmin
        .from("submissions")
        .update({ status: "failed" })
        .eq("id", submissionId);
    } catch (updateError) {
      console.error(
        `[Pipeline] Failed to update submission status to 'failed':`,
        updateError
      );
    }

    // Reverse the charge taken before the pipeline ran. See
    // reverseChargeForUngradedSubmission().
    await reverseChargeForUngradedSubmission(submissionId, "grading failed");

    // Mirror failure into the FlipDesk link so the bridge UI doesn't
    // hang at "processing" forever.
    try {
      await supabaseAdmin
        .from("flipdesk_grading_submissions")
        .update({
          status: "failed",
          error: errorMessage.slice(0, 500),
        })
        .eq("submission_id", submissionId);
    } catch (fdErr) {
      console.error(
        `[Pipeline] FlipDesk failure-sync error for submission ${submissionId}:`,
        fdErr instanceof Error ? fdErr.message : String(fdErr)
      );
    }

    // US-1056: tell the seller the grade failed (the charge was reversed above)
    // instead of leaving the submission silently 'failed'. `submission` may not
    // be in scope here (the failure could predate its fetch), so resolve the
    // owner + title cheaply. Best-effort — never masks the original error.
    try {
      const { data: owner } = await supabaseAdmin
        .from("submissions")
        .select("user_id, title")
        .eq("id", submissionId)
        .maybeSingle();
      const ownerRow = owner as { user_id?: string; title?: string | null } | null;
      if (ownerRow?.user_id) {
        void notifyGradingFailed(ownerRow.user_id, ownerRow.title ?? null);
      }
    } catch (notifyErr) {
      console.error(
        `[Pipeline] failure-notify error for submission ${submissionId}:`,
        notifyErr instanceof Error ? notifyErr.message : String(notifyErr)
      );
    }

    throw error;
  }
}

// Quick-grade primitive (shared by Snap-to-Value US-612 + ScoutAI US-616).
//
// Runs the REAL grader (analyzeImage + compositeGrade) on a small set of images
// WITHOUT creating a submission row, certificate, or billing event — so it can
// grade an uploaded photo (Snap) or another seller's listing photos (ScoutAI's
// private shadow grade). Image inputs may be data-URIs (uploads) or http(s)
// URLs (eBay photos); URLs are fetched through the SSRF guard, capped in size,
// and require an image content-type.

import {
  analyzeImage,
  compositeGrade,
  type CompositeGradeResult,
  type GarmentInfo,
  type PerImageAnalysis,
} from "./ai-grading.ts";
import { safeFetch } from "./ssrf.ts";
import { captureException } from "./observability.ts";
import { AiCeilingError } from "./ai-limiter.ts";
import { applyPostCompositeCaps } from "./post-composite-caps.ts";
import {
  DEFAULT_PEER_NORM_CONFIG,
  evaluatePeerNorm,
  fetchPeerDistribution,
  type PeerNormConfig,
} from "./peer-norm.ts";
import { reviewConfidenceThreshold } from "./ai-config.ts";
import { getSetting } from "./system-settings.ts";
import { type AiTokenUsage } from "./ai-usage.ts";

// Bound cost/latency: a quick grade never analyzes more than this many images.
const MAX_QUICK_IMAGES = 4;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB per image

export interface QuickGradeImage {
  /** A data: URI or raw base64 (uploads). */
  dataUri?: string;
  /** An http(s) image URL (e.g. an eBay listing photo). */
  url?: string;
  /** Optional role hint (front/back/label/detail/defect). Defaults to "detail". */
  type?: string;
}

export interface QuickGradeResult {
  overallScore: number;
  gradeTier: string;
  confidence: number;
  needsHumanReview: boolean;
  /**
   * US-2309: how high this confidence is allowed to go afterwards.
   *
   * Returned rather than kept internal because a cap that lowers the value and
   * not the ceiling is not a cap (US-2299) — any caller that later boosts on
   * provenance has to clamp to this. Nothing boosts a quick grade today, and
   * that is exactly why the ceiling has to leave the function: the next caller
   * to add one must not have to discover the rule.
   */
  confidenceCeiling: number;
  /** Which post-composite caps fired, if any. Empty on an uncapped grade. */
  capsApplied: string[];
  factorScores: CompositeGradeResult["factor_scores"];
  imagesAnalyzed: number;
  // US-1836: COARSE photo-authenticity signal only (booleans + confidence). The
  // internal `tells` / `flagged_image_types` NEVER leave the grader.
  imageAuthenticity: {
    manipulation_suspected: boolean;
    manipulation_confidence: number;
    screenshot_or_watermark_detected: boolean;
  };
  /**
   * US-2845: what this grade cost, per Anthropic call.
   *
   * RETURNED RATHER THAN RECORDED HERE, because who pays differs by caller: a
   * seller's snap is billed per grade, the public checker is deliberately
   * unmetered, and a comp read is platform spend under its own budget. quickGrade
   * cannot know which, so it hands the tokens back and the caller files them.
   *
   * This is load-bearing for the comp_read budget: ai_budget_status rolls up
   * ai_usage_events BY FEATURE, so a comp read that writes no usage row leaves
   * that budget reading zero forever and its kill switch is decorative.
   */
  usages: Array<{ phase: string; usage: AiTokenUsage }>;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Resolve one image input to a data-URI analyzeImage can consume. Returns null
// (skip) on a fetch/type/size problem rather than failing the whole grade.
async function resolveToDataUri(img: QuickGradeImage): Promise<string | null> {
  if (img.dataUri && img.dataUri.length > 0) return img.dataUri;
  if (!img.url) return null;
  try {
    // safeFetch validates the URL against the private-range blocklist, caps the
    // body, and returns the bytes directly.
    const { status, bytes, contentType } = await safeFetch(img.url, {
      timeoutMs: 8000,
      maxBytes: MAX_IMAGE_BYTES,
    });
    if (status < 200 || status >= 300) return null;
    if (!contentType || !contentType.startsWith("image/")) return null;
    if (bytes.byteLength === 0) return null;
    const mediaType = contentType.split(";")[0] || "image/jpeg";
    return `data:${mediaType};base64,${uint8ToBase64(bytes)}`;
  } catch (err) {
    captureException(err, { level: "warn", route: "quick-grade.fetch_image" });
    return null;
  }
}

export interface QuickGradeInput {
  images: QuickGradeImage[];
  /** Best-effort garment context (from a listing title/category or user pick). */
  garment?: Partial<GarmentInfo>;
}

/**
 * The per-image half of a quick grade, held between the two vision phases.
 *
 * Opaque on purpose: the shape is an implementation detail of this module and a
 * caller has no business reading `perImage` and deciding something from it.
 */
export interface QuickGradeAnalysis {
  perImage: PerImageAnalysis[];
  usages: Array<{ phase: string; usage: AiTokenUsage }>;
  /** How many images were SUBMITTED, so the partial-set cap can still fire. */
  requested: number;
  fabricCloseupMissing: boolean;
}

/**
 * What the per-image pass needs to know about the garment.
 *
 * Two fields, and they are the ONLY two `analyzeImage` receives. That is what
 * makes the split below safe: brand and title reach the composite call and
 * nothing else, so a caller that does not yet know the brand can still start
 * looking at the photo (US-3026).
 */
export interface QuickGradeImageContext {
  garment_type?: string;
  garment_category?: string;
}

/**
 * PHASE ONE: look at the photos. Throws if no usable image resolves.
 *
 * Split out of `quickGrade` for /prospect, where identifying the garment and
 * grading it are two vision calls that ran back to back for no reason. The
 * identification takes six seconds and the per-image analysis takes five, and
 * the second one needs nothing the first produces - `analyzeImage` receives
 * only the garment type and category, which /prospect has never had at this
 * point and passes as the defaults either way. Running them at the same time
 * takes those five seconds off every scan and cannot change the grade, because
 * both calls receive byte-identical inputs to the ones they received before.
 */
export async function analyzeQuickImages(
  images: QuickGradeImage[],
  context: QuickGradeImageContext = {},
): Promise<QuickGradeAnalysis> {
  const garmentType = context.garment_type || "clothing";
  const garmentCategory = context.garment_category || "";

  const inputs = images.slice(0, MAX_QUICK_IMAGES);
  const dataUris = (await Promise.all(inputs.map(resolveToDataUri))).map((d, i) => ({
    dataUri: d,
    type: inputs[i].type || "detail",
  })).filter((x): x is { dataUri: string; type: string } => x.dataUri !== null);

  if (dataUris.length === 0) {
    throw new Error("No usable images to grade");
  }

  const usages: Array<{ phase: string; usage: AiTokenUsage }> = [];
  const perImage: PerImageAnalysis[] = [];
  for (const { dataUri, type } of dataUris) {
    try {
      const analysis = await analyzeImage(dataUri, type, garmentType, garmentCategory);
      if (analysis.usage) usages.push({ phase: `quick_image_${type}`, usage: analysis.usage });
      perImage.push(analysis);
    } catch (err) {
      // US-1883 (AC3): a global AI-ceiling / capacity error is SYSTEMIC, not a
      // per-image problem — retrying the remaining images just burns more budget
      // and, worse, the empty result below masks it as "Image analysis failed"
      // which the public routes mis-report as a bad-URL 400. Propagate it so the
      // caller can return a distinct 503 "at capacity".
      if (err instanceof AiCeilingError) throw err;
      captureException(err, { level: "warn", route: "quick-grade.analyze" });
    }
  }
  if (perImage.length === 0) {
    throw new Error("Image analysis failed for all images");
  }

  // US-2397: a quick grade is usually front/back shots off a listing, so the
  // missing-close-up case is the COMMON one here rather than the exception.
  // Passed through so compositeGrade applies the same cap the full path does;
  // with a close-up present this argument is false and nothing changes.
  const fabricCloseupMissing = !dataUris.some((d) => /detail|fabric/i.test(d.type));

  return { perImage, usages, requested: inputs.length, fabricCloseupMissing };
}

/**
 * Grade a small image set and return a slim, certificate-free result. Throws if
 * no usable image resolves. Caller is responsible for auth, quota/cost gating,
 * and labeling the output as an ESTIMATE (not a certified grade).
 */
export async function quickGrade(input: QuickGradeInput): Promise<QuickGradeResult> {
  const analysis = await analyzeQuickImages(input.images, {
    garment_type: input.garment?.garment_type,
    garment_category: input.garment?.garment_category,
  });
  return await compositeQuickGrade(analysis, input.garment);
}

/**
 * PHASE TWO: turn the per-image reads into one grade. Needs the brand and title.
 *
 * Every confidence cap, the peer-norm check and the review threshold live here,
 * unchanged and in the same order - this is the same code that used to be the
 * back half of `quickGrade`, and `quickGrade` is now literally the two phases
 * called in a row.
 */
export async function compositeQuickGrade(
  analysis: QuickGradeAnalysis,
  garmentInput?: Partial<GarmentInfo>,
): Promise<QuickGradeResult> {
  const garment: GarmentInfo = {
    garment_type: garmentInput?.garment_type || "clothing",
    garment_category: garmentInput?.garment_category || "",
    brand: garmentInput?.brand ?? null,
    title: garmentInput?.title || "",
    description: garmentInput?.description ?? null,
    style_attributes: garmentInput?.style_attributes,
  };
  const { perImage, fabricCloseupMissing } = analysis;
  const usages = [...analysis.usages];

  const composite = await compositeGrade(
    perImage,
    garment,
    undefined,
    undefined,
    undefined,
    "",
    [],
    false,
    "",
    fabricCloseupMissing,
  );
  if (composite.usage) usages.push({ phase: "quick_composite", usage: composite.usage });

  // US-2309: the caps that can only be known after the composite. Until this,
  // quick-grade returned needs_human_review straight out and saw none of them —
  // so a Snap-to-Value or extension estimate could report 0.8 where the full
  // pipeline would have capped it at 0.6, while the public methodology page
  // promises anything under 0.75 reaches a human.
  //
  // PARTIAL means "fewer images reached the grader than the caller supplied",
  // counted at both drop points: an image that would not resolve, and one whose
  // analysis threw. Either way the grade is a read of less than it was given.
  // Carried across the phase split rather than recounted, because phase two no
  // longer sees the submitted list and a recount there would always say zero
  // were dropped.
  const requested = analysis.requested;
  const partialImageSet = perImage.length < requested;

  // Peer-norm is a DB read and a pure comparison — no vision call — so it stays
  // inside the latency budget the name promises. Best-effort exactly as in the
  // pipeline: any failure skips the check, never the grade.
  let peerNormCap: number | null = null;
  try {
    const peerCfg: PeerNormConfig = {
      ...DEFAULT_PEER_NORM_CONFIG,
      ...(await getSetting<Partial<PeerNormConfig>>("grading_peer_norm", {})),
    };
    if (peerCfg.enabled) {
      const dist = await fetchPeerDistribution({
        garmentCategory: garment.garment_category,
        brand: garment.brand,
        defectSeverities: composite.defects_found.map((d) => d.severity),
        minSampleSize: peerCfg.minSampleSize,
      });
      const verdict = evaluatePeerNorm(composite.overall_score, dist, peerCfg);
      if (verdict.flagged) peerNormCap = verdict.confidenceCap;
    }
  } catch (err) {
    captureException(err, { level: "warn", route: "quick-grade.peer_norm" });
  }

  const capped = applyPostCompositeCaps({
    confidence: composite.confidence_score,
    ceiling: composite.confidence_ceiling ?? 1,
    reviewThreshold: reviewConfidenceThreshold(),
    partialImageSet,
    verificationDiscrepancies: composite.verification_discrepancies?.length ?? 0,
    peerNormCap,
  });

  const auth = composite.image_authenticity;
  return {
    overallScore: composite.overall_score,
    gradeTier: composite.grade_tier,
    confidence: capped.confidence,
    // OR, not replace: compositeGrade may already have forced review for a
    // reason these caps know nothing about (an authenticity flag, a defaulted
    // factor). A cap can only ever ADD a reason to look.
    needsHumanReview: composite.needs_human_review || capped.needsHumanReview,
    confidenceCeiling: capped.ceiling,
    capsApplied: capped.applied,
    factorScores: composite.factor_scores,
    imagesAnalyzed: perImage.length,
    imageAuthenticity: {
      manipulation_suspected: auth?.manipulation_suspected === true,
      manipulation_confidence: typeof auth?.manipulation_confidence === "number" ? auth.manipulation_confidence : 0,
      screenshot_or_watermark_detected: auth?.screenshot_or_watermark_detected === true,
    },
    usages,
  };
}

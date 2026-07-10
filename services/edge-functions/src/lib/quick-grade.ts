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
  factorScores: CompositeGradeResult["factor_scores"];
  imagesAnalyzed: number;
  // US-1836: COARSE photo-authenticity signal only (booleans + confidence). The
  // internal `tells` / `flagged_image_types` NEVER leave the grader.
  imageAuthenticity: {
    manipulation_suspected: boolean;
    manipulation_confidence: number;
    screenshot_or_watermark_detected: boolean;
  };
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
 * Grade a small image set and return a slim, certificate-free result. Throws if
 * no usable image resolves. Caller is responsible for auth, quota/cost gating,
 * and labeling the output as an ESTIMATE (not a certified grade).
 */
export async function quickGrade(input: QuickGradeInput): Promise<QuickGradeResult> {
  const garment: GarmentInfo = {
    garment_type: input.garment?.garment_type || "clothing",
    garment_category: input.garment?.garment_category || "",
    brand: input.garment?.brand ?? null,
    title: input.garment?.title || "",
    description: input.garment?.description ?? null,
    style_attributes: input.garment?.style_attributes,
  };

  const inputs = input.images.slice(0, MAX_QUICK_IMAGES);
  const dataUris = (await Promise.all(inputs.map(resolveToDataUri))).map((d, i) => ({
    dataUri: d,
    type: inputs[i].type || "detail",
  })).filter((x): x is { dataUri: string; type: string } => x.dataUri !== null);

  if (dataUris.length === 0) {
    throw new Error("No usable images to grade");
  }

  const perImage: PerImageAnalysis[] = [];
  for (const { dataUri, type } of dataUris) {
    try {
      perImage.push(await analyzeImage(dataUri, type, garment.garment_type, garment.garment_category));
    } catch (err) {
      captureException(err, { level: "warn", route: "quick-grade.analyze" });
    }
  }
  if (perImage.length === 0) {
    throw new Error("Image analysis failed for all images");
  }

  const composite = await compositeGrade(perImage, garment);
  const auth = composite.image_authenticity;
  return {
    overallScore: composite.overall_score,
    gradeTier: composite.grade_tier,
    confidence: composite.confidence_score,
    needsHumanReview: composite.needs_human_review,
    factorScores: composite.factor_scores,
    imagesAnalyzed: perImage.length,
    imageAuthenticity: {
      manipulation_suspected: auth?.manipulation_suspected === true,
      manipulation_confidence: typeof auth?.manipulation_confidence === "number" ? auth.manipulation_confidence : 0,
      screenshot_or_watermark_detected: auth?.screenshot_or_watermark_detected === true,
    },
  };
}

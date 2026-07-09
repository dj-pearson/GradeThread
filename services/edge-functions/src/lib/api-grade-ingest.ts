// US-1790: shared image ingest for the public grading API — used by BOTH the
// single POST /grades and the batch worker so they harden images identically.
//
// Given a created submission's id + the request images, this decodes/fetches
// (SSRF-guarded), magic-byte-validates, strips EXIF/GPS, computes the server-side
// reuse hash, uploads to submission-images, and returns the submission_image rows
// to insert — OR a typed failure with the storage it already wrote cleaned up.
// It NEVER deletes the submission row (the caller owns that lifecycle, since the
// single path 400s the request while the batch path fails just that job).

import { supabaseAdmin } from "./supabase.ts";
import { decodeBase64Image } from "./validation.ts";
import { validateImageUpload } from "./upload-validation.ts";
import { stripImageMetadata } from "./image-metadata.ts";
import { computePhashFromImage } from "./perceptual-hash.ts";
import { safeFetch } from "./ssrf.ts";
import { GARMENT_CATEGORIES, GARMENT_TYPES } from "./ai-extract.ts";
import { type GradeTier, isGradeTier } from "./grade-billing.ts";

export interface GradeImageInput {
  image_type: string;
  url?: string;
  base64?: string;
  content_type?: string;
}

// Mirror of the single-grade image slots in routes/api-v1.ts (which mirrors
// src/lib/constants.ts). Kept here so the batch path validates garments against
// the IDENTICAL slot set + caps as a single API grade, without importing from a
// route module. See api-v1.ts for the per-slot rationale.
export const GRADE_IMAGE_TYPES = [
  "front", "back", "label", "label_2",
  "detail", "detail_2", "detail_3", "detail_4",
  "defect",
  "measurement_chest", "measurement_waist", "measurement_length",
  "measurement_sleeve", "measurement_inseam",
] as const;
export const GRADE_REQUIRED_IMAGE_TYPES = ["front", "back", "label"] as const;
export const GRADE_MAX_IMAGES_PER_SUBMISSION = GRADE_IMAGE_TYPES.length;

export interface GradeGarmentInput {
  title?: string;
  garment_type?: string;
  garment_category?: string;
  brand?: string;
  description?: string;
  tier?: string;
  images?: GradeImageInput[];
}

export type ValidateGarmentResult =
  | { ok: true; tier: GradeTier }
  | { ok: false; errors: string[] };

/**
 * Validate one garment submission (fields + images) against the SAME rules the
 * single POST /grades handler enforces inline: required title/type/category,
 * a valid non-empty image set within the cap, no duplicate slots, each image
 * with exactly one of url|base64 (https + content_type rules), the three
 * required slots, and ≥1 detail. Pure — returns the resolved tier or the same
 * human-readable `errors` list the single path returns. The batch endpoint runs
 * this per garment at enqueue time so a caller gets immediate 400 feedback,
 * exactly like a single grade, instead of discovering bad input as failed jobs.
 */
export function validateGradeGarment(body: GradeGarmentInput): ValidateGarmentResult {
  const errors: string[] = [];
  const { title, garment_type, garment_category, images } = body;

  if (!title || title.trim().length === 0) {
    errors.push("title is required");
  }
  if (!garment_type || !GARMENT_TYPES.includes(garment_type as (typeof GARMENT_TYPES)[number])) {
    errors.push(`garment_type must be one of: ${GARMENT_TYPES.join(", ")}`);
  }
  if (
    !garment_category ||
    !GARMENT_CATEGORIES.includes(garment_category as (typeof GARMENT_CATEGORIES)[number])
  ) {
    errors.push(`garment_category must be one of: ${GARMENT_CATEGORIES.join(", ")}`);
  }

  if (!images || !Array.isArray(images) || images.length === 0) {
    errors.push("images array is required and must not be empty");
  } else if (images.length > GRADE_MAX_IMAGES_PER_SUBMISSION) {
    errors.push(`images array may contain at most ${GRADE_MAX_IMAGES_PER_SUBMISSION} images`);
  } else {
    const imageTypes: string[] = [];
    const seenTypes = new Set<string>();

    for (let i = 0; i < images.length; i++) {
      const img = images[i];

      if (!img.image_type || !GRADE_IMAGE_TYPES.includes(img.image_type as (typeof GRADE_IMAGE_TYPES)[number])) {
        errors.push(`images[${i}].image_type must be one of: ${GRADE_IMAGE_TYPES.join(", ")}`);
        continue;
      }
      if (seenTypes.has(img.image_type)) {
        errors.push(`images[${i}].image_type '${img.image_type}' is a duplicate; each image type may appear at most once`);
        continue;
      }
      seenTypes.add(img.image_type);

      if (!img.url && !img.base64) {
        errors.push(`images[${i}] must provide either url or base64`);
        continue;
      }
      if (img.url && img.base64) {
        errors.push(`images[${i}] must provide either url or base64, not both`);
        continue;
      }
      if (img.base64 && !img.content_type) {
        errors.push(`images[${i}].content_type is required when providing base64 data`);
        continue;
      }
      if (img.url) {
        let parsed: URL | null = null;
        try {
          parsed = new URL(img.url);
        } catch {
          errors.push(`images[${i}].url is not a valid URL`);
          continue;
        }
        if (parsed.protocol !== "https:") {
          errors.push(`images[${i}].url must use https`);
          continue;
        }
      }

      imageTypes.push(img.image_type);
    }

    for (const required of GRADE_REQUIRED_IMAGE_TYPES) {
      if (!imageTypes.includes(required)) {
        errors.push(`A '${required}' image is required`);
      }
    }
    if (!imageTypes.some((t) => t.startsWith("detail"))) {
      errors.push("At least one 'detail' image is required");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, tier: isGradeTier(body.tier) ? body.tier : "standard" };
}

export interface IngestedImageRow {
  submission_id: string;
  image_type: string;
  storage_path: string;
  display_order: number;
  phash: string | null;
}

export type IngestResult =
  | { ok: true; imageRecords: IngestedImageRow[] }
  | { ok: false; code: string; detail: string; status: 400 | 500 };

async function cleanup(records: IngestedImageRow[]): Promise<void> {
  for (const r of records) {
    await supabaseAdmin.storage.from("submission-images").remove([r.storage_path]);
  }
}

/**
 * Decode/fetch → validate → strip → hash → upload each image for a submission.
 * On any per-image failure, removes whatever it already uploaded and returns a
 * typed error. `nowFn` is injected so the storage path timestamp is testable.
 */
export async function ingestGradeImages(
  userId: string,
  submissionId: string,
  images: GradeImageInput[],
): Promise<IngestResult> {
  const imageRecords: IngestedImageRow[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const timestamp = Date.now();
    let imageData: ArrayBuffer;

    try {
      if (img.base64) {
        const decoded = decodeBase64Image(img.base64, img.content_type);
        if (!decoded.ok) throw new Error(decoded.error);
        imageData = decoded.image.bytes.buffer.slice(
          decoded.image.bytes.byteOffset,
          decoded.image.bytes.byteOffset + decoded.image.bytes.byteLength,
        ) as ArrayBuffer;
      } else {
        // US-344: fetch through the SSRF guard (private-range block + redirect
        // re-validation + size/time caps).
        const fetched = await safeFetch(img.url!, { maxBytes: 25 * 1024 * 1024, timeoutMs: 10_000 });
        if (fetched.status < 200 || fetched.status >= 300) {
          throw new Error(`HTTP ${fetched.status} fetching image from URL`);
        }
        imageData = fetched.bytes.buffer.slice(
          fetched.bytes.byteOffset,
          fetched.bytes.byteOffset + fetched.bytes.byteLength,
        ) as ArrayBuffer;
      }
    } catch (err) {
      await cleanup(imageRecords);
      return {
        ok: false,
        code: "image_unreadable",
        detail: `decode failed for ${img.image_type}: ${err instanceof Error ? err.message : String(err)}`,
        status: 400,
      };
    }

    // US-276: magic-byte validation (not the declared content-type) + EXIF strip.
    const rawBytes = new Uint8Array(imageData);
    const verdict = validateImageUpload(rawBytes, { allow: ["jpeg", "png", "webp"] });
    if (!verdict.ok) {
      await cleanup(imageRecords);
      return { ok: false, code: "image_invalid", detail: `${img.image_type}: ${verdict.reason}`, status: 400 };
    }
    const { bytes: cleanBytes } = stripImageMetadata(rawBytes, verdict.format);
    // US-480: server-side reuse hash from the stored bytes (never the client).
    const serverPhash = await computePhashFromImage(cleanBytes, verdict.format);
    const storagePath = `${userId}/${submissionId}/${img.image_type}_${timestamp}.${verdict.ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(storagePath, cleanBytes, { contentType: verdict.contentType, upsert: false });
    if (uploadError) {
      await cleanup(imageRecords);
      return { ok: false, code: "image_upload_failed", detail: uploadError.message, status: 500 };
    }

    imageRecords.push({
      submission_id: submissionId,
      image_type: img.image_type,
      storage_path: storagePath,
      display_order: i,
      phash: serverPhash,
    });
  }

  const { error: imageInsertError } = await supabaseAdmin.from("submission_images").insert(imageRecords);
  if (imageInsertError) {
    await cleanup(imageRecords);
    return { ok: false, code: "image_save_failed", detail: imageInsertError.message, status: 500 };
  }

  return { ok: true, imageRecords };
}

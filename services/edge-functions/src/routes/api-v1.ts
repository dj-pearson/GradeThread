import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { billingMonthStartIso, computeQuotaState } from "../lib/api-quota.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";
import {
  type GradeTier,
  isGradeTier,
  type PrecedenceResult,
  runPaymentPrecedence,
} from "../lib/grade-billing.ts";
import { decodeBase64Image } from "../lib/validation.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import { computePhashFromImage } from "../lib/perceptual-hash.ts";
import { assertPublicUrl, safeFetch, SsrfError } from "../lib/ssrf.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { isAiBudgetExhausted } from "../lib/ai-budget-gate.ts";
import {
  type GradeGarmentInput,
  validateGradeGarment,
} from "../lib/api-grade-ingest.ts";
import { MAX_BATCH_ITEMS } from "../lib/grading-batch.ts";
import { processGradeBatch } from "../lib/grading-batch-worker.ts";
import type { ApiKeyScope } from "../lib/api-key.ts";
import { logEvent, recordMetric } from "../lib/observability.ts";
import { redactError } from "../lib/log-redact.ts";
import {
  getPriceGuideCatalog,
  getPriceGuideEntry,
  sandboxPriceGuideCatalog,
  sandboxPriceGuideEntry,
} from "../lib/price-guide.ts";

type ApiV1Env = {
  Variables: {
    userId: string;
    apiKeyScopes: ApiKeyScope[];
    apiKeyId?: string;
  };
};

// US-784: image-processing failures return a STABLE, generic envelope to the
// (untrusted) API caller. The specific reason — a validation detail, a storage
// error, the offending image type — goes ONLY to redacted server logs, never the
// response, so internals can't leak through the public API.
const IMAGE_ERROR_MESSAGE =
  "Image processing failed. Each photo must be a valid JPEG, PNG, or WebP within the size and dimension limits.";

function imageProcessingError(
  c: Context<ApiV1Env>,
  code: string,
  logDetail: unknown,
  status: 400 | 500 = 400,
): Response {
  logEvent("warn", "api_v1.image_error", { code, detail: redactError(logDetail) });
  return c.json(
    { data: null, error: { code, message: IMAGE_ERROR_MESSAGE, details: [] }, meta: null },
    status,
  );
}

// US-356: enforce the calling key's scopes. A key with no scopes set (legacy
// row) is granted the full set by the auth middleware, so this stays
// back-compatible. Returns true when the key carries `required`.
function hasScope(
  scopes: ApiKeyScope[] | undefined,
  required: ApiKeyScope,
): boolean {
  return (scopes ?? []).includes(required);
}

const scopeDenied = (required: ApiKeyScope) => {
  // US-800: record scope rejections so abuse (a key probing endpoints it lacks
  // access to) is visible in the metrics stream alongside rate-limit hits.
  recordMetric("api_v1.scope_denied", 1, { scope: required });
  return {
    data: null,
    error: { message: `This API key lacks the '${required}' scope`, details: [] },
    meta: null,
  };
};

const GARMENT_TYPES = ["tops", "bottoms", "outerwear", "dresses", "footwear", "accessories"] as const;
const GARMENT_CATEGORIES = [
  "t-shirt", "shirt", "blouse", "sweater", "hoodie",
  "jacket", "coat", "jeans", "pants", "shorts",
  "skirt", "dress", "sneakers", "boots", "sandals",
  "hat", "bag", "belt", "scarf", "neckwear", "gloves", "other",
] as const;
// Mirror of IMAGE_TYPES in src/lib/constants.ts (see grade.ts for the rationale
// on the duplicated literal). label_2 / detail_2..4 / measurement_* extend the
// core five so API callers can attach multiple tags, details, and flat
// measurement shots for size ID.
const IMAGE_TYPES = [
  "front", "back", "label", "label_2",
  "detail", "detail_2", "detail_3", "detail_4",
  "defect",
  "measurement_chest", "measurement_waist", "measurement_length",
  "measurement_sleeve", "measurement_inseam",
] as const;
const REQUIRED_IMAGE_TYPES = ["front", "back", "label"];
// Hard ceiling on images per submission — one Claude Vision call is issued per
// image but the submission is billed as a single grade, so an uncapped count is
// an AI-cost multiplier. Mirrors grade.ts MAX_IMAGES_PER_SUBMISSION. (HIGH-1)
const MAX_IMAGES_PER_SUBMISSION = IMAGE_TYPES.length;

type GarmentType = (typeof GARMENT_TYPES)[number];
type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];
type ImageType = (typeof IMAGE_TYPES)[number];

interface GradeImage {
  image_type: string;
  url?: string;
  base64?: string;
  content_type?: string;
}

export const apiV1Routes = new Hono<ApiV1Env>();

// --- POST /api/v1/grades — Submit garment for grading ---
apiV1Routes.post("/grades", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "submit")) {
    return c.json(scopeDenied("submit"), 403);
  }
  const userId = c.get("userId");
  // Honor the grading kill-switch + inline AI budget breach on the public API
  // too (this path charges before grading, so block before any charge). Without
  // this, the API would be a way to keep spending after the budget tripped.
  // US-2406: the key's owner is passed so plan targeting / rollout applies here
  // as it does in the app — the public API is not a way around a targeted flag.
  if (
    !(await isFeatureEnabled("grading", { userId })) ||
    (await isAiBudgetExhausted("grading"))
  ) {
    return c.json({
      data: null,
      error: { message: "Grading is temporarily unavailable. Please try again shortly.", code: "GRADING_UNAVAILABLE", details: [] },
      meta: null,
    }, 503);
  }

  let body: {
    title?: string;
    garment_type?: string;
    garment_category?: string;
    brand?: string;
    description?: string;
    tier?: string;
    images?: GradeImage[];
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({
      data: null,
      error: { message: "Invalid JSON body", details: [] },
      meta: null,
    }, 400);
  }

  const { title, garment_type, garment_category, brand, description, images } = body;
  const tier: GradeTier = isGradeTier(body.tier) ? body.tier : "standard";

  // Validate required fields
  const errors: string[] = [];

  if (!title || title.trim().length === 0) {
    errors.push("title is required");
  }
  if (!garment_type || !GARMENT_TYPES.includes(garment_type as GarmentType)) {
    errors.push(`garment_type must be one of: ${GARMENT_TYPES.join(", ")}`);
  }
  if (!garment_category || !GARMENT_CATEGORIES.includes(garment_category as GarmentCategory)) {
    errors.push(`garment_category must be one of: ${GARMENT_CATEGORIES.join(", ")}`);
  }

  // Validate images array
  if (!images || !Array.isArray(images) || images.length === 0) {
    errors.push("images array is required and must not be empty");
  } else if (images.length > MAX_IMAGES_PER_SUBMISSION) {
    errors.push(`images array may contain at most ${MAX_IMAGES_PER_SUBMISSION} images`);
  } else {
    const imageTypes: string[] = [];
    const seenTypes = new Set<string>();

    for (let i = 0; i < images.length; i++) {
      const img = images[i];

      if (!img.image_type || !IMAGE_TYPES.includes(img.image_type as ImageType)) {
        errors.push(`images[${i}].image_type must be one of: ${IMAGE_TYPES.join(", ")}`);
        continue;
      }

      // Reject duplicate slots: each image_type is graded once, so a repeat only
      // multiplies vision-call cost without adding garment coverage.
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

      // US-344: reject obviously-unfetchable / non-https URLs up front. The
      // authoritative SSRF check (DNS resolution + private-range block) happens
      // in safeFetch() at fetch time; this is a fast, clear 400 for bad input.
      if (img.url) {
        let parsedImageUrl: URL | null = null;
        try {
          parsedImageUrl = new URL(img.url);
        } catch {
          errors.push(`images[${i}].url is not a valid URL`);
          continue;
        }
        if (parsedImageUrl.protocol !== "https:") {
          errors.push(`images[${i}].url must use https`);
          continue;
        }
      }

      imageTypes.push(img.image_type);
    }

    // Check required image types
    for (const required of REQUIRED_IMAGE_TYPES) {
      if (!imageTypes.includes(required)) {
        errors.push(`A '${required}' image is required`);
      }
    }

    // Must have at least one detail image (any detail_* slot counts)
    if (!imageTypes.some((t) => t.startsWith("detail"))) {
      errors.push("At least one 'detail' image is required");
    }
  }

  if (errors.length > 0) {
    return c.json({
      data: null,
      error: { message: "Validation failed", details: errors },
      meta: null,
    }, 400);
  }

  // Suspended-account gate. Payment (included → credits → checkout) is handled
  // by runPaymentPrecedence after upload, the same path the web flow uses.
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("suspended")
    .eq("id", userId)
    .single();

  if (userError || !user) {
    return c.json({
      data: null,
      error: { message: "User not found", details: [] },
      meta: null,
    }, 404);
  }
  if (user.suspended) {
    return c.json({
      data: null,
      error: { message: "Account suspended. Contact support.", details: [] },
      meta: null,
    }, 403);
  }

  // Create submission record
  const { data: submission, error: submissionError } = await supabaseAdmin
    .from("submissions")
    .insert({
      user_id: userId,
      garment_type: garment_type as GarmentType,
      garment_category: garment_category as GarmentCategory,
      title: title!.trim(),
      brand: brand?.trim() || null,
      description: description?.trim() || null,
      status: "pending",
      payment_status: "unpaid",
    })
    .select("id")
    .single();

  if (submissionError || !submission) {
    console.error("[API v1] Failed to create submission:", redactError(submissionError));
    return c.json({
      data: null,
      error: { message: "Failed to create submission", details: [] },
      meta: null,
    }, 500);
  }

  const submissionId = submission.id;

  // Download/decode images and upload to Supabase Storage
  const imageRecords: Array<{
    submission_id: string;
    image_type: string;
    storage_path: string;
    display_order: number;
    phash: string | null;
  }> = [];

  for (let i = 0; i < images!.length; i++) {
    const img = images![i];
    const timestamp = Date.now();
    let imageData: ArrayBuffer;

    try {
      if (img.base64) {
        // Validate declared MIME + decoded byte size before forwarding the
        // bytes to storage / Claude Vision (US-267). Rejects mismatched or
        // oversized payloads with a 400 instead of letting a bad decode 500.
        const decoded = decodeBase64Image(img.base64, img.content_type);
        if (!decoded.ok) {
          throw new Error(decoded.error);
        }
        imageData = decoded.image.bytes.buffer.slice(
          decoded.image.bytes.byteOffset,
          decoded.image.bytes.byteOffset + decoded.image.bytes.byteLength,
        ) as ArrayBuffer;
      } else {
        // Fetch from URL through the SSRF guard (US-344): the edge runs on an
        // internal network with the service-role key, so a caller-supplied URL
        // must never reach a private/loopback/link-local/metadata target. The
        // guard resolves DNS, refuses non-public IPs, re-validates redirects,
        // and caps body size + time.
        const fetched = await safeFetch(img.url!, {
          maxBytes: 25 * 1024 * 1024,
          timeoutMs: 10_000,
        });
        if (fetched.status < 200 || fetched.status >= 300) {
          throw new Error(`HTTP ${fetched.status} fetching image from URL`);
        }
        imageData = fetched.bytes.buffer.slice(
          fetched.bytes.byteOffset,
          fetched.bytes.byteOffset + fetched.bytes.byteLength,
        ) as ArrayBuffer;
      }
    } catch (err) {
      console.error(`[API v1] Failed to process image ${i}:`, redactError(err));
      // Clean up
      for (const record of imageRecords) {
        await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
      }
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return imageProcessingError(c, "image_unreadable", `decode failed for ${img.image_type}`, 400);
    }

    // US-276: magic-byte validation (not the declared content-type) + EXIF/GPS
    // strip before storage. Catches a mislabeled URL fetch or a smuggled SVG
    // that the per-base64 MIME check above can't see.
    const rawBytes = new Uint8Array(imageData);
    const verdict = validateImageUpload(rawBytes, {
      allow: ["jpeg", "png", "webp"],
    });
    if (!verdict.ok) {
      for (const record of imageRecords) {
        await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
      }
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      // verdict.reason (raw validation internals) → logs only, not the response.
      return imageProcessingError(
        c,
        "image_invalid",
        `${img.image_type}: ${verdict.reason}`,
        400,
      );
    }
    const { bytes: cleanBytes } = stripImageMetadata(rawBytes, verdict.format);
    // US-480: server-side reuse hash from the stored bytes (never the client),
    // so public-API submissions are covered by photo-reuse detection too.
    const serverPhash = await computePhashFromImage(cleanBytes, verdict.format);
    const storagePath = `${userId}/${submissionId}/${img.image_type}_${timestamp}.${verdict.ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(storagePath, cleanBytes, {
        contentType: verdict.contentType,
        upsert: false,
      });

    if (uploadError) {
      for (const record of imageRecords) {
        await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
      }
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return imageProcessingError(c, "image_upload_failed", uploadError, 500);
    }

    imageRecords.push({
      submission_id: submissionId,
      image_type: img.image_type,
      storage_path: storagePath,
      display_order: i,
      phash: serverPhash,
    });
  }

  // Insert submission_image records
  const { error: imageInsertError } = await supabaseAdmin
    .from("submission_images")
    .insert(imageRecords);

  if (imageInsertError) {
    for (const record of imageRecords) {
      await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
    }
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    return imageProcessingError(c, "image_save_failed", imageInsertError, 500);
  }

  // Charge through the shared payment precedence (included → credits). API
  // callers can't complete an interactive Stripe checkout mid-request, so if
  // neither an included grade nor credits cover it, we reject with 402 and
  // clean up the uploaded submission rather than leave it unpaid.
  let precedence: PrecedenceResult;
  try {
    precedence = await runPaymentPrecedence(userId, submissionId, tier);
  } catch (err) {
    console.error(`[API v1] Payment precedence failed for ${submissionId}:`, redactError(err));
    for (const record of imageRecords) {
      await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
    }
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    return c.json({
      data: null,
      error: { message: "Payment processing error", details: [] },
      meta: null,
    }, 500);
  }

  if (!precedence.paid) {
    for (const record of imageRecords) {
      await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
    }
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    return c.json({
      data: null,
      error: {
        message:
          "Insufficient grading credits. Buy a credit pack or upgrade your plan, then retry.",
        details: [],
      },
      meta: {
        tier,
        credits_required: precedence.suggestedPack,
        per_grade_price_cents: precedence.tierPriceCents,
      },
    }, 402);
  }

  // Set status to processing and trigger pipeline (fire-and-forget)
  await supabaseAdmin
    .from("submissions")
    .update({ status: "processing" })
    .eq("id", submissionId);

  processSubmission(submissionId).catch((error) => {
    console.error(
      `[API v1] Pipeline error for submission ${submissionId}:`,
      redactError(error),
    );
  });

  return c.json({
    data: {
      id: submissionId,
      status: "processing",
      tier,
      payment_method: precedence.method,
    },
    error: null,
    meta: null,
  }, 202);
});

// --- POST /api/v1/grades/batch — Submit up to MAX_BATCH_ITEMS garments as one
// durable batch (US-1790). Returns 202 + batch_id immediately; a background
// worker grades each garment via the SAME path as a single grade, and the batch
// status is derived from its job rows so a container death/redeploy never
// strands work (reclaim cron resumes). Charges per garment via the shared
// payment precedence (included → credits) — an uncovered garment fails just its
// own job. NOTE: image URLs are strongly preferred over base64 in a batch — the
// garment (incl. any base64) is persisted in the job payload until graded. ---
apiV1Routes.post("/grades/batch", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "submit")) {
    return c.json(scopeDenied("submit"), 403);
  }
  const userId = c.get("userId");
  const apiKeyId = c.get("apiKeyId") ?? null;
  // US-2406: owner-scoped, same as the single-grade endpoint above.
  if (
    !(await isFeatureEnabled("grading", { userId })) ||
    (await isAiBudgetExhausted("grading"))
  ) {
    return c.json({
      data: null,
      error: { message: "Grading is temporarily unavailable. Please try again shortly.", code: "GRADING_UNAVAILABLE", details: [] },
      meta: null,
    }, 503);
  }

  let body: { garments?: GradeGarmentInput[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ data: null, error: { message: "Invalid JSON body", details: [] }, meta: null }, 400);
  }

  const garments = body.garments;
  if (!garments || !Array.isArray(garments) || garments.length === 0) {
    return c.json({
      data: null,
      error: { message: "garments array is required and must not be empty", details: [] },
      meta: null,
    }, 400);
  }
  if (garments.length > MAX_BATCH_ITEMS) {
    return c.json({
      data: null,
      error: { message: `A batch may contain at most ${MAX_BATCH_ITEMS} garments`, details: [] },
      meta: null,
    }, 400);
  }

  // Validate EVERY garment up front and reject the whole batch on any invalid
  // one — same immediate 400 feedback as a single grade, so a caller never
  // discovers bad input as silently-failed jobs later.
  const details: Array<{ index: number; errors: string[] }> = [];
  for (let i = 0; i < garments.length; i++) {
    const v = validateGradeGarment(garments[i]);
    if (!v.ok) details.push({ index: i, errors: v.errors });
  }
  if (details.length > 0) {
    return c.json({ data: null, error: { message: "Validation failed", details }, meta: null }, 400);
  }

  // Suspended-account gate (once for the batch).
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("suspended")
    .eq("id", userId)
    .single();
  if (userError || !user) {
    return c.json({ data: null, error: { message: "User not found", details: [] }, meta: null }, 404);
  }
  if (user.suspended) {
    return c.json({ data: null, error: { message: "Account suspended. Contact support.", details: [] }, meta: null }, 403);
  }

  // Enqueue: one batch row + one job row per garment. Status 'running' from the
  // start so the reclaim sweeper adopts it if the worker never fires (crash
  // between insert and dispatch); the worker fires immediately below.
  const { data: batch, error: batchErr } = await supabaseAdmin
    .from("grading_batches")
    .insert({ user_id: userId, api_key_id: apiKeyId, status: "running", item_count: garments.length })
    .select("id")
    .single();
  if (batchErr || !batch) {
    console.error("[API v1] Failed to create grading batch:", redactError(batchErr));
    return c.json({ data: null, error: { message: "Failed to create batch", details: [] }, meta: null }, 500);
  }
  const batchId = batch.id as string;

  const jobRows = garments.map((g) => ({
    batch_id: batchId,
    user_id: userId,
    payload: g,
    status: "pending",
  }));
  const { error: jobsErr } = await supabaseAdmin.from("grading_batch_jobs").insert(jobRows);
  if (jobsErr) {
    console.error("[API v1] Failed to enqueue grading batch jobs:", redactError(jobsErr));
    await supabaseAdmin.from("grading_batches").delete().eq("id", batchId);
    return c.json({ data: null, error: { message: "Failed to enqueue batch", details: [] }, meta: null }, 500);
  }

  // Fire-and-forget worker; the 202 closes the HTTP connection and grading runs
  // server-side. If the container dies mid-run, the reclaim cron resumes.
  processGradeBatch(batchId).catch((err) =>
    console.error(`[API v1] Batch worker error for ${batchId}:`, redactError(err))
  );

  return c.json({
    data: { id: batchId, status: "running", item_count: garments.length },
    error: null,
    meta: null,
  }, 202);
});

// --- GET /api/v1/grades/batch/:id — Poll a batch's status + per-garment results.
// Tenant-scoped by the caller's userId (US-268): a foreign batch id 404s. ---
apiV1Routes.get("/grades/batch/:id", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "read")) {
    return c.json(scopeDenied("read"), 403);
  }
  const userId = c.get("userId");
  const id = c.req.param("id");

  const { data: batch } = await supabaseAdmin
    .from("grading_batches")
    .select("id, status, item_count, succeeded_count, failed_count, error, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!batch) {
    return c.json({ data: null, error: { message: "Batch not found", details: [] }, meta: null }, 404);
  }

  const { data: jobRows } = await supabaseAdmin
    .from("grading_batch_jobs")
    .select("id, status, submission_id, error")
    .eq("batch_id", id)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  const results = ((jobRows ?? []) as Array<
    { id: string; status: string; submission_id: string | null; error: string | null }
  >).map((j) => ({ id: j.id, status: j.status, grade_id: j.submission_id, error: j.error }));

  return c.json({
    data: {
      id: batch.id,
      status: batch.status,
      item_count: batch.item_count,
      succeeded_count: batch.succeeded_count,
      failed_count: batch.failed_count,
      error: batch.error,
      results,
    },
    error: null,
    meta: null,
  }, 200);
});

// --- GET /api/v1/grades/:id — Get a specific grade report ---
apiV1Routes.get("/grades/:id", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "read")) {
    return c.json(scopeDenied("read"), 403);
  }
  const userId = c.get("userId");
  const id = c.req.param("id");

  const { data: submission, error } = await supabaseAdmin
    .from("submissions")
    .select("id, status, garment_type, garment_category, title, brand, description, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (error || !submission) {
    return c.json({
      data: null,
      error: { message: "Submission not found", details: [] },
      meta: null,
    }, 404);
  }

  // Fetch grade report if completed
  let gradeReport = null;
  if (submission.status === "completed" || submission.status === "disputed") {
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("id, overall_score, grade_tier, fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, confidence_score, ai_summary, detailed_notes, model_version, certificate_id, created_at")
      .eq("submission_id", id)
      // US-479: a regraded submission keeps superseded history — return only the
      // active report.
      .is("superseded_at", null)
      .maybeSingle();

    gradeReport = report || null;
  }

  return c.json({
    data: {
      id: submission.id,
      status: submission.status,
      garment_type: submission.garment_type,
      garment_category: submission.garment_category,
      title: submission.title,
      brand: submission.brand,
      description: submission.description,
      grade_report: gradeReport,
      created_at: submission.created_at,
      updated_at: submission.updated_at,
    },
    error: null,
    meta: null,
  });
});

// --- GET /api/v1/grades — List user's grades with pagination ---
apiV1Routes.get("/grades", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "read")) {
    return c.json(scopeDenied("read"), 403);
  }
  const userId = c.get("userId");

  // Parse pagination params
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const statusParam = c.req.query("status");

  const page = Math.max(1, parseInt(pageParam || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(limitParam || "20", 10) || 20));
  const offset = (page - 1) * limit;

  // Build query
  let query = supabaseAdmin
    .from("submissions")
    .select("id, status, garment_type, garment_category, title, brand, created_at, updated_at", { count: "exact" })
    .eq("user_id", userId);

  // Optional status filter
  if (statusParam) {
    query = query.eq("status", statusParam);
  }

  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data: submissions, count, error } = await query;

  if (error) {
    console.error("[API v1] Failed to list grades:", redactError(error));
    return c.json({
      data: null,
      error: { message: "Failed to list grades", details: [] },
      meta: null,
    }, 500);
  }

  // Fetch grade reports for completed submissions
  const completedIds = (submissions || [])
    .filter((s) => s.status === "completed" || s.status === "disputed")
    .map((s) => s.id);

  const gradeReports: Record<string, {
    overall_score: number;
    grade_tier: string;
    confidence_score: number;
    certificate_id: string | null;
  }> = {};

  if (completedIds.length > 0) {
    const { data: reports } = await supabaseAdmin
      .from("grade_reports")
      .select("submission_id, overall_score, grade_tier, confidence_score, certificate_id")
      .in("submission_id", completedIds);

    if (reports) {
      for (const report of reports) {
        gradeReports[report.submission_id] = {
          overall_score: report.overall_score,
          grade_tier: report.grade_tier,
          confidence_score: report.confidence_score,
          certificate_id: report.certificate_id,
        };
      }
    }
  }

  // Build response items
  const items = (submissions || []).map((s) => ({
    id: s.id,
    status: s.status,
    garment_type: s.garment_type,
    garment_category: s.garment_category,
    title: s.title,
    brand: s.brand,
    grade: gradeReports[s.id] || null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));

  const totalCount = count ?? 0;
  const totalPages = Math.ceil(totalCount / limit);

  return c.json({
    data: items,
    error: null,
    meta: {
      page,
      limit,
      total: totalCount,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    },
  });
});

// --- Sandbox (US-596) ------------------------------------------------------
// A free, deterministic mock of the grading API so partners can build and test
// an integration with no credits spent, no images uploaded, and no async wait.
// Same auth + scope rules + response envelope as the live endpoints, so the
// only code difference between sandbox and production is the URL path. Nothing
// is written to the database; results are derived purely from the request.

// Stable 0..1 hash of a seed string (FNV-1a) → deterministic sample grades.
function sandboxSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

const SANDBOX_TIERS: Array<{ min: number; tier: string }> = [
  { min: 9.5, tier: "NWT" },
  { min: 8.5, tier: "Excellent" },
  { min: 7, tier: "Very Good" },
  { min: 6, tier: "Good" },
  { min: 5, tier: "Fair" },
  { min: 0, tier: "Poor" },
];

function sandboxGrade(
  seedInput: string,
  opts: {
    title?: string;
    brand?: string;
    description?: string;
    garment_type?: string;
    garment_category?: string;
  } = {},
) {
  const s = sandboxSeed(seedInput || "sample");
  const round = (n: number) => Math.round(n * 2) / 2; // half-point scale
  const overall = round(5 + s * 4.5); // 5.0 – 9.5
  const jitter = (k: string) => round(Math.max(1, Math.min(10, overall + (sandboxSeed(seedInput + k) - 0.5) * 2)));
  const tier = SANDBOX_TIERS.find((t) => overall >= t.min)?.tier ?? "Good";
  return {
    id: `sandbox_${Math.floor(s * 1e9).toString(36)}`,
    status: "completed" as const,
    tier: "standard" as const,
    garment_type: opts.garment_type ?? null,
    garment_category: opts.garment_category ?? null,
    title: opts.title ?? "Sample garment",
    brand: opts.brand ?? null,
    description: opts.description ?? null,
    grade_report: {
      id: `sandbox_report_${Math.floor(s * 1e9).toString(36)}`,
      overall_score: overall,
      grade_tier: tier,
      fabric_condition_score: jitter("fabric"),
      structural_integrity_score: jitter("structural"),
      cosmetic_appearance_score: jitter("cosmetic"),
      functional_elements_score: jitter("functional"),
      odor_cleanliness_score: jitter("odor"),
      confidence_score: Math.round((0.8 + s * 0.18) * 100) / 100, // 0.80–0.98
      ai_summary:
        "Sandbox grade. This is a deterministic sample response for integration testing — no real grading was performed and no credits were spent.",
      detailed_notes: null,
      model_version: "sandbox",
      certificate_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

// POST /api/v1/sandbox/grades — mock submit (returns a completed grade inline).
apiV1Routes.post("/sandbox/grades", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "submit")) {
    return c.json(scopeDenied("submit"), 403);
  }
  let body: { title?: string; brand?: string; garment_type?: string; garment_category?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // Body is optional in the sandbox — fall back to a generic sample.
    body = {};
  }
  const grade = sandboxGrade(body.title ?? "sample", body);
  return c.json({ data: grade, error: null, meta: { sandbox: true } }, 200);
});

// GET /api/v1/sandbox/grades/:id — mock fetch (any id returns a sample grade).
apiV1Routes.get("/sandbox/grades/:id", (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "read")) {
    return c.json(scopeDenied("read"), 403);
  }
  const id = c.req.param("id");
  const grade = sandboxGrade(id, { title: "Sample garment" });
  grade.id = id;
  return c.json({ data: grade, error: null, meta: { sandbox: true } });
});

// --- Resale Condition Index price guide (US-1285) --------------------------
// A queryable price-guide product built on the proprietary Condition Index: for
// a published brand/category item, the resale VALUE RANGE and platform SELL-
// THROUGH at each condition-grade band. Aggregate-only and sample-gated — thin
// items/bands are suppressed by the underlying lib (no false precision). Read
// scope, so it shares the read rate-limit budget enforced on /api/v1/*.

// GET /api/v1/price-guide — list every published price-guide item (the catalog).
apiV1Routes.get("/price-guide", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "read")) {
    return c.json(scopeDenied("read"), 403);
  }
  try {
    const items = await getPriceGuideCatalog();
    return c.json({ data: { items }, error: null, meta: { count: items.length } });
  } catch (err) {
    console.error("[API v1] price-guide catalog:", redactError(err));
    return c.json({
      data: null,
      error: { message: "Failed to load price guide", details: [] },
      meta: null,
    }, 500);
  }
});

// GET /api/v1/usage — US-1791: this key's monthly usage vs its quota.
apiV1Routes.get("/usage", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "read")) {
    return c.json(scopeDenied("read"), 403);
  }
  try {
    const apiKeyId = (c.get as (k: string) => unknown)("apiKeyId") as string;
    const now = new Date();
    const [{ data: keyRow }, { count }] = await Promise.all([
      supabaseAdmin.from("api_keys").select("monthly_quota").eq("id", apiKeyId).single(),
      supabaseAdmin
        .from("api_usage_events")
        .select("id", { count: "exact", head: true })
        .eq("api_key_id", apiKeyId)
        .gte("created_at", billingMonthStartIso(now)),
    ]);
    const state = computeQuotaState(
      (keyRow as { monthly_quota?: number | null } | null)?.monthly_quota ?? null,
      count ?? 0,
      now,
    );
    return c.json({ data: state, error: null, meta: null });
  } catch (err) {
    console.error("[API v1] usage:", redactError(err));
    return c.json({ data: null, error: { message: "Failed to load usage", details: [] }, meta: null }, 500);
  }
});

// GET /api/v1/price-guide/:slug — value range + sell-through by grade band.
apiV1Routes.get("/price-guide/:slug", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "read")) {
    return c.json(scopeDenied("read"), 403);
  }
  try {
    const entry = await getPriceGuideEntry(c.req.param("slug"));
    if (!entry) {
      return c.json({
        data: null,
        error: { message: "No published price guide for that item", details: [] },
        meta: null,
      }, 404);
    }
    return c.json({ data: entry, error: null, meta: null });
  } catch (err) {
    console.error("[API v1] price-guide entry:", redactError(err));
    return c.json({
      data: null,
      error: { message: "Failed to load price guide", details: [] },
      meta: null,
    }, 500);
  }
});

// GET /api/v1/sandbox/price-guide — free deterministic sample catalog.
apiV1Routes.get("/sandbox/price-guide", (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "read")) {
    return c.json(scopeDenied("read"), 403);
  }
  const items = sandboxPriceGuideCatalog();
  return c.json({ data: { items }, error: null, meta: { sandbox: true, count: items.length } });
});

// GET /api/v1/sandbox/price-guide/:slug — free deterministic sample entry.
apiV1Routes.get("/sandbox/price-guide/:slug", (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "read")) {
    return c.json(scopeDenied("read"), 403);
  }
  const entry = sandboxPriceGuideEntry(c.req.param("slug"));
  return c.json({ data: entry, error: null, meta: { sandbox: true } });
});

// --- PATCH /api/v1/webhook — Set or update webhook URL ---
apiV1Routes.patch("/webhook", async (c) => {
  if (!hasScope(c.get("apiKeyScopes"), "webhook_manage")) {
    return c.json(scopeDenied("webhook_manage"), 403);
  }
  const userId = c.get("userId");

  let body: { webhook_url?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({
      data: null,
      error: { message: "Invalid JSON body", details: [] },
      meta: null,
    }, 400);
  }

  const { webhook_url } = body;

  // Allow null to clear the webhook URL
  if (webhook_url !== null && webhook_url !== undefined) {
    if (typeof webhook_url !== "string" || webhook_url.trim().length === 0) {
      return c.json({
        data: null,
        error: { message: "webhook_url must be a non-empty string or null", details: [] },
        meta: null,
      }, 400);
    }

    // Validate URL format + SSRF safety at set-time (US-345): require https in
    // prod and refuse any host that resolves to a private/loopback/link-local/
    // metadata address, so a stored webhook can't be used as an internal relay.
    // Delivery-time re-validates as well (DNS can change after set-time).
    try {
      await assertPublicUrl(webhook_url);
    } catch (err) {
      const message = err instanceof SsrfError
        ? `webhook_url rejected: ${err.message}`
        : "webhook_url is not a valid URL";
      return c.json({
        data: null,
        error: { message, details: [] },
        meta: null,
      }, 400);
    }
  }

  // Find the user's API keys and update all of them with the webhook URL
  // (The API key used for this request is identified by userId from the middleware)
  const { data: keys, error: fetchError } = await supabaseAdmin
    .from("api_keys")
    .select("id")
    .eq("user_id", userId);

  if (fetchError) {
    console.error("[API v1] Failed to fetch API keys for webhook update:", redactError(fetchError));
    return c.json({
      data: null,
      error: { message: "Failed to update webhook URL", details: [] },
      meta: null,
    }, 500);
  }

  if (!keys || keys.length === 0) {
    return c.json({
      data: null,
      error: { message: "No API keys found", details: [] },
      meta: null,
    }, 404);
  }

  // Update all user's API keys with the webhook URL
  const { error: updateError } = await supabaseAdmin
    .from("api_keys")
    .update({ webhook_url: webhook_url ?? null })
    .eq("user_id", userId);

  if (updateError) {
    console.error("[API v1] Failed to update webhook URL:", redactError(updateError));
    return c.json({
      data: null,
      error: { message: "Failed to update webhook URL", details: [] },
      meta: null,
    }, 500);
  }

  console.log(
    `[API v1] Webhook URL ${webhook_url ? "set" : "cleared"} for user ${userId} (${keys.length} key(s))`
  );

  return c.json({
    data: {
      webhook_url: webhook_url ?? null,
      keys_updated: keys.length,
    },
    error: null,
    meta: null,
  });
});

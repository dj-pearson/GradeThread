import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
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
import { assertPublicUrl, safeFetch, SsrfError } from "../lib/ssrf.ts";
import type { ApiKeyScope } from "../lib/api-key.ts";
import { recordMetric } from "../lib/observability.ts";

type ApiV1Env = {
  Variables: {
    userId: string;
    apiKeyScopes: ApiKeyScope[];
  };
};

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
  "hat", "bag", "belt", "scarf", "other",
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
  } else {
    const imageTypes: string[] = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];

      if (!img.image_type || !IMAGE_TYPES.includes(img.image_type as ImageType)) {
        errors.push(`images[${i}].image_type must be one of: ${IMAGE_TYPES.join(", ")}`);
        continue;
      }

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
    console.error("[API v1] Failed to create submission:", submissionError);
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
      console.error(`[API v1] Failed to process image ${i}:`, err);
      // Clean up
      for (const record of imageRecords) {
        await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
      }
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return c.json({
        data: null,
        error: { message: `Failed to process image: ${img.image_type}`, details: [] },
        meta: null,
      }, 400);
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
      return c.json({
        data: null,
        error: {
          message: `Invalid image (${img.image_type}): ${verdict.reason}`,
          details: [],
        },
        meta: null,
      }, 400);
    }
    const { bytes: cleanBytes } = stripImageMetadata(rawBytes, verdict.format);
    const storagePath = `${userId}/${submissionId}/${img.image_type}_${timestamp}.${verdict.ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(storagePath, cleanBytes, {
        contentType: verdict.contentType,
        upsert: false,
      });

    if (uploadError) {
      console.error(`[API v1] Failed to upload image ${i}:`, uploadError);
      for (const record of imageRecords) {
        await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
      }
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return c.json({
        data: null,
        error: { message: `Failed to upload image: ${img.image_type}`, details: [] },
        meta: null,
      }, 500);
    }

    imageRecords.push({
      submission_id: submissionId,
      image_type: img.image_type,
      storage_path: storagePath,
      display_order: i,
    });
  }

  // Insert submission_image records
  const { error: imageInsertError } = await supabaseAdmin
    .from("submission_images")
    .insert(imageRecords);

  if (imageInsertError) {
    console.error("[API v1] Failed to insert image records:", imageInsertError);
    for (const record of imageRecords) {
      await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
    }
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    return c.json({
      data: null,
      error: { message: "Failed to save image records", details: [] },
      meta: null,
    }, 500);
  }

  // Charge through the shared payment precedence (included → credits). API
  // callers can't complete an interactive Stripe checkout mid-request, so if
  // neither an included grade nor credits cover it, we reject with 402 and
  // clean up the uploaded submission rather than leave it unpaid.
  let precedence: PrecedenceResult;
  try {
    precedence = await runPaymentPrecedence(userId, submissionId, tier);
  } catch (err) {
    console.error(`[API v1] Payment precedence failed for ${submissionId}:`, err);
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
      error instanceof Error ? error.message : String(error)
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
      .single();

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
    console.error("[API v1] Failed to list grades:", error);
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
    console.error("[API v1] Failed to fetch API keys for webhook update:", fetchError);
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
    console.error("[API v1] Failed to update webhook URL:", updateError);
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

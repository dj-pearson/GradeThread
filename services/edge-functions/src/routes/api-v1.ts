import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";

type ApiV1Env = {
  Variables: {
    userId: string;
  };
};

const GARMENT_TYPES = ["tops", "bottoms", "outerwear", "dresses", "footwear", "accessories"] as const;
const GARMENT_CATEGORIES = [
  "t-shirt", "shirt", "blouse", "sweater", "hoodie",
  "jacket", "coat", "jeans", "pants", "shorts",
  "skirt", "dress", "sneakers", "boots", "sandals",
  "hat", "bag", "belt", "scarf", "other",
] as const;
const IMAGE_TYPES = ["front", "back", "label", "detail", "defect"] as const;
const REQUIRED_IMAGE_TYPES = ["front", "back", "label"];

const PLAN_LIMITS: Record<string, number> = {
  free: 5,
  starter: 50,
  professional: 500,
  enterprise: -1,
};

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
  const userId = c.get("userId");

  let body: {
    title?: string;
    garment_type?: string;
    garment_category?: string;
    brand?: string;
    description?: string;
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

      imageTypes.push(img.image_type);
    }

    // Check required image types
    for (const required of REQUIRED_IMAGE_TYPES) {
      if (!imageTypes.includes(required)) {
        errors.push(`A '${required}' image is required`);
      }
    }

    // Must have at least one detail image
    if (!imageTypes.includes("detail")) {
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

  // Fetch user record to check plan limits
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("plan, grades_used_this_month, grade_reset_at")
    .eq("id", userId)
    .single();

  if (userError || !user) {
    return c.json({
      data: null,
      error: { message: "User not found", details: [] },
      meta: null,
    }, 404);
  }

  // Check if usage reset is needed
  let gradesUsed = user.grades_used_this_month;
  const resetAt = new Date(user.grade_reset_at);
  if (resetAt <= new Date()) {
    gradesUsed = 0;
  }

  // Check plan limit
  const planLimit = PLAN_LIMITS[user.plan] ?? 0;
  if (planLimit !== -1 && gradesUsed >= planLimit) {
    return c.json({
      data: null,
      error: {
        message: "Monthly grade limit reached. Please upgrade your plan.",
        details: [],
      },
      meta: { current_usage: gradesUsed, plan_limit: planLimit },
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
    let contentType: string;

    try {
      if (img.base64) {
        // Decode base64 data
        const raw = img.base64.includes(",") ? img.base64.split(",")[1]! : img.base64;
        const binaryString = atob(raw);
        const bytes = new Uint8Array(binaryString.length);
        for (let j = 0; j < binaryString.length; j++) {
          bytes[j] = binaryString.charCodeAt(j);
        }
        imageData = bytes.buffer;
        contentType = img.content_type || "image/jpeg";
      } else {
        // Fetch from URL
        const response = await fetch(img.url!);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching image from URL`);
        }
        imageData = await response.arrayBuffer();
        contentType = response.headers.get("content-type") || "image/jpeg";
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

    // Determine file extension from content type
    const extMap: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const ext = extMap[contentType] || "jpg";
    const storagePath = `${userId}/${submissionId}/${img.image_type}_${timestamp}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(storagePath, imageData, {
        contentType,
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

  // Increment grades_used_this_month
  const nextResetAt = new Date();
  nextResetAt.setMonth(nextResetAt.getMonth() + 1);
  nextResetAt.setDate(1);
  nextResetAt.setHours(0, 0, 0, 0);

  if (resetAt <= new Date()) {
    await supabaseAdmin
      .from("users")
      .update({
        grades_used_this_month: 1,
        grade_reset_at: nextResetAt.toISOString(),
      })
      .eq("id", userId);
  } else {
    await supabaseAdmin.rpc("increment_grades_used", { user_id_param: userId });
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
    data: { id: submissionId, status: "processing" },
    error: null,
    meta: null,
  }, 202);
});

// --- GET /api/v1/grades/:id — Get a specific grade report ---
apiV1Routes.get("/grades/:id", async (c) => {
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

  let gradeReports: Record<string, {
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

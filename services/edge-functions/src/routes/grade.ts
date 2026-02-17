import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";

type GradeEnv = {
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
  enterprise: -1, // unlimited
};

type GarmentType = (typeof GARMENT_TYPES)[number];
type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];
type ImageType = (typeof IMAGE_TYPES)[number];

export const gradeRoutes = new Hono<GradeEnv>();

// Submit a garment for grading
gradeRoutes.post("/submit", async (c) => {
  const userId = c.get("userId");

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data. Expected multipart/form-data." }, 400);
  }

  // Extract garment info fields
  const garmentType = formData.get("garment_type") as string | null;
  const garmentCategory = formData.get("garment_category") as string | null;
  const title = formData.get("title") as string | null;
  const brand = formData.get("brand") as string | null;
  const description = formData.get("description") as string | null;

  // Validate required fields
  const errors: string[] = [];

  if (!title || title.trim().length === 0) {
    errors.push("title is required");
  }
  if (!garmentType || !GARMENT_TYPES.includes(garmentType as GarmentType)) {
    errors.push(`garment_type must be one of: ${GARMENT_TYPES.join(", ")}`);
  }
  if (!garmentCategory || !GARMENT_CATEGORIES.includes(garmentCategory as GarmentCategory)) {
    errors.push(`garment_category must be one of: ${GARMENT_CATEGORIES.join(", ")}`);
  }

  // Extract image files — expected format: images[] with image_types[] parallel array
  const imageFiles: File[] = [];
  const imageTypes: string[] = [];

  // Collect all image entries
  const allEntries = formData.getAll("images");
  const allTypes = formData.getAll("image_types");

  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    const type = allTypes[i] as string | undefined;

    if (entry instanceof File && entry.size > 0) {
      if (!type || !IMAGE_TYPES.includes(type as ImageType)) {
        errors.push(`image_types[${i}] must be one of: ${IMAGE_TYPES.join(", ")}`);
      } else {
        imageFiles.push(entry);
        imageTypes.push(type);
      }
    }
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

  if (errors.length > 0) {
    return c.json({ error: "Validation failed", details: errors }, 400);
  }

  // Fetch user record to check plan limits
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("plan, grades_used_this_month, grade_reset_at")
    .eq("id", userId)
    .single();

  if (userError || !user) {
    return c.json({ error: "User not found" }, 404);
  }

  // Check if usage reset is needed (month rolled over)
  let gradesUsed = user.grades_used_this_month;
  const resetAt = new Date(user.grade_reset_at);
  if (resetAt <= new Date()) {
    // Reset the counter — will be updated below
    gradesUsed = 0;
  }

  // Check plan limit
  const planLimit = PLAN_LIMITS[user.plan] ?? 0;
  if (planLimit !== -1 && gradesUsed >= planLimit) {
    return c.json({
      error: "Monthly grade limit reached. Please upgrade your plan to continue grading.",
      currentUsage: gradesUsed,
      planLimit,
    }, 403);
  }

  // Create submission record
  const { data: submission, error: submissionError } = await supabaseAdmin
    .from("submissions")
    .insert({
      user_id: userId,
      garment_type: garmentType as GarmentType,
      garment_category: garmentCategory as GarmentCategory,
      title: title!.trim(),
      brand: brand?.trim() || null,
      description: description?.trim() || null,
      status: "pending",
    })
    .select("id")
    .single();

  if (submissionError || !submission) {
    console.error("Failed to create submission:", submissionError);
    return c.json({ error: "Failed to create submission" }, 500);
  }

  const submissionId = submission.id;

  // Upload images and create submission_image records
  const imageRecords: Array<{
    submission_id: string;
    image_type: string;
    storage_path: string;
    display_order: number;
  }> = [];

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const imageType = imageTypes[i];
    const timestamp = Date.now();
    const ext = file.name.split(".").pop() || "jpg";
    const storagePath = `${userId}/${submissionId}/${imageType}_${timestamp}.${ext}`;

    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(storagePath, arrayBuffer, {
        contentType: file.type || "image/jpeg",
        upsert: false,
      });

    if (uploadError) {
      console.error(`Failed to upload image ${i}:`, uploadError);
      // Clean up: delete the submission since we can't complete it
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return c.json({ error: `Failed to upload image: ${imageType}` }, 500);
    }

    imageRecords.push({
      submission_id: submissionId,
      image_type: imageType,
      storage_path: storagePath,
      display_order: i,
    });
  }

  // Insert submission_image records
  const { error: imageInsertError } = await supabaseAdmin
    .from("submission_images")
    .insert(imageRecords);

  if (imageInsertError) {
    console.error("Failed to insert image records:", imageInsertError);
    // Clean up uploaded files and submission
    for (const record of imageRecords) {
      await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
    }
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    return c.json({ error: "Failed to save image records" }, 500);
  }

  // Increment grades_used_this_month (or reset if needed)
  const nextResetAt = new Date();
  nextResetAt.setMonth(nextResetAt.getMonth() + 1);
  nextResetAt.setDate(1);
  nextResetAt.setHours(0, 0, 0, 0);

  if (resetAt <= new Date()) {
    // Month rolled over — reset counter to 1
    await supabaseAdmin
      .from("users")
      .update({
        grades_used_this_month: 1,
        grade_reset_at: nextResetAt.toISOString(),
      })
      .eq("id", userId);
  } else {
    // Just increment
    await supabaseAdmin.rpc("increment_grades_used", { user_id_param: userId });
  }

  // Set status to 'processing' and trigger grading pipeline (fire-and-forget)
  await supabaseAdmin
    .from("submissions")
    .update({ status: "processing" })
    .eq("id", submissionId);

  processSubmission(submissionId).catch((error) => {
    console.error(
      `[Grade] Fire-and-forget pipeline error for submission ${submissionId}:`,
      error instanceof Error ? error.message : String(error)
    );
  });

  return c.json({
    submissionId,
    status: "processing",
  }, 201);
});

// Get grading status
gradeRoutes.get("/status/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");

  const { data: submission, error } = await supabaseAdmin
    .from("submissions")
    .select("id, status, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (error || !submission) {
    return c.json({ error: "Submission not found" }, 404);
  }

  // If completed, fetch the grade report
  let gradeReport = null;
  if (submission.status === "completed") {
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("*")
      .eq("submission_id", id)
      .single();

    gradeReport = report || null;
  }

  return c.json({
    id: submission.id,
    status: submission.status,
    grade_report: gradeReport,
    created_at: submission.created_at,
    updated_at: submission.updated_at,
  });
});

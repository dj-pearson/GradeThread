import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";
import {
  GRADE_TIERS,
  type GradeTier,
  type PrecedenceResult,
  runPaymentPrecedence,
} from "../lib/grade-billing.ts";

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
  "hat", "bag", "belt", "scarf", "other",
] as const;
const IMAGE_TYPES = ["front", "back", "label", "detail", "defect"] as const;
const REQUIRED_IMAGE_TYPES = ["front", "back", "label"];

// Optional seller-declared intentional design features. Passed to the grader
// as a hint so factory distressing isn't read as damage. Allowlist keeps the
// hint clean (free text would let sellers game the grade). Mirror of
// STYLE_ATTRIBUTES in src/lib/constants.ts.
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

export const gradeRoutes = new Hono<GradeEnv>();

// Payment precedence (included → credits → checkout) now lives in
// lib/grade-billing.ts so the FlipDesk bridge and public API charge through
// the same path. See runPaymentPrecedence there.

function kickPipeline(submissionId: string) {
  // Status='processing' first; then fire-and-forget the grading pipeline.
  supabaseAdmin
    .from("submissions")
    .update({ status: "processing" })
    .eq("id", submissionId)
    .then(() => {
      processSubmission(submissionId).catch((err) => {
        console.error(
          `[Grade] Pipeline error for ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    });
}

// ── POST /submit ─────────────────────────────────────────────────
gradeRoutes.post("/submit", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;
  const role = c.get("workspaceRole") ?? "owner";

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
  const tierRaw = (formData.get("tier") as string | null) ?? "standard";
  const tier: GradeTier = GRADE_TIERS.includes(tierRaw as GradeTier)
    ? (tierRaw as GradeTier)
    : "standard";

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
  // Parallel to imageFiles: client-computed perceptual hash (US-337). 16 hex
  // chars when present; "" / invalid is stored as null and simply skipped by
  // reuse detection.
  const imagePhashes: (string | null)[] = [];
  const allEntries = formData.getAll("images");
  const allTypes = formData.getAll("image_types");
  const allPhashes = formData.getAll("phashes");

  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    const type = allTypes[i] as string | undefined;
    if (entry instanceof File && entry.size > 0) {
      if (!type || !IMAGE_TYPES.includes(type as ImageType)) {
        errors.push(`image_types[${i}] must be one of: ${IMAGE_TYPES.join(", ")}`);
      } else {
        imageFiles.push(entry);
        imageTypes.push(type);
        const ph = typeof allPhashes[i] === "string" ? (allPhashes[i] as string).trim() : "";
        imagePhashes.push(/^[0-9a-f]{16}$/i.test(ph) ? ph.toLowerCase() : null);
      }
    }
  }

  for (const required of REQUIRED_IMAGE_TYPES) {
    if (!imageTypes.includes(required)) errors.push(`A '${required}' image is required`);
  }
  if (!imageTypes.includes("detail")) {
    errors.push("At least one 'detail' image is required");
  }

  if (errors.length > 0) {
    return c.json({ error: "Validation failed", details: errors }, 400);
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
      status: "pending",
      payment_status: "unpaid",
    })
    .select("id")
    .single();

  if (submissionError || !submission) {
    console.error("Failed to create submission:", submissionError);
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
  }> = [];

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const imageType = imageTypes[i];
    const timestamp = Date.now();
    const ext = file.name.split(".").pop() || "jpg";
    const storagePath = `${ownerId}/${submissionId}/${imageType}_${timestamp}.${ext}`;

    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(storagePath, arrayBuffer, {
        contentType: file.type || "image/jpeg",
        upsert: false,
      });

    if (uploadError) {
      console.error(`Failed to upload image ${i}:`, uploadError);
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return c.json({ error: `Failed to upload image: ${imageType}` }, 500);
    }

    imageRecords.push({
      submission_id: submissionId,
      image_type: imageType,
      storage_path: storagePath,
      display_order: i,
      phash: imagePhashes[i] ?? null,
    });
  }

  const { error: imageInsertError } = await supabaseAdmin
    .from("submission_images")
    .insert(imageRecords);

  if (imageInsertError) {
    console.error("Failed to insert image records:", imageInsertError);
    for (const record of imageRecords) {
      await supabaseAdmin.storage.from("submission-images").remove([record.storage_path]);
    }
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    return c.json({ error: "Failed to save image records" }, 500);
  }

  // Run payment precedence against the WORKSPACE OWNER's account — they pay,
  // they have the plan and credit balance.
  let precedence: PrecedenceResult;
  try {
    precedence = await runPaymentPrecedence(ownerId, submissionId, tier);
  } catch (err) {
    console.error(`Payment precedence failed for ${submissionId}:`, err);
    return c.json({ error: "Payment processing error" }, 500);
  }

  if (precedence.paid) {
    kickPipeline(submissionId);
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
    precedence = await runPaymentPrecedence(ownerId, submissionId, tier);
  } catch (err) {
    console.error(`Retry precedence failed for ${submissionId}:`, err);
    return c.json({ error: "Payment processing error" }, 500);
  }

  if (precedence.paid) {
    kickPipeline(submissionId);
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
    payment_status: submission.payment_status,
    paid_at: submission.paid_at,
    grade_report: gradeReport,
    // US-332: actionable photo requests when the quality gate abstained.
    quality_feedback: submission.quality_feedback ?? null,
    created_at: submission.created_at,
    updated_at: submission.updated_at,
  });
});

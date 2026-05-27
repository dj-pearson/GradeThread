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

const GRADE_TIERS = ["standard", "premium", "express"] as const;
type GradeTier = (typeof GRADE_TIERS)[number];

// Mirrors src/lib/constants.ts FLIPDESK_PLANS.includedStandardGradesPerMonth.
const INCLUDED_STANDARD_PER_MONTH: Record<string, number> = {
  free: 3,
  starter: 10,
  pro: 30,
  business: 75,
};

// Mirrors GRADETHREAD_TIERS.creditCost.
const TIER_CREDIT_COST: Record<GradeTier, number> = {
  standard: 1,
  premium: 3,
  express: 5,
};

const TIER_PRICE_CENTS: Record<GradeTier, number> = {
  standard: 299,
  premium: 799,
  express: 1299,
};

type GarmentType = (typeof GARMENT_TYPES)[number];
type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];
type ImageType = (typeof IMAGE_TYPES)[number];

export const gradeRoutes = new Hono<GradeEnv>();

// ── Payment precedence helper (US-207) ───────────────────────────
//
// Picks the cheapest valid payment path for a tier on a submission:
//   (1) included monthly grade (Standard only)
//   (2) debit credits
//   (3) checkoutRequired — caller opens Stripe Checkout
//
// Returns a discriminated union the route handlers and frontend can act on.

type PrecedenceResult =
  | { paid: true; method: "included"; newIncludedUsed: number }
  | { paid: true; method: "credits"; newBalance: number }
  | {
      paid: false;
      checkoutRequired: true;
      suggestedTier: GradeTier;
      suggestedPack: { credits: number; priceCents: number } | null;
      tierPriceCents: number;
    };

// Smallest pack that satisfies the needed credit cost, used as the upsell hint.
function suggestPack(creditCost: number) {
  if (creditCost <= 10)  return { credits: 10,  priceCents: 2499 };
  if (creditCost <= 25)  return { credits: 25,  priceCents: 5999 };
  if (creditCost <= 50)  return { credits: 50,  priceCents: 10999 };
  return { credits: 100, priceCents: 19999 };
}

async function runPaymentPrecedence(
  userId: string,
  submissionId: string,
  tier: GradeTier,
): Promise<PrecedenceResult> {
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select(
      "flipdesk_plan, grades_used_this_month, grade_reset_at, grade_credit_balance, subscription_status",
    )
    .eq("id", userId)
    .single();

  if (userError || !user) {
    throw new Error(`USER_NOT_FOUND: ${userId}`);
  }

  // Paused subscriptions fall back to Free caps for included grades.
  const effectivePlan =
    user.subscription_status === "paused" ? "free" : user.flipdesk_plan;
  const includedCap = INCLUDED_STANDARD_PER_MONTH[effectivePlan] ?? 0;

  // Roll over the included counter if we crossed the reset boundary. (Normal
  // case is the invoice.payment_succeeded webhook resets it on cycle, but
  // Free users have no invoice — they rely on this clock check.)
  let includedUsed = user.grades_used_this_month;
  const resetAt = new Date(user.grade_reset_at);
  const rolledOver = resetAt <= new Date();
  if (rolledOver) includedUsed = 0;

  // ─ (1) Try included grades — Standard only ─
  if (tier === "standard" && includedUsed < includedCap) {
    // Optimistic concurrency: only update if grades_used_this_month hasn't
    // changed since we read it. If another submission landed in between,
    // the update affects 0 rows and we fall through.
    const nextReset = new Date();
    nextReset.setMonth(nextReset.getMonth() + 1);
    nextReset.setDate(1);
    nextReset.setHours(0, 0, 0, 0);

    const updatePayload: Record<string, unknown> = {
      grades_used_this_month: includedUsed + 1,
    };
    if (rolledOver) {
      updatePayload.grade_reset_at = nextReset.toISOString();
    }

    const { data, error } = await supabaseAdmin
      .from("users")
      .update(updatePayload)
      .eq("id", userId)
      .eq("grades_used_this_month", rolledOver ? user.grades_used_this_month : includedUsed)
      .select("id");

    if (!error && data && data.length > 0) {
      await supabaseAdmin
        .from("submissions")
        .update({ payment_status: "included", paid_at: new Date().toISOString() })
        .eq("id", submissionId);
      // Ledger row for audit, balance unchanged.
      await supabaseAdmin.from("grade_credit_transactions").insert({
        user_id: userId,
        delta: 0,
        reason: "included_grant",
        balance_after: user.grade_credit_balance,
        submission_id: submissionId,
        notes: `Included Standard grade #${includedUsed + 1}/${includedCap} on ${effectivePlan}`,
      });
      return { paid: true, method: "included", newIncludedUsed: includedUsed + 1 };
    }
    // CAS failed — fall through to credits.
  }

  // ─ (2) Try credits ─
  const cost = TIER_CREDIT_COST[tier];
  if (user.grade_credit_balance >= cost) {
    const { data: newBalance, error: debitError } = await supabaseAdmin.rpc(
      "debit_grade_credits",
      {
        p_user_id: userId,
        p_credits: cost,
        p_submission_id: submissionId,
        p_notes: `${tier} grade — ${cost} credit${cost === 1 ? "" : "s"}`,
      },
    );

    if (debitError) {
      // INSUFFICIENT_CREDITS race — fall through to checkout.
      const msg = (debitError.message ?? "").toString();
      if (!msg.includes("INSUFFICIENT_CREDITS")) {
        throw new Error(`DEBIT_FAILED: ${msg}`);
      }
    } else {
      await supabaseAdmin
        .from("submissions")
        .update({ payment_status: "credits", paid_at: new Date().toISOString() })
        .eq("id", submissionId);
      return {
        paid: true,
        method: "credits",
        newBalance: typeof newBalance === "number" ? newBalance : user.grade_credit_balance - cost,
      };
    }
  }

  // ─ (3) Checkout required ─
  return {
    paid: false,
    checkoutRequired: true,
    suggestedTier: tier,
    suggestedPack: suggestPack(cost),
    tierPriceCents: TIER_PRICE_CENTS[tier],
  };
}

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

  for (const required of REQUIRED_IMAGE_TYPES) {
    if (!imageTypes.includes(required)) errors.push(`A '${required}' image is required`);
  }
  if (!imageTypes.includes("detail")) {
    errors.push("At least one 'detail' image is required");
  }

  if (errors.length > 0) {
    return c.json({ error: "Validation failed", details: errors }, 400);
  }

  // Suspended account gate (pre-pricing). Plan caps are enforced by the
  // precedence step below — exceeding included grades isn't a failure mode,
  // it just falls through to credits or checkout.
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("suspended")
    .eq("id", userId)
    .single();

  if (userError || !user) {
    return c.json({ error: "User not found" }, 404);
  }
  if (user.suspended) {
    return c.json({
      error:
        "Your account has been suspended and cannot create new submissions. Contact support if you believe this is a mistake.",
    }, 403);
  }

  // Create submission (unpaid).
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

  // Run payment precedence.
  let precedence: PrecedenceResult;
  try {
    precedence = await runPaymentPrecedence(userId, submissionId, tier);
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
    .eq("user_id", userId)
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
    precedence = await runPaymentPrecedence(userId, submissionId, tier);
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

  const { data: submission, error } = await supabaseAdmin
    .from("submissions")
    .select("id, status, payment_status, paid_at, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", userId)
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
    created_at: submission.created_at,
    updated_at: submission.updated_at,
  });
});

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { clientIp } from "../middleware/rate-limit.ts";
import { getSettingSync } from "../lib/system-settings.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import { computePhashFromImage } from "../lib/perceptual-hash.ts";
import {
  GRADE_TIERS,
  type GradeTier,
  type PrecedenceResult,
  runPaymentPrecedence,
  tierSupportsAuthenticityAddon,
} from "../lib/grade-billing.ts";
import { captureException } from "../lib/observability.ts";
import { featureDisabledBody, isFeatureEnabled } from "../lib/feature-flags.ts";
import { aiBudgetExceededBody, isAiBudgetExhausted } from "../lib/ai-budget-gate.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import { classifyGarment, type GarmentClassification } from "../lib/ai-extract.ts";
import { valueAtGrade } from "../lib/condition-value.ts";
import { suggestCategories } from "../lib/ebay-client.ts";
import { effectivePlanFor } from "../lib/grade-pricing.ts";

// US-614: free monthly Snap-to-Value cap per effective FlipDesk plan (-1 = unlimited).
const SNAP_CAP: Record<string, number> = {
  free: 15,
  starter: 60,
  pro: 200,
  business: -1,
};

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
// Mirror of IMAGE_TYPES in src/lib/constants.ts (edge runs in a separate Deno
// project and can't import frontend code). label_2 = second tag shot,
// detail_2..4 = extra close-ups, measurement_* = flat tape-measure shots for
// size ID when there's no size tag.
const IMAGE_TYPES = [
  "front", "back", "label", "label_2",
  "detail", "detail_2", "detail_3", "detail_4",
  "defect",
  "measurement_chest", "measurement_waist", "measurement_length",
  "measurement_sleeve", "measurement_inseam",
] as const;
const REQUIRED_IMAGE_TYPES = ["front", "back", "label"];

// Hard ceiling on images accepted per submission. The grading pipeline issues
// one Claude Vision call PER image, but a submission is billed as a single
// grade — so an uncapped image count is a direct AI-cost multiplier (a caller
// could attach dozens of photos for the price of one grade). The cap matches
// the number of distinct IMAGE_TYPES slots; duplicate types are also rejected
// below so cost scales with garment coverage, not attacker choice. (HIGH-1)
const MAX_IMAGES_PER_SUBMISSION = IMAGE_TYPES.length;

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

// US-339: original-image retention is OFF unless an operator opts in. When off,
// any `original_images` the client sends are ignored (defense-in-depth) so the
// fast compressed-upload path is the default and originals are never stored
// without an explicit config choice. EXIF capture below runs regardless.
const RETAIN_ORIGINAL_IMAGES =
  (Deno.env.get("RETAIN_ORIGINAL_IMAGES") ?? "").toLowerCase() === "true";

// Sanitize + bound the client-supplied EXIF blob (US-339). Never trust the
// client: keep only known fields, cap string lengths, and validate GPS ranges.
// Returns null when nothing usable remains (the common case).
function sanitizeExif(
  raw: FormDataEntryValue | undefined,
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const src = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const copyStr = (k: string) => {
    const v = src[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 256);
  };
  copyStr("make");
  copyStr("model");
  copyStr("software");
  copyStr("lensModel");
  copyStr("dateTime");
  copyStr("dateTimeOriginal");
  if (typeof src.orientation === "number" && Number.isFinite(src.orientation)) {
    const o = Math.trunc(src.orientation);
    if (o >= 1 && o <= 8) out.orientation = o;
  }
  const gps = src.gps;
  if (gps && typeof gps === "object" && !Array.isArray(gps)) {
    const lat = (gps as Record<string, unknown>).latitude;
    const lon = (gps as Record<string, unknown>).longitude;
    if (
      typeof lat === "number" && Number.isFinite(lat) && lat >= -90 &&
      lat <= 90 &&
      typeof lon === "number" && Number.isFinite(lon) && lon >= -180 &&
      lon <= 180
    ) {
      out.gps = { latitude: lat, longitude: lon };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const gradeRoutes = new Hono<GradeEnv>();

// Payment precedence (included → credits → checkout) now lives in
// lib/grade-billing.ts so the FlipDesk bridge and public API charge through
// the same path. See runPaymentPrecedence there.

function kickPipeline(submissionId: string, correlationId?: string) {
  // Status='processing' first; then fire-and-forget the grading pipeline.
  supabaseAdmin
    .from("submissions")
    .update({ status: "processing" })
    .eq("id", submissionId)
    .then(() => {
      processSubmission(submissionId).catch((err) => {
        // US-491/497: a crash in the un-awaited pipeline is otherwise invisible.
        // Report it to the tracker, correlated to the originating request, and
        // tag the submission so the stuck-submission reaper (US-495) can refund.
        captureException(err, {
          route: "grade.pipeline",
          correlationId,
          extra: { submissionId },
        });
        console.error(
          `[Grade] Pipeline error for ${submissionId}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    });
}

// ── POST /submit ─────────────────────────────────────────────────
gradeRoutes.post("/submit", async (c) => {
  // US-507: grading kill-switch — disable the (expensive, Anthropic-dependent)
  // pipeline during an outage/cost spike without a redeploy.
  if (!(await isFeatureEnabled("grading"))) {
    return c.json(featureDisabledBody("grading"), 503);
  }
  // Inline AI budget kill-switch: pause grading within seconds (not at the cron
  // interval) if the hard USD grading budget is breached. Checked BEFORE any
  // payment/credit reservation so an over-budget breach never charges the user.
  if (await isAiBudgetExhausted("grading")) {
    return c.json(aiBudgetExceededBody("grading"), 503);
  }
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
  // US-340: the seller opted into the Verified Capture provenance path. This
  // flag alone earns nothing — the badge is only awarded if the server-side
  // checks in verified-capture.ts pass at grading time. Never lowers a grade.
  const verifiedCaptureOptIn =
    (formData.get("verified_capture_opt_in") as string | null) === "true";
  // US-601: premium authenticity / counterfeit-confidence add-on opt-in. Only
  // HONORED on a paid Premium/Express tier (the higher per-tier charge covers it)
  // and when the kill-switch flag is on — both enforced just below.
  const authenticityAddonOptIn =
    (formData.get("authenticity_addon") as string | null) === "true";
  const tierRaw = (formData.get("tier") as string | null) ?? "standard";
  const tier: GradeTier = GRADE_TIERS.includes(tierRaw as GradeTier)
    ? (tierRaw as GradeTier)
    : "standard";
  // US-949: one-tap retake. When present, this new submission replaces a prior
  // needs_photos/expired one. The prior row is validated for ownership + a
  // retakeable status below, then marked superseded after this row is created.
  const retakeOf = (formData.get("retake_of") as string | null)?.trim() || null;

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
  // US-480: the perceptual hash is recomputed server-side from the validated
  // upload bytes below (computePhashFromImage) — the client "phashes" field is
  // NO LONGER trusted for reuse detection, since a forged hash could otherwise
  // dodge a match against a stolen/stock photo already on file.
  // US-339: provenance EXIF per image, aligned to imageFiles by push order.
  const imageExif: (Record<string, unknown> | null)[] = [];
  const allEntries = formData.getAll("images");
  const allTypes = formData.getAll("image_types");
  const allExif = formData.getAll("exif_metadata");
  // US-339: optional uncompressed originals, sent (in image order) only when
  // the client opted in. Consumed only if RETAIN_ORIGINAL_IMAGES is set.
  const allOriginals = formData.getAll("original_images");

  const seenTypes = new Set<string>();
  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    const type = allTypes[i] as string | undefined;
    if (entry instanceof File && entry.size > 0) {
      if (!type || !IMAGE_TYPES.includes(type as ImageType)) {
        errors.push(`image_types[${i}] must be one of: ${IMAGE_TYPES.join(", ")}`);
      } else if (seenTypes.has(type)) {
        // Reject duplicate slots: each image_type is graded once, so a repeated
        // type only multiplies vision-call cost without adding garment coverage.
        errors.push(`image_types[${i}] '${type}' is a duplicate; each image type may appear at most once`);
      } else if (imageFiles.length >= MAX_IMAGES_PER_SUBMISSION) {
        errors.push(`A submission may include at most ${MAX_IMAGES_PER_SUBMISSION} images`);
        break;
      } else {
        seenTypes.add(type);
        imageFiles.push(entry);
        imageTypes.push(type);
        imageExif.push(sanitizeExif(allExif[i]));
      }
    }
  }

  // Originals must line up 1:1 with accepted images to be retained safely
  // (any mismatch means we'd store the wrong original against an image).
  const retainOriginals = RETAIN_ORIGINAL_IMAGES &&
    allOriginals.length === imageFiles.length;

  for (const required of REQUIRED_IMAGE_TYPES) {
    if (!imageTypes.includes(required)) errors.push(`A '${required}' image is required`);
  }
  if (!imageTypes.some((t) => t.startsWith("detail"))) {
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

  // US-601: honor the authenticity add-on only on a paid Premium/Express tier
  // AND when the kill-switch flag is on. Standard grades never include it.
  const authenticityAddon =
    authenticityAddonOptIn &&
    tierSupportsAuthenticityAddon(tier) &&
    (await isFeatureEnabled("authenticity_addon"));

  // US-949: validate the retake target BEFORE creating the new submission, so a
  // forged/foreign id can't link a retake chain across tenants (US-268). The
  // prior submission must belong to the same workspace owner and be in a
  // retakeable state (needs_photos = quality gate abstained, or expired =
  // checkout never completed). Anything else is ignored (treated as a fresh
  // submission) rather than failing the whole grade.
  let retakeTargetId: string | null = null;
  if (retakeOf) {
    const { data: prior } = await supabaseAdmin
      .from("submissions")
      .select("id, status, superseded_at")
      .eq("id", retakeOf)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (
      prior &&
      !prior.superseded_at &&
      (prior.status === "needs_photos" || prior.status === "expired")
    ) {
      retakeTargetId = prior.id;
    }
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
      verified_capture_opt_in: verifiedCaptureOptIn,
      authenticity_addon: authenticityAddon,
      retake_of_submission_id: retakeTargetId,
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
    exif: Record<string, unknown> | null;
    original_storage_path: string | null;
  }> = [];

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const imageType = imageTypes[i];
    const timestamp = Date.now();

    // US-276: never trust the client extension/MIME. Sniff the real bytes,
    // reject SVG/non-images, cap size + dimensions; the private bucket accepts
    // only jpeg/png/webp. Then strip EXIF/GPS before the bytes ever land.
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const verdict = validateImageUpload(rawBytes, {
      allow: ["jpeg", "png", "webp"],
    });
    if (!verdict.ok) {
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return c.json(
        { error: `Invalid image (${imageType}): ${verdict.reason}` },
        400,
      );
    }
    const { bytes: cleanBytes } = stripImageMetadata(rawBytes, verdict.format);
    // US-480: recompute the reuse-detection hash from the bytes we actually
    // store (never the client). null on a decode/hash failure → image is simply
    // skipped by reuse detection, never blocked.
    const serverPhash = await computePhashFromImage(cleanBytes, verdict.format);
    const storagePath =
      `${ownerId}/${submissionId}/${imageType}_${timestamp}.${verdict.ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("submission-images")
      .upload(storagePath, cleanBytes, {
        contentType: verdict.contentType,
        upsert: false,
      });

    if (uploadError) {
      console.error(`Failed to upload image ${i}:`, uploadError);
      await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
      return c.json({ error: `Failed to upload image: ${imageType}` }, 500);
    }

    // US-339: optionally retain the uncompressed ORIGINAL (EXIF intact) for
    // forensic/provenance use. Stored in the SAME private bucket + owner folder
    // as the compressed image (tenant-scoped, signed-URL-only access). Unlike
    // the compressed copy we deliberately DO NOT strip metadata here — that's
    // the whole point. Validation still runs (sniff + size/dim cap). Best
    // effort: a failed original upload never fails the submission.
    let originalStoragePath: string | null = null;
    if (retainOriginals) {
      const orig = allOriginals[i];
      if (orig instanceof File && orig.size > 0) {
        try {
          const origBytes = new Uint8Array(await orig.arrayBuffer());
          const origVerdict = validateImageUpload(origBytes, {
            allow: ["jpeg", "png", "webp"],
          });
          if (origVerdict.ok) {
            const origPath =
              `${ownerId}/${submissionId}/original_${imageType}_${timestamp}.${origVerdict.ext}`;
            const { error: origErr } = await supabaseAdmin.storage
              .from("submission-images")
              .upload(origPath, origBytes, {
                contentType: origVerdict.contentType,
                upsert: false,
              });
            if (origErr) {
              console.error(`Failed to upload original ${i}:`, origErr);
            } else {
              originalStoragePath = origPath;
            }
          }
        } catch (err) {
          console.error(`Original retention failed for image ${i}:`, err);
        }
      }
    }

    imageRecords.push({
      submission_id: submissionId,
      image_type: imageType,
      storage_path: storagePath,
      display_order: i,
      phash: serverPhash,
      exif: imageExif[i] ?? null,
      original_storage_path: originalStoragePath,
    });
  }

  const { error: imageInsertError } = await supabaseAdmin
    .from("submission_images")
    .insert(imageRecords);

  if (imageInsertError) {
    console.error("Failed to insert image records:", imageInsertError);
    for (const record of imageRecords) {
      const paths = [record.storage_path];
      // US-339: clean up any retained original alongside the compressed copy.
      if (record.original_storage_path) paths.push(record.original_storage_path);
      await supabaseAdmin.storage.from("submission-images").remove(paths);
    }
    await supabaseAdmin.from("submissions").delete().eq("id", submissionId);
    return c.json({ error: "Failed to save image records" }, 500);
  }

  // US-949: now that the retake submission exists with its images, mark the
  // prior submission superseded so it drops out of active counts (preserved as
  // history, not deleted). Tenant-scoped by user_id (US-268) and guarded on the
  // retakeable status so a racing supersede can't clobber an unrelated row.
  if (retakeTargetId) {
    const { error: supersedeError } = await supabaseAdmin
      .from("submissions")
      .update({
        superseded_at: new Date().toISOString(),
        superseded_by_submission_id: submissionId,
      })
      .eq("id", retakeTargetId)
      .eq("user_id", ownerId)
      .in("status", ["needs_photos", "expired"]);
    if (supersedeError) {
      // Non-fatal: the new submission stands on its own; the old one just
      // remains visible. Log for follow-up rather than failing the grade.
      console.error(
        `Failed to supersede prior submission ${retakeTargetId}:`,
        supersedeError,
      );
    }
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
    kickPipeline(submissionId, c.get("correlationId"));
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
  // US-507: same grading kill-switch as /submit (this path also kicks the pipeline).
  if (!(await isFeatureEnabled("grading"))) {
    return c.json(featureDisabledBody("grading"), 503);
  }
  // Inline AI budget kill-switch (see /submit) — block before charging for the
  // pay-then-grade path too.
  if (await isAiBudgetExhausted("grading")) {
    return c.json(aiBudgetExceededBody("grading"), 503);
  }
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
    kickPipeline(submissionId, c.get("correlationId"));
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
      // US-479: a regraded submission keeps superseded history — return only the
      // active report.
      .is("superseded_at", null)
      .maybeSingle();
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

// ── POST /snap — Snap-to-Value (US-612) ──────────────────────────────
//
// A logged-in user uploads a garment photo and instantly gets a condition grade
// ESTIMATE + a condition-adjusted resale value range — no submission row, no
// certificate, no billing (quickGrade is certificate-free). This is the free,
// signup-gated viral funnel; certified grades + listing are the upsell.
//
// Auth + rate limiting come from the /api/grade/* middleware groups. The image
// is validated + EXIF-stripped (US-276) before it's sent to the model, even
// though it is never stored.
function decodeBase64Image(input: string): Uint8Array | null {
  const m = input.match(/^data:image\/\w+;base64,(.+)$/);
  const b64 = (m ? m[1] : input).trim();
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Chunked base64 encode — spreading multi-MB bytes into String.fromCharCode
// overflows the call stack.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

gradeRoutes.post("/snap", async (c) => {
  // US-507: Snap rides the grading vision, so it honors the grading kill-switch.
  if (!(await isFeatureEnabled("grading"))) {
    return c.json(featureDisabledBody("grading"), 503);
  }
  // Inline AI budget kill-switch (see /submit) — snap rides grading vision too.
  if (await isAiBudgetExhausted("grading")) {
    return c.json(aiBudgetExceededBody("grading"), 503);
  }

  let body: { image?: unknown; brand?: unknown; keyword?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.image !== "string" || body.image.length === 0) {
    return c.json({ error: "image (base64 or data URI) is required" }, 400);
  }
  const brand = typeof body.brand === "string" ? body.brand.trim() : undefined;
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : undefined;

  // US-276: sniff the real bytes (reject SVG/non-image, cap size/dims) + strip
  // EXIF/GPS before the photo ever reaches the model. Never stored.
  const rawBytes = decodeBase64Image(body.image);
  if (!rawBytes) return c.json({ error: "image is not valid base64" }, 400);
  const verdict = validateImageUpload(rawBytes, { allow: ["jpeg", "png", "webp"] });
  if (!verdict.ok) return c.json({ error: `Invalid image: ${verdict.reason}` }, 400);
  const { bytes: clean } = stripImageMetadata(rawBytes, verdict.format);
  const dataUri = `data:${verdict.contentType};base64,${bytesToBase64(clean)}`;

  // US-614: per-plan monthly snap cap. Free is the funnel — generous but bounded;
  // paid tiers get more / unlimited. Reserve BEFORE the (paid-for-us) grade so an
  // over-cap user can't burn AI budget; refund on failure.
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data: planRow } = await supabaseAdmin
    .from("users")
    .select("flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
    .eq("id", ownerId)
    .maybeSingle();
  const effPlan = effectivePlanFor(
    (planRow?.flipdesk_plan as string) ?? "free",
    (planRow?.subscription_status as string) ?? "none",
    (planRow?.trial_ends_at as string | null) ?? null,
    new Date(),
    (planRow?.past_due_since as string | null) ?? null,
  );
  const snapCap = SNAP_CAP[effPlan] ?? SNAP_CAP.free;

  // Anti-account-farming: the monthly snap cap is per-account, so signing up N
  // free accounts multiplies free vision calls. Add a per-IP DAILY ceiling on
  // the FREE tier (a second, non-account dimension) so one network can't farm
  // free Snaps across many fresh accounts. Keyed on the Cloudflare-attested IP
  // (un-spoofable; X-Forwarded-For is not trusted in prod). Checked BEFORE the
  // monthly reservation so a blocked request doesn't consume the monthly count.
  // No trusted IP (dev / direct-origin) → skip, matching the rate limiter.
  if (effPlan === "free") {
    const ip = clientIp(c as unknown as Context);
    if (ip) {
      const ipDailyCap = getSettingSync<number>("snap_ip_daily_cap", 30);
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const { data: ipCount } = await supabaseAdmin.rpc("increment_rate_limit", {
        p_bucket_key: `snap-ip:${ip}`,
        p_window_start: dayStart.toISOString(),
      });
      if (typeof ipCount === "number" && ipCount > ipDailyCap) {
        return c.json(
          {
            error:
              "Daily free Snap-to-Value limit reached for your network. Try again tomorrow, or upgrade for more.",
            code: "SNAP_IP_LIMIT_REACHED",
            action: "upgrade",
          },
          429,
        );
      }
    }
  }

  const { data: reserved } = await supabaseAdmin.rpc("reserve_snap", {
    p_user_id: ownerId,
    p_limit: snapCap,
  });
  if (reserved !== true) {
    return c.json(
      {
        error:
          `You've used all ${snapCap} free Snap-to-Value checks this month. Upgrade for more, or get a full certified grade.`,
        code: "SNAP_LIMIT_REACHED",
        action: "upgrade",
      },
      429,
    );
  }

  let grade;
  // US-952: AI-detect the garment type/category alongside the grade so the
  // certified-grade upgrade can prefill the form. Best-effort and run in
  // parallel so it hides under the grade latency; its own failure never fails
  // the snap (the .catch keeps Promise.all from rejecting on it).
  let garmentClassification: GarmentClassification | null = null;
  try {
    const [gradeResult, classification] = await Promise.all([
      quickGrade({
        images: [{ dataUri, type: "front" }],
        garment: { brand: brand ?? null, title: keyword ?? "" },
      }),
      classifyGarment(dataUri).catch((err) => {
        captureException(err, { level: "warn", route: "grade.snap.classify" });
        return null;
      }),
    ]);
    grade = gradeResult;
    garmentClassification = classification;
  } catch (err) {
    // Refund the reserved snap so a transient grading failure isn't counted.
    await supabaseAdmin.rpc("refund_snap", { p_user_id: ownerId }).then(() => {}, () => {});
    captureException(err, { route: "grade.snap", correlationId: c.get("correlationId") });
    return c.json({ error: "Couldn't grade that photo. Try a clearer, well-lit shot." }, 502);
  }

  // Condition-adjusted value range — only when we can identify the item enough
  // to comp it (brand and/or keyword). Otherwise return the grade alone.
  let value = null;
  if (brand || keyword) {
    try {
      const query = [brand, keyword].filter(Boolean).join(" ").trim();
      const cats = await suggestCategories(query);
      const categoryId = cats[0]?.categoryId;
      if (categoryId) {
        value = await valueAtGrade({ categoryId, q: keyword, brand }, grade.overallScore);
      }
    } catch (err) {
      // Value is a bonus — a comp/taxonomy hiccup shouldn't fail the snap.
      captureException(err, { level: "warn", route: "grade.snap.value" });
    }
  }

  return c.json({
    grade: {
      overall_score: grade.overallScore,
      grade_tier: grade.gradeTier,
      confidence: grade.confidence,
      factor_scores: grade.factorScores,
    },
    value, // { lowCents, medianCents, highCents, sampleSize, confidence, sufficient } | null
    // US-952: best-effort AI-detected garment type/category to prefill the
    // certified-grade form. null when the model couldn't classify it.
    garment: garmentClassification
      ? {
          type: garmentClassification.garmentType,
          category: garmentClassification.garmentCategory,
        }
      : null,
    estimate: true,
    disclaimer:
      "This is an AI condition + value ESTIMATE from one photo — not a certified GradeThread grade or a guaranteed sale price. Get a full certified grade to list with confidence.",
  });
});

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import {
  GRADE_TIERS,
  type GradeTier,
  type PrecedenceResult,
  runPaymentPrecedence,
} from "../lib/grade-billing.ts";
import { captureException } from "../lib/observability.ts";
import { featureDisabledBody, isFeatureEnabled } from "../lib/feature-flags.ts";
import { quickGrade } from "../lib/quick-grade.ts";
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
  // US-339: provenance EXIF per image, aligned to imageFiles by push order.
  const imageExif: (Record<string, unknown> | null)[] = [];
  const allEntries = formData.getAll("images");
  const allTypes = formData.getAll("image_types");
  const allPhashes = formData.getAll("phashes");
  const allExif = formData.getAll("exif_metadata");
  // US-339: optional uncompressed originals, sent (in image order) only when
  // the client opted in. Consumed only if RETAIN_ORIGINAL_IMAGES is set.
  const allOriginals = formData.getAll("original_images");

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
      phash: imagePhashes[i] ?? null,
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
  try {
    grade = await quickGrade({
      images: [{ dataUri, type: "front" }],
      garment: { brand: brand ?? null, title: keyword ?? "" },
    });
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
    estimate: true,
    disclaimer:
      "This is an AI condition + value ESTIMATE from one photo — not a certified GradeThread grade or a guaranteed sale price. Get a full certified grade to list with confidence.",
  });
});

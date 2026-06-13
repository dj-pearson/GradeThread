import { supabaseAdmin } from "./supabase.ts";
import {
  analyzeImage,
  compositeGrade,
  partitionImageResults,
  PARTIAL_IMAGE_CONFIDENCE_CAP,
  type SettledImage,
  type PerImageAnalysis,
  type GarmentInfo,
  type CompositeGradeResult,
} from "./ai-grading.ts";
import { runShadowGrades } from "./grading-shadow.ts";
import { notifyWebhooks } from "./webhook-delivery.ts";
import { sendGradeCompleteEmail } from "./email.ts";
import { notifyUser } from "./notify.ts";
import { submitUrls, certificateUrl } from "./indexnow.ts";
import { detectPhotoReuse } from "./photo-reuse.ts";
import {
  evaluateVerifiedCapture,
  verifiedCaptureBoost,
} from "./verified-capture.ts";
import { buildCertIntegrity } from "./cert-integrity.ts";
import {
  fuseTamperSignals,
  runForensicPass,
  type ForensicInputImage,
} from "./forensics.ts";
import { evaluateImageQuality, REQUIRED_IMAGE_TYPES } from "./image-quality.ts";
import { withImageBufferSlot } from "./grading-capacity.ts";
import { captureServer } from "./posthog.ts";
import { autoRefundPaidStripe } from "./grade-refund.ts";
import { pushReviewNeeded } from "./transactional-push.ts";
import { recordAiUsage } from "./ai-usage.ts";

// Base64-encode a byte array in 32KB chunks. The naive char-by-char
// `binary += String.fromCharCode(...)` loop is O(n²) on string growth and
// slow for multi-MB photos; applying fromCharCode over the whole array at
// once risks a call-stack overflow. Chunking avoids both.
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000; // 32768
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

/**
 * Processes a submission through the full grading pipeline:
 * 1. Fetch submission record and images from DB
 * 2. Download images from storage and convert to base64
 * 3. Run analyzeImage() on each image in parallel
 * 4. Run compositeGrade() with all per-image results
 * 5. Create grade_report record with scores and AI summary
 * 6. Update submission status to 'completed' (or 'failed' on error)
 * 7. Return the created grade report
 */
// Reverse the charge taken BEFORE the pipeline ran (runPaymentPrecedence in
// grade.ts / the FlipDesk grading path) whenever a submission ends up WITHOUT a
// grade — whether the pipeline failed (catch) or the image-quality gate
// abstained (US-332). Included grades go back to the monthly bundle; credit
// grades are re-granted. Idempotent via submissions.refunded_at, so calling it
// for an abstention and again on a later failure is safe. One-time Stripe
// payments can't be reversed by minting credits — they surface here for manual
// handling. Never throws — a refund hiccup must not mask the original outcome.
export async function reverseChargeForUngradedSubmission(
  submissionId: string,
  reason: string,
): Promise<void> {
  try {
    const { data: refundResult, error: refundError } = await supabaseAdmin.rpc(
      "refund_grade",
      { p_submission_id: submissionId },
    );
    if (refundError) {
      console.error(
        `[Pipeline] REFUND FAILED for submission ${submissionId} (${reason}) — manual review needed:`,
        refundError.message,
      );
    } else if (refundResult === "no_refund_paid_stripe") {
      // US-771: a real-money per-grade payment with no grade — issue the Stripe
      // refund automatically (idempotent), or queue it for an operator on
      // failure. Never throws.
      await autoRefundPaidStripe(submissionId, reason);
    } else {
      console.log(
        `[Pipeline] Refund for submission ${submissionId} (${reason}): ${refundResult}`,
      );
    }
  } catch (refundErr) {
    console.error(
      `[Pipeline] Refund error for submission ${submissionId} (${reason}) — manual review needed:`,
      refundErr instanceof Error ? refundErr.message : String(refundErr),
    );
  }
}

// US-569: grading durability knobs.
//
// LEASE_SECONDS — how long one grade run owns the row before it's presumed dead
// and re-claimable. Must comfortably exceed worst-case grade wall-time (AI
// timeout ~120s + retries), but short enough that a crashed grade resumes
// reasonably soon. MAX_ATTEMPTS — how many times a poison submission (one that
// crashes the container every run) is resumed before the reaper fails + refunds
// it for good. Both must match the values the reaper uses (stuck-submissions.ts).
export function gradingLeaseSeconds(): number {
  const raw = Number(Deno.env.get("GRADING_LEASE_SECONDS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 900; // 15 min
}
export function gradingMaxAttempts(): number {
  const raw = Number(Deno.env.get("GRADING_MAX_ATTEMPTS"));
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 3;
}

// US-569 (was US-773): the atomic grading claim, extracted (with an injectable
// updater) so the lease/idempotency logic is unit-testable without a DB. The
// default updater calls the claim_grade_lease RPC (migration 00161): a single
// conditional UPDATE that LEASES a gradeable row to one caller. Of N concurrent
// kicks exactly one gets 'claimed'; the rest see the live lease (or an existing
// report) and no-op. Because the lease EXPIRES, a crashed run can be re-claimed
// and resumed later — the difference from the old set-once grading_started_at.
//
// The RPC returns the rich codes claimed | done | leased | exhausted | gone; the
// caller only needs four outcomes, so we collapse leased/exhausted/gone into the
// single no-op "already" (the reaper does its own attempt accounting):
//
//   "claimed" → we own the grade run
//   "done"    → an active report already exists → finalize, don't re-grade
//   "already" → a live lease / poison / terminal row → no-op
//   "error"   → transient DB error claiming → caller reports it
export type GradingClaimResult = "claimed" | "done" | "already" | "error";

// RPC status → caller outcome.
type RpcClaimStatus = "claimed" | "done" | "leased" | "exhausted" | "gone";

export type GradingClaimUpdater = (submissionId: string) => Promise<{
  // 'status' is the rich RPC result. 'row' is kept for backward-compatible fakes
  // that only model the claimed/not-claimed (set-once) contract — a non-null row
  // is treated as 'claimed', a null row as 'already' (no-op).
  status?: RpcClaimStatus;
  row?: { id: string } | null;
  error: { message?: string } | null;
}>;

const defaultGradingClaimUpdater: GradingClaimUpdater = async (submissionId) => {
  const { data, error } = await supabaseAdmin.rpc("claim_grade_lease", {
    p_submission_id: submissionId,
    p_lease_seconds: gradingLeaseSeconds(),
    p_max_attempts: gradingMaxAttempts(),
  });
  return { status: (data as RpcClaimStatus | null) ?? undefined, error };
};

export async function claimSubmissionForGrading(
  submissionId: string,
  update: GradingClaimUpdater = defaultGradingClaimUpdater,
): Promise<GradingClaimResult> {
  const { status, row, error } = await update(submissionId);
  if (error) return "error";
  if (status) return status === "claimed" || status === "done" ? status : "already";
  // Backward-compat for row-shaped fakes (the old set-once model).
  return row ? "claimed" : "already";
}

// US-479: admin reject-and-regrade. The old admin "re-trigger grading" action
// was a DIRECT browser write that flipped status to 'processing' and stopped —
// nothing re-ran the pipeline, so the submission hung in 'processing' forever
// (no worker). This re-invokes the grading pipeline server-side and SUPERSEDES
// the prior report.
//
// The orchestration is extracted behind an injectable store so the supersede →
// reset → re-kick contract is unit-testable WITHOUT a DB or a live Claude call
// (mirrors the AbandonedSweepStore idiom in stuck-submissions.ts). The default
// store wires it to supabaseAdmin + processSubmission.
export interface RegradeStore {
  /** The submission to regrade, or null if it doesn't exist. */
  loadSubmission: (
    submissionId: string,
  ) => Promise<{ id: string; status: string | null; title: string | null } | null>;
  /**
   * Mark every ACTIVE (superseded_at IS NULL) report for the submission as
   * superseded and withhold its certificate (null certificate_id) so the stale
   * public certificate stops verifying. Returns the superseded report ids.
   * Non-destructive — referencing disputes/human_reviews/grade_outcomes survive.
   */
  supersedePriorReports: (submissionId: string) => Promise<string[]>;
  /**
   * Reset the submission so the pipeline's atomic claim (grading_started_at IS
   * NULL + status pending/processing) will pick it up again on the re-kick.
   * Clears any prior abstention feedback + moderation flag.
   */
  resetForRegrade: (submissionId: string) => Promise<void>;
  /** Re-invoke the grading pipeline (the in-process worker). */
  kick: (submissionId: string) => Promise<void> | void;
}

export type RegradeResult =
  | { ok: true; supersededReportIds: string[]; previousStatus: string | null; title: string | null }
  | { ok: false; status: number; error: string };

export async function regradeSubmission(
  submissionId: string,
  store: RegradeStore,
): Promise<RegradeResult> {
  const submission = await store.loadSubmission(submissionId);
  if (!submission) {
    return { ok: false, status: 404, error: "Submission not found" };
  }

  // Supersede BEFORE the re-kick so the about-to-be-created report is the only
  // active one the moment the pipeline inserts it.
  const supersededReportIds = await store.supersedePriorReports(submissionId);

  // Reset so the pipeline can re-claim the row. After this the submission is
  // 'pending' (not stuck in 'processing' with no worker): the re-kick runs the
  // pipeline to a terminal status, and the stuck/stranded-paid sweeps are the
  // backstop if the container dies mid-grade.
  await store.resetForRegrade(submissionId);

  await store.kick(submissionId);

  return {
    ok: true,
    supersededReportIds,
    previousStatus: submission.status,
    title: submission.title,
  };
}

// Default store: supabaseAdmin reads/writes + processSubmission re-kick.
export const defaultRegradeStore: RegradeStore = {
  loadSubmission: async (submissionId) => {
    const { data } = await supabaseAdmin
      .from("submissions")
      .select("id, status, title")
      .eq("id", submissionId)
      .maybeSingle();
    return (
      (data as { id: string; status: string | null; title: string | null } | null) ?? null
    );
  },
  supersedePriorReports: async (submissionId) => {
    const { data: active } = await supabaseAdmin
      .from("grade_reports")
      .select("id")
      .eq("submission_id", submissionId)
      .is("superseded_at", null);
    const ids = ((active ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length > 0) {
      await supabaseAdmin
        .from("grade_reports")
        .update({ superseded_at: new Date().toISOString(), certificate_id: null })
        .in("id", ids);
    }
    return ids;
  },
  resetForRegrade: async (submissionId) => {
    await supabaseAdmin
      .from("submissions")
      .update({
        status: "pending",
        grading_started_at: null,
        // US-569: clear the lease + attempt budget so the re-kick can re-claim.
        // Without this, a submission that previously hit the attempt cap (status
        // 'failed') would claim → 'exhausted' on regrade and never re-run.
        grading_lease_until: null,
        grading_attempts: 0,
        quality_feedback: null,
        flagged: false,
        flag_reason: null,
        moderation_status: null,
      })
      .eq("id", submissionId);
  },
  kick: (submissionId) => {
    // Fire-and-forget; processSubmission's atomic claim guards a concurrent kick.
    processSubmission(submissionId).catch((err) => {
      console.error(
        `[Pipeline] regrade re-kick failed for submission ${submissionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  },
};

// US-569: the terminal "this submission is graded" write, shared by the normal
// completion path and the idempotent resume/finalize path. Advances status to
// 'completed', clears any abstention feedback, RELEASES the grading lease, and
// re-syncs the linked FlipDesk item + grading-bridge rows. Every write is
// idempotent (re-running just re-asserts the same terminal state), so a resume
// after a crash between the report insert and the status flip is safe. Returns
// the linked inventory item id (for the grade-ready deep link), or null.
async function applyTerminalCompletion(
  submissionId: string,
  grade: {
    gradeReportId: string;
    overallScore: number;
    gradeTier: string;
    certificateUrl: string | null;
  },
): Promise<string | null> {
  // Status + lease. Clearing grading_lease_until stops the reaper from ever
  // re-touching a completed row.
  await supabaseAdmin
    .from("submissions")
    .update({ status: "completed", quality_feedback: null, grading_lease_until: null })
    .eq("id", submissionId);

  // Sync a linked inventory item, if any.
  let linkedItemId: string | null = null;
  try {
    const { data: linkedItem } = await supabaseAdmin
      .from("inventory_items")
      .select("id, status")
      .eq("submission_id", submissionId)
      .maybeSingle();
    if (linkedItem) {
      linkedItemId = (linkedItem as { id: string }).id;
      const itemUpdate: Record<string, unknown> = {
        grade_report_id: grade.gradeReportId,
        grade_value: grade.overallScore,
        grade_label: grade.gradeTier,
        certificate_url: grade.certificateUrl,
      };
      if ((linkedItem as { status?: string }).status === "grading") {
        itemUpdate.status = "graded";
      }
      await supabaseAdmin
        .from("inventory_items")
        .update(itemUpdate)
        .eq("id", linkedItemId);
    }
  } catch (itemErr) {
    console.error(
      `[Pipeline] Inventory item sync error for submission ${submissionId}:`,
      itemErr instanceof Error ? itemErr.message : String(itemErr),
    );
  }

  // Sync the linked flipdesk_grading_submissions bridge row, if any.
  try {
    const nowIso = new Date().toISOString();
    const { data: fdLink } = await supabaseAdmin
      .from("flipdesk_grading_submissions")
      .select("id")
      .eq("submission_id", submissionId)
      .maybeSingle();
    if (fdLink) {
      await supabaseAdmin
        .from("flipdesk_grading_submissions")
        .update({ status: "completed", graded_at: nowIso, webhook_received_at: nowIso })
        .eq("id", (fdLink as { id: string }).id);
    }
  } catch (fdErr) {
    console.error(
      `[Pipeline] FlipDesk grading sync error for submission ${submissionId}:`,
      fdErr instanceof Error ? fdErr.message : String(fdErr),
    );
  }

  return linkedItemId;
}

// US-569: idempotent resume. When a kick finds an already-graded submission (a
// crash landed between the grade_report insert and the status='completed' flip),
// finish the terminal wiring WITHOUT re-running or re-billing the AI. Returns
// true if an active report existed (finalized or already complete), false if
// there's nothing to finalize (the normal "no second grade" no-op).
export async function finalizeIfAlreadyGraded(submissionId: string): Promise<boolean> {
  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select("id, overall_score, grade_tier, certificate_id")
    .eq("submission_id", submissionId)
    .is("superseded_at", null)
    .maybeSingle();
  if (!report) return false;

  const r = report as {
    id: string;
    overall_score: number;
    grade_tier: string;
    certificate_id: string | null;
  };
  const { data: sub } = await supabaseAdmin
    .from("submissions")
    .select("status")
    .eq("id", submissionId)
    .maybeSingle();
  // Already terminal-complete — nothing to finalize. (The reaper ignores
  // non-'processing' rows, so a lingering lease on a completed row is harmless.)
  if ((sub as { status?: string } | null)?.status === "completed") return true;

  await applyTerminalCompletion(submissionId, {
    gradeReportId: r.id,
    overallScore: r.overall_score,
    gradeTier: r.grade_tier,
    certificateUrl: r.certificate_id ? certificateUrl(r.certificate_id) : null,
  });
  console.log(`[Pipeline] Resumed + finalized already-graded submission ${submissionId}`);
  return true;
}

export async function processSubmission(submissionId: string) {
  const startTime = Date.now();

  console.log(`[Pipeline] Starting grading pipeline for submission ${submissionId}`);

  // US-569: lease-based claim. The lease guards against a double-kick (webhook +
  // client ?pay_retry=1 both call processSubmission, and a second grade run would
  // double-bill Claude) AND, because it expires, lets a crashed run be resumed
  // later. Exactly one caller wins 'claimed'; duplicates/resumes no-op or
  // finalize.
  const claimResult = await claimSubmissionForGrading(submissionId);
  if (claimResult === "error") {
    // Transient DB error claiming the row — propagate so the caller's .catch
    // reports it. We have NOT started grading, so there's no spend to reverse.
    throw new Error(`Failed to claim submission ${submissionId} for grading`);
  }
  if (claimResult === "done" || claimResult === "already") {
    // 'done'  → an active grade_report already exists; a crash landed between the
    //           report insert and the status='completed' flip. Finalize cheaply
    //           (status + link sync) WITHOUT re-running or re-billing the AI.
    // 'already' → a live lease, a poison (exhausted) row, or a terminal row.
    //           finalizeIfAlreadyGraded no-ops when there's no active report, so
    //           it's safe to call here too (it covers a race where a fake/older
    //           claim path reports 'already' for a row that did get a report).
    const finalized = await finalizeIfAlreadyGraded(submissionId);
    console.log(
      `[Pipeline] Submission ${submissionId} claim=${claimResult} — ${
        finalized ? "finalized existing grade (no re-grade)" : "skipping duplicate grade run"
      }`,
    );
    return;
  }

  try {
    // --- Step 1: Fetch submission record ---
    const { data: submission, error: submissionError } = await supabaseAdmin
      .from("submissions")
      .select("id, user_id, garment_type, garment_category, brand, title, description, status, style_attributes, verified_capture_opt_in, created_at")
      .eq("id", submissionId)
      .single();

    if (submissionError || !submission) {
      throw new Error(`Submission not found: ${submissionId}`);
    }

    // --- Step 2: Fetch associated images ---
    const { data: images, error: imagesError } = await supabaseAdmin
      .from("submission_images")
      .select("id, image_type, storage_path, display_order, phash, exif, original_storage_path")
      .eq("submission_id", submissionId)
      .order("display_order", { ascending: true });

    if (imagesError || !images || images.length === 0) {
      throw new Error(`No images found for submission ${submissionId}`);
    }

    console.log(`[Pipeline] Found ${images.length} images for submission ${submissionId}`);

    // Seller-declared design features (e.g. distressed, raw-hem) flow through
    // as a hint so the grader doesn't read intentional distressing as damage.
    // Declared here (not inside the buffer-slot closure) because it's also used
    // by the composite grade below.
    const styleHint: string[] = Array.isArray(submission.style_attributes)
      ? (submission.style_attributes as string[])
      : [];

    // --- Steps 3+4: download → base64 → per-image analysis, under a
    // process-wide memory gate (US-573). The base64 data URIs stay resident
    // for the whole analysis, so the slot is held across BOTH steps — this
    // bounds how many submissions buffer multi-MB image data at once and is
    // what keeps concurrent grading from OOM-ing the container. The closure
    // scopes `imageData` so the base64 is GC-eligible the moment it returns.
    const settledImages: SettledImage[] = await withImageBufferSlot(async () => {
      // --- Step 3: Download images from storage and convert to base64 ---
      const imageDataPromises = images.map(async (image) => {
        const { data: fileData, error: downloadError } = await supabaseAdmin.storage
          .from("submission-images")
          .download(image.storage_path);

        if (downloadError || !fileData) {
          throw new Error(`Failed to download image: ${image.storage_path}`);
        }

        // Convert Blob to base64
        const arrayBuffer = await fileData.arrayBuffer();
        const base64 = uint8ToBase64(new Uint8Array(arrayBuffer));

        // Determine media type from file extension
        const ext = image.storage_path.split(".").pop()?.toLowerCase() || "jpg";
        const mediaTypeMap: Record<string, string> = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          gif: "image/gif",
          webp: "image/webp",
        };
        const mediaType = mediaTypeMap[ext] || "image/jpeg";

        // Return as data URI for analyzeImage
        return {
          imageType: image.image_type,
          dataUri: `data:${mediaType};base64,${base64}`,
        };
      });

      const imageData = await Promise.all(imageDataPromises);

      // --- Step 4: Run analyzeImage() on each image in parallel ---
      console.log(`[Pipeline] Running per-image analysis for ${imageData.length} images`);

      const perImagePromises = imageData.map((img) =>
        analyzeImage(
          img.dataUri,
          img.imageType,
          submission.garment_type,
          submission.garment_category,
          styleHint
        )
      );

      // US-485: allSettled (not all) so one flaky image doesn't fail the whole
      // paid grade. analyzeImage already retries + has a bounded timeout via the
      // Anthropic SDK (getAiMaxRetries / getAiTimeoutMs).
      const settled = await Promise.allSettled(perImagePromises);
      const results: SettledImage[] = settled.map((s, i) => ({
        imageType: imageData[i].imageType,
        result: s.status === "fulfilled" ? s.value : null,
      }));
      settled.forEach((s, i) => {
        if (s.status === "rejected") {
          console.error(
            `[Pipeline] analyzeImage failed for ${imageData[i].imageType} ` +
              `(submission ${submissionId}): ${s.reason}`,
          );
        }
      });
      return results;
    });

    const { usable, failedRequired, failedOptional } = partitionImageResults(
      settledImages,
      REQUIRED_IMAGE_TYPES,
    );

    // A core angle's analysis failed (or nothing succeeded) — can't grade
    // reliably. Preserve prior behavior: throw so the catch reverses the charge.
    if (failedRequired.length > 0 || usable.length === 0) {
      throw new Error(
        `Required image analysis failed for submission ${submissionId}: ` +
          (failedRequired.join(", ") || "no images analyzed"),
      );
    }

    // Only optional images failed — degrade gracefully (US-485).
    const partialSuccess = failedOptional.length > 0;
    if (partialSuccess) {
      console.warn(
        `[Pipeline] partial-success grade for ${submissionId}: dropped ` +
          `${failedOptional.length} optional image(s): ${failedOptional.join(", ")}`,
      );
      void captureServer("grading-engine", "grading.partial_success", {
        submission_id: submissionId,
        dropped_count: failedOptional.length,
        dropped_types: failedOptional,
        graded_count: usable.length,
      });
    }

    const perImageResults: PerImageAnalysis[] = usable;

    console.log(`[Pipeline] Per-image analysis complete for submission ${submissionId}`);

    // --- Step 4b: Pre-grade image-quality gate + active abstention (US-332) ---
    // If a core photo is unusable (severe blur / too dark / cut off / illegible
    // label) or a required angle is missing, abstain rather than emit a
    // low-confidence guess. This is NOT a failed grade and creates no
    // grade_report — so no paid grade credit is consumed (when auto-debit
    // US-207 lands it must run AFTER this gate / on a created report only).
    const qualityGate = evaluateImageQuality(
      perImageResults.map((r) => ({
        image_type: r.image_type,
        quality: r.quality,
      })),
    );
    if (qualityGate.abstain) {
      console.log(
        `[Pipeline] Submission ${submissionId} ABSTAINED on image quality: ${qualityGate.summary}`,
      );
      await supabaseAdmin
        .from("submissions")
        .update({
          status: "needs_photos",
          quality_feedback: {
            summary: qualityGate.summary,
            photo_requests: qualityGate.photo_requests,
            issues: qualityGate.issues,
            assessed_at: new Date().toISOString(),
          },
        })
        .eq("id", submissionId);
      // AC #4: abstention must not consume a paid grade. Reverse the charge
      // taken at submit (included grade returned / credits re-granted; a
      // Stripe per-grade payment is flagged for manual refund).
      await reverseChargeForUngradedSubmission(submissionId, "quality abstention");
      return null;
    }

    // --- Step 5: Run compositeGrade() with all per-image results ---
    const garmentInfo: GarmentInfo = {
      garment_type: submission.garment_type,
      garment_category: submission.garment_category,
      brand: submission.brand,
      title: submission.title,
      description: submission.description,
      style_attributes: styleHint,
    };

    console.log(`[Pipeline] Running composite grading for submission ${submissionId}`);

    const compositeResult: CompositeGradeResult = await compositeGrade(
      perImageResults,
      garmentInfo
    );

    // US-485: a grade produced from an incomplete image set must not ship
    // confidently — cap confidence below the review threshold and route to a
    // human so the dropped angle is checked.
    if (partialSuccess) {
      compositeResult.confidence_score = Math.min(
        compositeResult.confidence_score,
        PARTIAL_IMAGE_CONFIDENCE_CAP,
      );
      compositeResult.needs_human_review = true;
    }

    // --- Step 6: Create grade report record ---
    const certificateId = crypto.randomUUID();

    // Build detailed_notes from per-image analyses
    const detailedNotes: Record<string, string> = {};
    for (const result of perImageResults) {
      const issues = result.detected_issues
        .map((i) => `[${i.severity}] ${i.issue} (${i.location})`)
        .join("; ");
      const signals = result.condition_signals
        .map((s) => `[${s.sentiment}] ${s.signal}`)
        .join("; ");
      detailedNotes[result.image_type] = `Issues: ${issues || "None"}. Signals: ${signals || "None"}.`;
    }

    // Add defects summary
    if (compositeResult.defects_found.length > 0) {
      detailedNotes["defects_summary"] = compositeResult.defects_found
        .map((d) => `[${d.severity}] ${d.defect} at ${d.location} — ${d.impact_on_grade}`)
        .join("; ");
    }

    // Add intentional-design summary so the certificate / report can show that
    // distressing was assessed as styling, not counted as damage.
    if (compositeResult.style_attributes.length > 0) {
      detailedNotes["style_attributes_summary"] = compositeResult.style_attributes
        .map((s) => `${s.attribute}${s.location ? ` (${s.location})` : ""}`)
        .join("; ");
    }

    // Add an authenticity note when the photo-authenticity check (US-336/338)
    // flagged anything, so admins/reviewers see why the grade was held.
    const authenticity = compositeResult.image_authenticity;
    if (authenticity.manipulation_suspected || authenticity.screenshot_or_watermark_detected) {
      const tells = authenticity.tells.length > 0 ? ` Tells: ${authenticity.tells.join("; ")}.` : "";
      const where =
        authenticity.flagged_image_types.length > 0
          ? ` Images: ${authenticity.flagged_image_types.join(", ")}.`
          : "";
      detailedNotes["authenticity_summary"] = `${authenticity.summary}${tells}${where}`;
    }

    // US-337: photo-reuse detection. The same photo appearing under a DIFFERENT
    // account is the strong stolen/recycled-listing signal; a same-account match
    // is just a relist (recorded but not flagged).
    const reuse = await detectPhotoReuse({
      submissionId,
      ownerId: submission.user_id,
      images: images.map((img) => ({
        image_type: img.image_type,
        phash: (img as { phash?: string | null }).phash ?? null,
      })),
    });
    if (reuse.matched) {
      const closest = Math.min(...reuse.matches.map((m) => m.distance));
      detailedNotes["photo_reuse"] =
        `${reuse.summary} (${reuse.matches.length} image(s), closest ${closest} bits).`;
    }

    // US-340: Verified Capture — opt-in provenance booster + badge. A POSITIVE
    // signal only: it can earn a badge + a small confidence boost but NEVER
    // lowers a grade, and missing EXIF is never penalized. Anti-gaming checks
    // (consistent recent unedited device, no cross-account reuse) run here,
    // server-side, so the opt-in flag alone grants nothing.
    const verifiedCapture = evaluateVerifiedCapture({
      optedIn: (submission as { verified_capture_opt_in?: boolean })
        .verified_capture_opt_in === true,
      submittedAtMs: Date.parse(
        (submission as { created_at?: string }).created_at ?? "",
      ) || Date.now(),
      images: images.map((img) => ({
        image_type: img.image_type,
        exif: ((img as { exif?: Record<string, unknown> | null }).exif) ?? null,
      })),
      crossUserReuse: reuse.cross_user,
      nowMs: Date.now(),
    });
    if (verifiedCapture.verified) {
      // Bump confidence (never down), respecting the partial-image ceiling so an
      // incomplete image set can't be boosted past its review cap.
      const ceiling = partialSuccess ? PARTIAL_IMAGE_CONFIDENCE_CAP : 1;
      compositeResult.confidence_score = Math.min(
        ceiling,
        Math.max(
          compositeResult.confidence_score,
          compositeResult.confidence_score + verifiedCaptureBoost(),
        ),
      );
      detailedNotes["verified_capture"] =
        `Verified Capture earned — ${verifiedCapture.reasons.join("; ")}.`;
    } else if (
      (submission as { verified_capture_opt_in?: boolean })
        .verified_capture_opt_in === true
    ) {
      // Opted in but didn't qualify — record why for admin review. Not a flag,
      // not a penalty; the grade is unaffected.
      detailedNotes["verified_capture"] =
        `Verified Capture not earned — ${verifiedCapture.reasons.join("; ")}.`;
    }

    // US-341: server-side forensic / manipulation pass on RETAINED ORIGINALS.
    // A second, byte/structure-level line of manipulation evidence that runs
    // only where an uncompressed original was kept (US-339) and is fused with
    // the US-336 vision authenticity signal into one tamper assessment. The
    // fusion adjusts confidence + review routing; on a compressed-only
    // submission the pass is skipped cleanly and the result equals the vision
    // signal (no behavior change). Never throws — best-effort.
    const forensicInputs: ForensicInputImage[] = images.map((img) => ({
      image_type: img.image_type,
      original_storage_path:
        (img as { original_storage_path?: string | null })
          .original_storage_path ?? null,
      exif: ((img as { exif?: Record<string, unknown> | null }).exif) ?? null,
    }));
    const forensic = await runForensicPass(
      forensicInputs,
      async (storagePath) => {
        const { data, error } = await supabaseAdmin.storage
          .from("submission-images")
          .download(storagePath);
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
      },
    ).catch((err) => {
      console.error(
        `[Pipeline] Forensic pass error for submission ${submissionId}:`,
        err instanceof Error ? err.message : String(err),
      );
      // Fall back to a not-run assessment so fusion is just the vision signal.
      return {
        ran: false,
        analyzed_count: 0,
        tamper_likelihood: 0,
        suspected: false,
        per_image: [],
        tells: [],
        flagged_image_types: [],
        summary: "Forensic pass failed; vision signal only.",
      };
    });

    const fusedTamper = fuseTamperSignals(forensic, authenticity);
    if (fusedTamper.forensic_ran) {
      // Forensic evidence (pixel-level provenance) corroborates or contradicts
      // the vision check. Route to a human and shave confidence by the fused
      // penalty (floored at 0). The penalty can override an earlier
      // verified-capture boost — manipulation evidence must win over provenance.
      if (fusedTamper.needs_review) {
        compositeResult.needs_human_review = true;
        compositeResult.confidence_score = Math.max(
          0,
          compositeResult.confidence_score - fusedTamper.confidence_penalty,
        );
      }
      detailedNotes["forensic_analysis"] = fusedTamper.tells.length > 0
        ? `${fusedTamper.summary} Tells: ${fusedTamper.tells.join("; ")}.`
        : fusedTamper.summary;
    }

    // US-333: tamper-evident integrity. Hash the canonical (already-public)
    // grade fields and sign the hash if CERT_SIGNING_KEY is set. The public
    // /cert/:id/verify endpoint re-derives this from the stored row to confirm
    // the certificate hasn't been altered (or a screenshot forged).
    const integrity = await buildCertIntegrity({
      certificate_id: certificateId,
      overall_score: compositeResult.overall_score,
      grade_tier: compositeResult.grade_tier,
      fabric_condition_score: compositeResult.factor_scores.fabric_condition,
      structural_integrity_score:
        compositeResult.factor_scores.structural_integrity,
      cosmetic_appearance_score:
        compositeResult.factor_scores.cosmetic_appearance,
      functional_elements_score:
        compositeResult.factor_scores.functional_elements,
      odor_cleanliness_score: compositeResult.factor_scores.odor_cleanliness,
      ai_summary: compositeResult.ai_summary,
      // US-770: the buyer-facing write-up is a certified claim sealed into the
      // content hash (integrity v2). Any future reseal-on-edit path (US-475)
      // MUST likewise pass buyer_writeup so the recomputed hash keeps matching.
      buyer_writeup: compositeResult.buyer_writeup,
    });

    // US-484: evaluate moderation flags BEFORE the certificate becomes public.
    // The grade_reports insert below carries a non-null certificate_id, which is
    // what makes /api/content/public/certificates/:id resolvable. If we only
    // flagged the submission AFTER that insert (the old order), there was a
    // window — and, if that later update failed, a PERMANENT leak — where a
    // suspect certificate was live and un-withheld. So decide the flag now and
    // write the withhold state first; the cert is born already-withheld and the
    // public endpoint 404s it (see isCertificateWithheld) until a human clears
    // it. The terminal status="completed" write still happens after the report
    // exists (Step 7), so a "completed" submission always has a report row.
    const flagReasons: string[] = [];
    if (!compositeResult.image_validity.is_clothing) {
      flagReasons.push(
        compositeResult.image_validity.reason ||
          "Submitted images may not depict an item of clothing."
      );
    }
    // US-336/US-338: route suspected-manipulation / screenshot submissions into
    // the moderation queue (in addition to needs_human_review on the grade).
    if (authenticity.manipulation_suspected || authenticity.screenshot_or_watermark_detected) {
      flagReasons.push(authenticity.summary);
    }
    // US-341: the fused forensic+vision tamper signal can flag manipulation the
    // vision pass alone missed (forensic-only or corroborated).
    if (
      fusedTamper.forensic_ran &&
      fusedTamper.manipulation_suspected &&
      fusedTamper.forensic_suspected
    ) {
      flagReasons.push(fusedTamper.summary);
    }
    // US-337: a cross-account photo match is a moderation concern (possible
    // stolen/recycled listing). Same-account relists are not flagged.
    if (reuse.cross_user) {
      flagReasons.push(reuse.summary);
    }
    const flagReason = flagReasons.length > 0 ? flagReasons.join(" ") : null;
    if (flagReason) {
      console.warn(
        `[Pipeline] Submission ${submissionId} FLAGGED for moderation: ${flagReason}`
      );
      await supabaseAdmin
        .from("submissions")
        .update({ flagged: true, flag_reason: flagReason })
        .eq("id", submissionId);
    }

    const { data: gradeReport, error: reportError } = await supabaseAdmin
      .from("grade_reports")
      .insert({
        submission_id: submissionId,
        overall_score: compositeResult.overall_score,
        grade_tier: compositeResult.grade_tier,
        fabric_condition_score: compositeResult.factor_scores.fabric_condition,
        structural_integrity_score: compositeResult.factor_scores.structural_integrity,
        cosmetic_appearance_score: compositeResult.factor_scores.cosmetic_appearance,
        functional_elements_score: compositeResult.factor_scores.functional_elements,
        odor_cleanliness_score: compositeResult.factor_scores.odor_cleanliness,
        ai_summary: compositeResult.ai_summary,
        // US-759: longer buyer-facing certified write-up.
        buyer_writeup: compositeResult.buyer_writeup,
        detailed_notes: detailedNotes,
        // Intentional design features the AI judged present (distressing, raw
        // hems, etc.) — these did NOT lower the grade.
        detected_style_attributes: compositeResult.style_attributes,
        // GENUINE wear/damage (structured) — powers the Auto-Disclosure Engine
        // (condition & flaws section + annotated defect photos).
        defects_found: compositeResult.defects_found,
        // Full per-image trace for eval/training + dispute explanation.
        per_image_analysis: perImageResults,
        confidence_score: compositeResult.confidence_score,
        needs_human_review: compositeResult.needs_human_review,
        // US-336/US-338: aggregated photo-authenticity assessment (manipulation /
        // screenshot / watermark). Surfaced on the certificate + admin review.
        image_authenticity: compositeResult.image_authenticity,
        // US-340: Verified Capture provenance result. Structured detail kept for
        // admin review; the public view exposes only the pass/fail boolean.
        verified_capture: verifiedCapture,
        // US-341: forensic manipulation pass fused with the vision signal.
        // Stored only when an original was retained (else the pass didn't run);
        // internal anti-fraud data, never exposed on the public certificate.
        forensic_analysis: forensic.ran
          ? { ...fusedTamper, forensic }
          : null,
        // Record the real model + prompt version (e.g.
        // "claude-sonnet-4-6|composite_v2") so accuracy-tracking can
        // distinguish model changes, not just prompt revisions. prompt_version
        // is also stored on its own column for the accuracy join.
        model_version: `${compositeResult.model}|${compositeResult.prompt_version}`,
        prompt_version: compositeResult.prompt_version,
        certificate_id: certificateId,
        // US-333: tamper-evident integrity columns (migration 00068).
        content_hash: integrity.content_hash,
        content_signature: integrity.content_signature,
        integrity_version: integrity.integrity_version,
      })
      .select()
      .single();

    if (reportError || !gradeReport) {
      console.error("[Pipeline] Failed to create grade report:", reportError);
      throw new Error("Failed to create grade report record");
    }

    // US-583: record per-call Anthropic token usage so the admin dashboard can
    // report per-grade AI cost + gross margin. Fire-and-forget — a cost-tracking
    // write must never fail or slow a completed paid grade.
    void recordAiUsage({
      userId: submission.user_id,
      submissionId,
      usages: [
        ...perImageResults
          .filter((r) => r.usage)
          .map((r) => ({ phase: "per_image", usage: r.usage! })),
        ...(compositeResult.usage
          ? [{ phase: "composite", usage: compositeResult.usage }]
          : []),
      ],
    });

    // US-626: nudge the seller (iOS) when their grade was flagged for a human
    // check. Best-effort — never blocks the pipeline.
    if (compositeResult.needs_human_review) {
      void pushReviewNeeded(submission.user_id, submission.title);
    }

    // The certificate is public the moment the report exists (its
    // certificate_id is non-null). Ping IndexNow so Bing/Yandex/etc. index the
    // new /cert/:id page promptly (US-296). Fire-and-forget — never blocks or
    // fails grading; no-ops when INDEXNOW_KEY is unset.
    submitUrls([certificateUrl(certificateId)]).catch((e) =>
      console.warn("[Pipeline] IndexNow submit failed:", e),
    );

    // --- Step 7: Terminal completion (status + lease release + link sync) ---
    // Moderation flags were already evaluated and written ABOVE (US-484), before
    // the certificate became public — so this terminal write only advances the
    // status, clears any prior abstention feedback, and RELEASES the grading
    // lease (US-569). It deliberately does NOT touch flagged/flag_reason, leaving
    // a withheld cert withheld. applyTerminalCompletion is idempotent and shared
    // with the resume/finalize path. linkedItemId is captured so the grade-ready
    // notification (step 10) can deep-link straight to the FlipDesk item.
    const linkedItemId = await applyTerminalCompletion(submissionId, {
      gradeReportId: gradeReport.id,
      overallScore: compositeResult.overall_score,
      gradeTier: compositeResult.grade_tier,
      // Public certificate URL — consumed by the FlipDesk grade card ("Open
      // certificate") and embedded in listing descriptions (listing-templates.ts).
      certificateUrl: certificateUrl(certificateId),
    });

    const totalMs = Date.now() - startTime;
    console.log(
      `[Pipeline] Grading pipeline COMPLETE for submission ${submissionId} | ` +
        `overall_score=${compositeResult.overall_score} | grade_tier=${compositeResult.grade_tier} | ` +
        `confidence=${compositeResult.confidence_score} | total_ms=${totalMs}`
    );

    // --- Step 7d: Shadow / A-B grading (US-330, fire-and-forget) ---
    // Re-run ONLY the composite stage with any shadow candidate prompt on a
    // sampled fraction of live traffic, reusing the per-image analyses. Stored
    // separately in grading_shadow_results; NEVER affects this customer's grade
    // or certificate. Never blocks/fails the pipeline.
    void runShadowGrades({
      submissionId,
      userId: submission.user_id,
      gradeReportId: gradeReport.id,
      activePromptVersion: compositeResult.prompt_version,
      activeOverallScore: compositeResult.overall_score,
      activeGradeTier: compositeResult.grade_tier,
      activeFactorScores: compositeResult.factor_scores,
      perImageResults,
      garmentInfo,
    }).catch((err) =>
      console.error(
        `[Pipeline] shadow grading error for submission ${submissionId}:`,
        err instanceof Error ? err.message : String(err),
      )
    );

    // --- Step 8: Send webhook notifications (fire-and-forget) ---
    notifyWebhooks(submission.user_id, submissionId, gradeReport as Record<string, unknown>).catch(
      (err) => {
        console.error(
          `[Pipeline] Webhook delivery error for submission ${submissionId}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    );

    // --- Step 9: Send grade complete email (fire-and-forget) ---
    (async () => {
      try {
        const { data: user } = await supabaseAdmin
          .from("users")
          .select("email, full_name, notification_preferences")
          .eq("id", submission.user_id)
          .single();

        // Respect the user's notification preferences (default: enabled).
        const emailEnabled =
          user?.notification_preferences?.grade_complete?.email !== false;

        if (user?.email && emailEnabled) {
          await sendGradeCompleteEmail(user.email, {
            userName: user.full_name || "there",
            submissionTitle: submission.title,
            overallScore: compositeResult.overall_score,
            gradeTier: compositeResult.grade_tier,
            submissionId,
            certificateId,
          });
        }
      } catch (emailErr) {
        console.error(
          `[Pipeline] Email notification error for submission ${submissionId}:`,
          emailErr instanceof Error ? emailErr.message : String(emailErr)
        );
      }
    })();

    // --- Step 10: In-app "grade ready" notification (fire-and-forget) ---
    // Deep-links to the FlipDesk item when this grade came from the bridge,
    // otherwise to the submission. Respects the grade_complete in-app pref.
    notifyUser(submission.user_id, {
      type: "grading_ready",
      title: "Grade ready",
      message: `${submission.title} graded ${compositeResult.overall_score.toFixed(
        1,
      )} · ${compositeResult.grade_tier}.`,
      link: linkedItemId
        ? `/dashboard/flipdesk/items/${linkedItemId}`
        : `/dashboard/submissions/${submissionId}`,
    }).catch((notifyErr) => {
      console.error(
        `[Pipeline] In-app notification error for submission ${submissionId}:`,
        notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
      );
    });

    return gradeReport;
  } catch (error) {
    const totalMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error(
      `[Pipeline] Grading pipeline FAILED for submission ${submissionId} | ` +
        `total_ms=${totalMs} | error=${errorMessage}`
    );

    // Update submission status to 'failed'
    try {
      await supabaseAdmin
        .from("submissions")
        .update({ status: "failed" })
        .eq("id", submissionId);
    } catch (updateError) {
      console.error(
        `[Pipeline] Failed to update submission status to 'failed':`,
        updateError
      );
    }

    // Reverse the charge taken before the pipeline ran. See
    // reverseChargeForUngradedSubmission().
    await reverseChargeForUngradedSubmission(submissionId, "grading failed");

    // Mirror failure into the FlipDesk link so the bridge UI doesn't
    // hang at "processing" forever.
    try {
      await supabaseAdmin
        .from("flipdesk_grading_submissions")
        .update({
          status: "failed",
          error: errorMessage.slice(0, 500),
        })
        .eq("submission_id", submissionId);
    } catch (fdErr) {
      console.error(
        `[Pipeline] FlipDesk failure-sync error for submission ${submissionId}:`,
        fdErr instanceof Error ? fdErr.message : String(fdErr)
      );
    }

    throw error;
  }
}

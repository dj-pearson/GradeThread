import { supabaseAdmin } from "./supabase.ts";
import {
  analyzeImage,
  compositeGrade,
  type PerImageAnalysis,
  type GarmentInfo,
  type CompositeGradeResult,
} from "./ai-grading.ts";
import { notifyWebhooks } from "./webhook-delivery.ts";
import { sendGradeCompleteEmail } from "./email.ts";

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
export async function processSubmission(submissionId: string) {
  const startTime = Date.now();

  console.log(`[Pipeline] Starting grading pipeline for submission ${submissionId}`);

  try {
    // --- Step 1: Fetch submission record ---
    const { data: submission, error: submissionError } = await supabaseAdmin
      .from("submissions")
      .select("id, user_id, garment_type, garment_category, brand, title, description, status, style_attributes")
      .eq("id", submissionId)
      .single();

    if (submissionError || !submission) {
      throw new Error(`Submission not found: ${submissionId}`);
    }

    if (submission.status !== "pending" && submission.status !== "processing") {
      throw new Error(`Submission ${submissionId} is not pending/processing (status: ${submission.status})`);
    }

    // Update status to 'processing' if not already set
    if (submission.status === "pending") {
      await supabaseAdmin
        .from("submissions")
        .update({ status: "processing" })
        .eq("id", submissionId);
    }

    // --- Step 2: Fetch associated images ---
    const { data: images, error: imagesError } = await supabaseAdmin
      .from("submission_images")
      .select("id, image_type, storage_path, display_order")
      .eq("submission_id", submissionId)
      .order("display_order", { ascending: true });

    if (imagesError || !images || images.length === 0) {
      throw new Error(`No images found for submission ${submissionId}`);
    }

    console.log(`[Pipeline] Found ${images.length} images for submission ${submissionId}`);

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

    // Seller-declared design features (e.g. distressed, raw-hem) flow through
    // as a hint so the grader doesn't read intentional distressing as damage.
    const styleHint: string[] = Array.isArray(submission.style_attributes)
      ? (submission.style_attributes as string[])
      : [];

    const perImagePromises = imageData.map((img) =>
      analyzeImage(
        img.dataUri,
        img.imageType,
        submission.garment_type,
        submission.garment_category,
        styleHint
      )
    );

    const perImageResults: PerImageAnalysis[] = await Promise.all(perImagePromises);

    console.log(`[Pipeline] Per-image analysis complete for submission ${submissionId}`);

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
        detailed_notes: detailedNotes,
        // Intentional design features the AI judged present (distressing, raw
        // hems, etc.) — these did NOT lower the grade.
        detected_style_attributes: compositeResult.style_attributes,
        // Full per-image trace for eval/training + dispute explanation.
        per_image_analysis: perImageResults,
        confidence_score: compositeResult.confidence_score,
        needs_human_review: compositeResult.needs_human_review,
        // Record the real model + prompt version (e.g.
        // "claude-sonnet-4-6|composite_v2") so accuracy-tracking can
        // distinguish model changes, not just prompt revisions. prompt_version
        // is also stored on its own column for the accuracy join.
        model_version: `${compositeResult.model}|${compositeResult.prompt_version}`,
        prompt_version: compositeResult.prompt_version,
        certificate_id: certificateId,
      })
      .select()
      .single();

    if (reportError || !gradeReport) {
      console.error("[Pipeline] Failed to create grade report:", reportError);
      throw new Error("Failed to create grade report record");
    }

    // --- Step 7: Update submission status to 'completed' ---
    // Flag for moderation if the AI judged the images not to be clothing.
    const submissionUpdate: Record<string, unknown> = { status: "completed" };
    if (!compositeResult.image_validity.is_clothing) {
      submissionUpdate.flagged = true;
      submissionUpdate.flag_reason =
        compositeResult.image_validity.reason ||
        "Submitted images may not depict an item of clothing.";
      console.warn(
        `[Pipeline] Submission ${submissionId} FLAGGED for moderation: ${submissionUpdate.flag_reason}`
      );
    }
    await supabaseAdmin
      .from("submissions")
      .update(submissionUpdate)
      .eq("id", submissionId);

    // --- Step 7b: Sync a linked inventory item, if any ---
    try {
      const { data: linkedItem } = await supabaseAdmin
        .from("inventory_items")
        .select("id, status")
        .eq("submission_id", submissionId)
        .maybeSingle();

      if (linkedItem) {
        const itemUpdate: Record<string, unknown> = {
          grade_report_id: gradeReport.id,
          grade_value: compositeResult.overall_score,
          grade_label: compositeResult.grade_tier,
        };
        // Advance the lifecycle only if it's still mid-grading.
        if (linkedItem.status === "grading") {
          itemUpdate.status = "graded";
        }
        await supabaseAdmin
          .from("inventory_items")
          .update(itemUpdate)
          .eq("id", linkedItem.id);
      }
    } catch (itemErr) {
      console.error(
        `[Pipeline] Inventory item sync error for submission ${submissionId}:`,
        itemErr instanceof Error ? itemErr.message : String(itemErr)
      );
    }

    // --- Step 7c: Sync linked flipdesk_grading_submissions, if any ---
    // Same-process shortcut for the FlipDesk bridge — no need for the HMAC
    // webhook dance since we share the DB. Tracks completion time + status
    // so the FlipDesk UI can show "graded" without re-fetching the report.
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
          .update({
            status: "completed",
            graded_at: nowIso,
            webhook_received_at: nowIso,
          })
          .eq("id", (fdLink as { id: string }).id);
      }
    } catch (fdErr) {
      console.error(
        `[Pipeline] FlipDesk grading sync error for submission ${submissionId}:`,
        fdErr instanceof Error ? fdErr.message : String(fdErr)
      );
    }

    const totalMs = Date.now() - startTime;
    console.log(
      `[Pipeline] Grading pipeline COMPLETE for submission ${submissionId} | ` +
        `overall_score=${compositeResult.overall_score} | grade_tier=${compositeResult.grade_tier} | ` +
        `confidence=${compositeResult.confidence_score} | total_ms=${totalMs}`
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

    // Reverse the charge taken before the pipeline ran (runPaymentPrecedence
    // in grade.ts / the FlipDesk grading path). Included grades go back to the
    // monthly bundle; credit grades are re-granted. Idempotent via
    // submissions.refunded_at. One-time Stripe payments can't be refunded by
    // minting credits — they surface here for manual handling.
    try {
      const { data: refundResult, error: refundError } = await supabaseAdmin.rpc(
        "refund_grade",
        { p_submission_id: submissionId },
      );
      if (refundError) {
        console.error(
          `[Pipeline] REFUND FAILED for submission ${submissionId} — manual review needed:`,
          refundError.message,
        );
      } else if (typeof refundResult === "string" && refundResult === "no_refund_paid_stripe") {
        console.error(
          `[Pipeline] Submission ${submissionId} was paid via Stripe but grading failed — ` +
            `issue a Stripe refund manually.`,
        );
      } else {
        console.log(`[Pipeline] Refund for submission ${submissionId}: ${refundResult}`);
      }
    } catch (refundErr) {
      console.error(
        `[Pipeline] Refund error for submission ${submissionId} — manual review needed:`,
        refundErr instanceof Error ? refundErr.message : String(refundErr),
      );
    }

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

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
      .select("id, user_id, garment_type, garment_category, brand, title, description, status")
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
      const uint8Array = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const base64 = btoa(binary);

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
      analyzeImage(img.dataUri, img.imageType, submission.garment_type)
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
        confidence_score: compositeResult.confidence_score,
        model_version: compositeResult.prompt_version,
        certificate_id: certificateId,
      })
      .select()
      .single();

    if (reportError || !gradeReport) {
      console.error("[Pipeline] Failed to create grade report:", reportError);
      throw new Error("Failed to create grade report record");
    }

    // --- Step 7: Update submission status to 'completed' ---
    await supabaseAdmin
      .from("submissions")
      .update({ status: "completed" })
      .eq("id", submissionId);

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
          .select("email, full_name")
          .eq("id", submission.user_id)
          .single();

        if (user?.email) {
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

    throw error;
  }
}

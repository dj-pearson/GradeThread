import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { SNAD_OUTCOME_SOURCE } from "../lib/grade-snad-signal.ts";
import {
  CALIBRATION_SETTING_KEY,
  EMPTY_CALIBRATION,
  type CalibrationSetting,
} from "../lib/confidence-calibration.ts";
import {
  informationValue,
  type ReviewInfoContext,
} from "../lib/review-info-value.ts";
import { buildReviewInfoContext } from "../lib/review-queue-order.ts";
import { getSetting } from "../lib/system-settings.ts";
import { reviewConfidenceThreshold } from "../lib/ai-config.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import {
  computeAccuracySummary,
  computeClaimAccuracySignal,
  computeConfidenceCalibration,
  computeOutcomeFeedback,
  computeWeeklyAccuracySummary,
  exportTrainingDataset,
} from "../lib/accuracy-tracking.ts";
import {
  activatePromptVersion,
  promoteGradeReportToEvalCase,
  promoteHighSignalEvalCandidates,
  runEval,
  runPromptDryRun,
  checkPromptServingEligibility,
} from "../lib/grading-eval.ts";
import {
  activateExemplarSet,
  assembleExemplarSet,
  deactivateExemplarSet,
  evalExemplarSet,
} from "../lib/few-shot-exemplars.ts";
import { computeDefectAccuracyReport } from "../lib/defect-accuracy.ts";
import { correlateOutcomes } from "../lib/outcome-correlation.ts";
import { fetchOutcomeRows } from "../lib/outcome-correlation-fetch.ts";
import {
  authenticityGateStatus,
  EXPECTED_LABELS,
  runAuthenticityEval,
  summarizeCaseCoverage,
  validateAuthenticityCase,
  type AuthenticityCaseRow,
} from "../lib/authenticity-eval.ts";
import {
  AUTHENTICITY_PROMPT_VERSION,
  AUTHENTICITY_PROMPT_VERSION_GROUNDED,
  type AuthenticityVerdict,
} from "../lib/ai-authenticity.ts";
import {
  canPromoteToGoldenSet,
  isDangerousOverride,
  overrodeModel,
  validateReviewOutcome,
  type ReviewerVerdict,
} from "../lib/authenticity-review.ts";
import {
  draftTellFromCandidate,
  isPromotable,
  rankTellCandidates,
  type ReviewTellObservation,
} from "../lib/tell-candidates.ts";
import {
  summarizeSellerAuthenticity,
  type SellerAuthenticityRecord,
} from "../lib/authenticity-seller-signal.ts";
import {
  checkAuthenticityDrift,
  computeAuthenticityAccuracy,
  detectAuthenticityDrift,
  splitByCutoff,
  type AuthenticityObservation,
} from "../lib/authenticity-accuracy.ts";
import { recordMetric } from "../lib/observability.ts";
import { compareModelEvals, type ModelEvalRun } from "../lib/model-comparison.ts";
import { isAllowedGradingModel, servingModelForStage } from "../lib/ai-config.ts";
import { brandKeyForRaw } from "../lib/brand-normalize.ts";
import {
  resealAfterAuthenticityChange,
  resolveAppeal,
  restoreAssessmentAfterAppeal,
  withdrawAssessment,
} from "../lib/authenticity-appeal.ts";
import {
  coverageWarnings,
  prepareImport,
  validateBatchSize,
  type GoldenSetImportRow,
} from "../lib/golden-set-import.ts";
import {
  COMPOSITE_PROMPT_VERSION,
  invalidatePromptCache,
  PER_IMAGE_PROMPT_VERSION,
} from "../lib/ai-grading.ts";
import {
  autoPromoteListingPrompt,
  summarizeListingPromptPerformance,
} from "../lib/listing-acceptance.ts";
import { type ShadowRow, summarizeComparisons } from "../lib/grading-shadow.ts";
import { runGradingRegressionScan } from "../lib/grading-monitor.ts";
import { computeIrrReport, type ItemRatings } from "../lib/irr.ts";
import { requireFreshStepUp, requireStepUp } from "../lib/step-up.ts";
import { requiresSuperAdmin } from "../lib/grade-adjust-rules.ts";
import {
  clampScore,
  computeWeightedOverall,
  type FactorScores,
  scoreToGradeTier,
} from "../lib/human-review.ts";
import { applyGradeAdjustment } from "../lib/grade-adjustment.ts";
import { deleteCertImages, invalidateCertificate } from "../lib/cloudflare-purge.ts";
import {
  type CheckedUpdateClient,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";
import {
  defaultRegradeStore,
  finalizeGradeReview,
  regradeSubmission,
} from "../lib/grading-pipeline.ts";
import {
  minimizeReliabilityPhoto,
  minimizeReliabilityQueueRow,
  RELIABILITY_QUEUE_SELECT,
} from "../lib/reliability-privacy.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { REVIEW_CLAIM_TTL_SEC, reviewClaimVerdict } from "../lib/review-claim.ts";
import { failUngradedSubmission } from "../lib/stuck-submissions.ts";

// Admin grading-quality + self-improvement surface (US-070/US-073/US-132).
// Mounted at /api/admin/grading — inherits authMiddleware + adminAuthMiddleware
// from main.ts (/api/admin/*).
//
// Lets the team: inspect grade-vs-human accuracy (sliced by prompt version,
// factor, garment category, and the intentional-design-misread rate), review
// post-sale outcome feedback, manage prompt versions, and run the eval gate
// before activating a new prompt.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminGradingRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminGradingRoutes.use("*", requireScope("grading:review"));

// Thin wrapper over the shared writeAuditLog (US-269) for uniform actor_role /
// ip / user_agent capture. Threads the request Context through.
function auditLog(
  c: Context,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  return writeAuditLog(c, { action, targetType, targetId, details });
}

// US-547: listing_gen joins the grading stages so AutoLister listing prompts go
// through the same create → eval-gate → activate flow. runEval routes
// listing_gen to the listing eval (golden cases), not the grading eval.
const STAGES = ["per_image", "composite", "listing_gen"] as const;
type Stage = (typeof STAGES)[number];

// ── Accuracy ───────────────────────────────────────────────────────

// GET /accuracy?period=week  — aggregate accuracy metrics.
// US-1564 wire decision: WIRED — Accuracy tab of GradingAccuracyPanel (/admin/ai-models).
adminGradingRoutes.get("/accuracy", async (c) => {
  try {
    const period = c.req.query("period");
    const summary =
      period === "week"
        ? await computeWeeklyAccuracySummary()
        : await computeAccuracySummary();
    return c.json(summary);
  } catch (err) {
    return c.json(
      { error: "Failed to compute accuracy", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// GET /calibration — confidence reliability curve + recommended review
// threshold (US-331).
adminGradingRoutes.get("/calibration", async (c) => {
  try {
    return c.json(await computeConfidenceCalibration());
  } catch (err) {
    return c.json(
      { error: "Failed to compute calibration", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// GET /claim-signal — buyer-guarantee-claim-derived per-factor over-grade signal
// (US-1113). Approved "the grade was wrong" claims map their claimed_issues to
// the five grading factors; this is the aggregate the calibration panel renders.
adminGradingRoutes.get("/claim-signal", async (c) => {
  try {
    return c.json(await computeClaimAccuracySignal());
  } catch (err) {
    return c.json(
      {
        error: "Failed to compute claim signal",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// GET /accuracy/defects — per-defect-type & per-size accuracy + weight-table
// calibration recommendations (US-1036). ?period=week scopes the window.
// US-1564 wire decision: WIRED — Defects tab of GradingAccuracyPanel.
adminGradingRoutes.get("/accuracy/defects", async (c) => {
  try {
    const period = c.req.query("period");
    const start =
      period === "week"
        ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
    return c.json(await computeDefectAccuracyReport(start));
  } catch (err) {
    return c.json(
      {
        error: "Failed to compute defect accuracy",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// GET /accuracy/price-correlation — does a higher grade actually realize a
// higher price?
//
// US-2954: THIS USED TO BE REGISTERED AT /accuracy/outcomes, and so did the
// handler ~90 lines below. Hono serves the first match, so this one won and the
// other was dead code with a comment claiming it was wired.
//
// The two answer different questions and only one of them is what the Outcomes
// tab renders. GradingAccuracyPanel reads { categories, total_graded_sales,
// overall_dispute_rate } - post-sale dispute feedback per category, which is
// computeOutcomeFeedback() below. This endpoint returns a correlation report
// with window_days / scanned / scan_capped and no total_graded_sales at all, so
// the tab's `data.total_graded_sales === 0` guard read undefined, fell through,
// and called .map on an undefined categories array. The tab was not showing the
// wrong numbers; it was throwing.
//
// So the PATH goes back to the handler the panel was written against, and this
// one - which is the newer and more interesting analysis, and which nothing
// consumes yet - gets a name that says what it computes.
// (US-2280). Spearman rank correlation between the assigned grade and
// sale_price / comp_median, plus return and dispute rates per grade band.
//
// ?days=N bounds the window (default 180). Platform-wide by design — it sits in
// the /api/admin/* group behind adminAuthMiddleware, the same posture as
// /accuracy/defects above. Nothing per-seller is in the response: the fetch
// projects into OutcomeRow, which has no identifying field, and a source-scanned
// guard keeps it that way.
//
// The response reports a coefficient ONLY above the minimum sample and says so
// in words otherwise — "not enough data to look" and "no relationship found" are
// different answers and this endpoint never collapses them.
adminGradingRoutes.get("/accuracy/price-correlation", async (c) => {
  try {
    const rawDays = Number(c.req.query("days"));
    const days = Number.isFinite(rawDays) && rawDays > 0 && rawDays <= 3650
      ? Math.floor(rawDays)
      : 180;
    const sinceIso = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    const fetched = await fetchOutcomeRows(sinceIso);
    const report = correlateOutcomes(fetched.rows);
    return c.json({
      ...report,
      window_days: days,
      // Coverage, so a thin report is readable as thin rather than as a finding:
      // how many graded FlipDesk items the scan saw, how many of those had sold
      // at all, and whether the scan hit its cap.
      scanned: fetched.scanned,
      graded_with_sale: fetched.gradedWithSale,
      scan_capped: fetched.capped,
    });
  } catch (err) {
    return c.json(
      {
        error: "Failed to compute outcome correlation",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// POST /model-comparison — qualify a stronger grading model via the eval gate
// (US-1034). Runs the active golden cases under model_a and model_b and returns
// a grade-error comparison + promotion recommendation. EXPENSIVE: grades every
// eval case twice through the real vision model. Body: { prompt_version_id,
// model_a, model_b }. prompt_version_id should reference a default/empty-text
// version to evaluate current grading behavior under each model.
// US-1564 wire decision: WIRED — Tools tab (confirm-gated trigger; 7 covering tests
// in model-comparison_test.ts keep the contract stable).
adminGradingRoutes.post("/model-comparison", async (c) => {
  const userId = c.get("userId") ?? null;
  try {
    const body = await c.req.json().catch(() => ({}));
    const promptVersionId = String(body.prompt_version_id ?? "");
    const modelA = String(body.model_a ?? "");
    const modelB = String(body.model_b ?? "");
    if (!promptVersionId || !modelA || !modelB) {
      return c.json(
        { error: "prompt_version_id, model_a and model_b are required" },
        400,
      );
    }
    if (!isAllowedGradingModel(modelA) || !isAllowedGradingModel(modelB)) {
      return c.json(
        { error: "model_a and model_b must be on the grading allowlist" },
        400,
      );
    }
    const [runA, runB] = await Promise.all([
      runEval(promptVersionId, userId, modelA),
      runEval(promptVersionId, userId, modelB),
    ]);
    const toEvalRun = (r: typeof runA): ModelEvalRun => ({
      model: r.model,
      mean_absolute_error: r.mean_absolute_error,
      agreement_rate: r.agreement_rate,
      cases_total: r.cases_total,
      cases_passed: r.cases_passed,
      per_tag: r.per_tag,
      cost_per_grade_usd: null,
    });
    return c.json({
      run_a: runA,
      run_b: runB,
      comparison: compareModelEvals(toEvalRun(runA), toEvalRun(runB)),
    });
  } catch (err) {
    return c.json(
      {
        error: "Failed to run model comparison",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// GET /accuracy/outcomes — post-sale feedback (dispute rate + grade↔price) per category.
// US-1564 wire decision: WIRED — Outcomes tab of GradingAccuracyPanel.
adminGradingRoutes.get("/accuracy/outcomes", async (c) => {
  try {
    return c.json(await computeOutcomeFeedback());
  } catch (err) {
    return c.json(
      { error: "Failed to compute outcome feedback", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// GET /accuracy/snad-observations — US-2937. Grades the market disagreed with.
//
// A human review says "the model called it 8.5 and a reviewer said 8.0". These
// rows say something rarer: a real buyer paid, held the garment, and said the
// condition was not what we published. That is worth a reviewer's time, and
// until now it landed in the seller's post-sale page and stopped there.
//
// A SIGNAL, NOT A VERDICT. Buyers file "not as described" for wrong sizes,
// screen colour, and because it is the reason that gets free return postage. So
// these rows are excluded from every public accuracy figure until a human has
// looked — this endpoint is where that looking happens.
//
// Operator surface: the admin middleware above is the tenant boundary, and
// nothing here is scoped to one seller by design.
adminGradingRoutes.get("/accuracy/snad-observations", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
  try {
    const { data, error } = await supabaseAdmin
      .from("grade_outcomes")
      .select("id, grade_report_id, inventory_item_id, sale_id, created_at")
      .eq("source", SNAD_OUTCOME_SOURCE)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Array<{
      id: string;
      grade_report_id: string;
      inventory_item_id: string | null;
      sale_id: string | null;
      created_at: string;
    }>;
    if (rows.length === 0) return c.json({ observations: [], total: 0 });

    // The grade the market disagreed with, plus whether a human has already
    // been through it. A row with a review is not new work.
    const reportIds = [...new Set(rows.map((r) => r.grade_report_id))];
    const { data: reports } = await supabaseAdmin
      .from("grade_reports")
      .select("id, overall_score, grade_tier, confidence_score, needs_human_review, submission_id")
      .in("id", reportIds);
    const reportById = new Map(
      ((reports ?? []) as unknown as Array<{
        id: string;
        overall_score: number | string | null;
        grade_tier: string | null;
        confidence_score: number | string | null;
        needs_human_review: boolean | null;
        submission_id: string | null;
      }>).map((r) => [r.id, r]),
    );
    const { data: reviewed } = await supabaseAdmin
      .from("human_reviews")
      .select("grade_report_id")
      .in("grade_report_id", reportIds);
    const hasReview = new Set(
      ((reviewed ?? []) as unknown as Array<{ grade_report_id: string | null }>)
        .map((r) => r.grade_report_id)
        .filter((id): id is string => !!id),
    );

    return c.json({
      total: rows.length,
      observations: rows.map((r) => {
        const report = reportById.get(r.grade_report_id);
        const score = report?.overall_score == null ? null : Number(report.overall_score);
        const confidence = report?.confidence_score == null
          ? null
          : Number(report.confidence_score);
        return {
          id: r.id,
          grade_report_id: r.grade_report_id,
          inventory_item_id: r.inventory_item_id,
          sale_id: r.sale_id,
          observed_at: r.created_at,
          overall_score: score != null && Number.isFinite(score) ? score : null,
          grade_tier: report?.grade_tier ?? null,
          confidence_score: confidence != null && Number.isFinite(confidence)
            ? confidence
            : null,
          needs_human_review: report?.needs_human_review ?? null,
          // The batch a reviewer wants is the UNREVIEWED half.
          already_reviewed: hasReview.has(r.grade_report_id),
        };
      }),
    });
  } catch (err) {
    return c.json(
      {
        error: "Failed to load SNAD observations",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// GET /training-export — JSONL of human-reviewed grades (image refs + AI output
// + human-corrected ground truth + category/model/prompt version) for offline
// analysis / few-shot exemplar curation / fine-tuning (US-1068). Consent + PII
// controls: ?consent_only=false includes non-opted-in rows (a fully-internal
// export — audited); ?include_notes=true keeps reviewer free text (default
// redacted). Returns NDJSON so it downloads cleanly.
// US-1564 wire decision: WIRED — Tools tab download button (NDJSON; consent toggle).
adminGradingRoutes.get("/training-export", async (c) => {
  try {
    const consentOnly = c.req.query("consent_only") !== "false";
    const includeNotes = c.req.query("include_notes") === "true";
    const jsonl = await exportTrainingDataset({ consentOnly, includeNotes });
    // Exporting beyond consented data, or with raw reviewer notes, is a
    // privacy-sensitive choice — record who did it and how.
    if (!consentOnly || includeNotes) {
      await auditLog(c, "export_training_dataset", "grading_training_export", null, {
        consent_only: consentOnly,
        include_notes: includeNotes,
      });
    }
    return c.body(jsonl, 200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="grade-training-${new Date().toISOString().slice(0, 10)}.jsonl"`,
    });
  } catch (err) {
    return c.json(
      { error: "Failed to export training data", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// ── Prompt versions ──────────────────────────────────────────────────

// GET /prompts — list all prompt versions (newest first).
adminGradingRoutes.get("/prompts", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return failSafe(c, 500, "Couldn't load prompts.", error, "admin.grading.prompts.list");
  return c.json({ prompts: data ?? [] });
});

// POST /prompts — create a candidate prompt version (inactive until eval-gated).
// Body: { version_name, prompt_text, stage, garment_scope?, notes? }
adminGradingRoutes.post("/prompts", async (c) => {
  let body: {
    version_name?: string;
    prompt_text?: string;
    stage?: string;
    garment_scope?: string | null;
    notes?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const versionName = (body.version_name ?? "").trim();
  const promptText = body.prompt_text ?? "";
  const stage = body.stage as Stage | undefined;

  if (!versionName) return c.json({ error: "version_name is required" }, 400);
  if (!promptText.trim()) return c.json({ error: "prompt_text is required" }, 400);
  if (!stage || !STAGES.includes(stage)) {
    return c.json({ error: `stage must be one of: ${STAGES.join(", ")}` }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .insert({
      version_name: versionName,
      prompt_text: promptText,
      stage,
      garment_scope: body.garment_scope?.trim() || null,
      notes: body.notes?.trim() || null,
      is_active: false,
      eval_passed: null,
    })
    .select("*")
    .single();
  if (error) return failSafe(c, 400, "Couldn't save the prompt.", error, "admin.grading.prompts.create");

  await auditLog(c, "create_prompt_version", "ai_prompt_version", data.id, {
    version_name: versionName,
    stage,
    garment_scope: body.garment_scope ?? null,
  });
  return c.json({ prompt: data }, 201);
});

// PATCH /prompts/:id — edit a CANDIDATE prompt's name, text, scope or notes.
//
// US-2348: the admin SPA used to do this with a direct supabase-js UPDATE
// against RLS, which any is_admin() caller can do — including one whose
// grading:review scope was deliberately revoked. That routed around this
// router's scope guard, the step-up on activate, and the whole
// shadow → eval → canary lifecycle, and it let someone rewrite the prompt_text
// of the LIVE prompt, biasing every grade the platform issues.
//
// So this route exists to be the ONLY way, and it enforces what the direct
// write could not: an ACTIVE prompt's text is immutable. Hot-editing a live
// prompt is exactly what the versioning lifecycle exists to prevent — a new
// version goes through shadow-compare and the eval gate before it can serve
// traffic. Deactivate it, or create a new version.
adminGradingRoutes.patch("/prompts/:id", async (c) => {
  const id = c.req.param("id");
  let body: {
    version_name?: string;
    prompt_text?: string;
    garment_scope?: string | null;
    notes?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { data: existing, error: readErr } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, is_active, prompt_text")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return failSafe(c, 500, "Couldn't load the prompt.", readErr, "admin.grading.prompts.update");
  }
  if (!existing) return c.json({ error: "Prompt version not found" }, 404);

  const patch: Record<string, unknown> = {};
  if (body.version_name !== undefined) {
    const name = body.version_name.trim();
    if (!name) return c.json({ error: "version_name cannot be blank" }, 400);
    patch.version_name = name;
  }
  if (body.prompt_text !== undefined) {
    if (!body.prompt_text.trim()) {
      return c.json({ error: "prompt_text cannot be blank" }, 400);
    }
    if (existing.is_active && body.prompt_text !== existing.prompt_text) {
      return c.json({
        error:
          "This version is ACTIVE — its prompt text drives live grading and cannot be edited in place. " +
          "Deactivate it first, or create a new version and take it through the eval gate.",
      }, 409);
    }
    patch.prompt_text = body.prompt_text;
  }
  if (body.garment_scope !== undefined) {
    patch.garment_scope = body.garment_scope?.trim() || null;
  }
  if (body.notes !== undefined) patch.notes = body.notes?.trim() || null;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) {
    return failSafe(c, 400, "Couldn't update the prompt.", error, "admin.grading.prompts.update");
  }
  await auditLog(c, "update_prompt_version", "ai_prompt_version", id, {
    fields: Object.keys(patch),
  });
  return c.json({ prompt: data });
});

// DELETE /prompts/:id — remove a candidate version.
//
// US-2348: same story as PATCH. An ACTIVE version is refused: deleting the row
// that is serving live traffic silently reverts grading to the code default
// with nothing in the change log explaining why the numbers moved.
adminGradingRoutes.delete("/prompts/:id", async (c) => {
  const id = c.req.param("id");
  const { data: existing, error: readErr } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, is_active, version_name")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return failSafe(c, 500, "Couldn't load the prompt.", readErr, "admin.grading.prompts.delete");
  }
  if (!existing) return c.json({ error: "Prompt version not found" }, 404);
  if (existing.is_active) {
    return c.json({
      error:
        "This version is ACTIVE and is serving live grading. Deactivate it first — " +
        "deleting it would silently revert to the code default.",
    }, 409);
  }

  const { error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .delete()
    .eq("id", id);
  if (error) {
    return failSafe(c, 400, "Couldn't delete the prompt.", error, "admin.grading.prompts.delete");
  }
  await auditLog(c, "delete_prompt_version", "ai_prompt_version", id, {
    version_name: existing.version_name,
  });
  return c.json({ ok: true });
});

// POST /prompts/:id/eval — run the eval gate against the golden set.
adminGradingRoutes.post("/prompts/:id/eval", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  try {
    const result = await runEval(id, userId);
    await auditLog(c, "run_prompt_eval", "ai_prompt_version", id, {
      passed: result.passed,
      mae: result.mean_absolute_error,
      agreement_rate: result.agreement_rate,
      cases_total: result.cases_total,
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: "Eval run failed", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
});

// GET /sample-submissions — recently-graded submissions for the dry-run picker
// (US-590). Every row is known to have images + garment info (it produced a
// grade report), so it can be re-graded by the dry-run. Returns the live grade
// for context. Platform-admin function over the whole corpus (no tenant scope).
adminGradingRoutes.get("/sample-submissions", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 100);
  const { data: reports, error } = await supabaseAdmin
    .from("grade_reports")
    .select("submission_id, overall_score, grade_tier, created_at")
    .order("created_at", { ascending: false })
    .limit(limit * 3); // over-fetch: dedupe to one report per submission below
  if (error) return failSafe(c, 500, "Couldn't load sample submissions.", error, "admin.grading.samples.list");

  // Keep the newest report per submission (the query is newest-first).
  const seen = new Map<string, { overall_score: number; grade_tier: string }>();
  for (const r of (reports ?? []) as Array<{
    submission_id: string;
    overall_score: number;
    grade_tier: string;
  }>) {
    if (!seen.has(r.submission_id)) {
      seen.set(r.submission_id, { overall_score: r.overall_score, grade_tier: r.grade_tier });
    }
    if (seen.size >= limit) break;
  }
  const ids = [...seen.keys()];
  if (ids.length === 0) return c.json({ submissions: [] });

  const { data: subs, error: subErr } = await supabaseAdmin
    .from("submissions")
    .select("id, title, garment_type, garment_category")
    .in("id", ids);
  if (subErr) return failSafe(c, 500, "Couldn't load the submission.", subErr, "admin.grading.samples.sub");

  const byId = new Map(
    ((subs ?? []) as Array<{
      id: string;
      title: string;
      garment_type: string;
      garment_category: string;
    }>).map((s) => [s.id, s]),
  );
  const submissions = ids
    .map((id) => {
      const s = byId.get(id);
      if (!s) return null;
      const live = seen.get(id)!;
      return {
        id,
        title: s.title,
        garment_type: s.garment_type,
        garment_category: s.garment_category,
        current_score: live.overall_score,
        current_tier: live.grade_tier,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return c.json({ submissions });
});

// POST /prompts/:id/dry-run — grade ONE chosen submission with the candidate
// prompt AND the active prompt, returning both for side-by-side comparison
// (US-590). Read-only spot-check (no persistence/gate); replaces the old fake
// setTimeout "test". Body: { submission_id }.
adminGradingRoutes.post("/prompts/:id/dry-run", async (c) => {
  const id = c.req.param("id");
  let body: { submission_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const submissionId = (body.submission_id ?? "").trim();
  if (!submissionId) return c.json({ error: "submission_id is required" }, 400);

  try {
    const result = await runPromptDryRun(id, submissionId);
    await auditLog(c, "dry_run_prompt", "ai_prompt_version", id, {
      submission_id: submissionId,
      stage: result.stage,
      candidate_score: result.candidate.overall_score,
      active_score: result.active.overall_score,
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: "Dry run failed", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
});

// POST /prompts/:id/activate — promote to active. Gated: requires a passing eval.
adminGradingRoutes.post("/prompts/:id/activate", async (c) => {
  // US-270: activating a prompt version changes live grading — require step-up.
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const id = c.req.param("id");
  const result = await activatePromptVersion(id);
  if (!result.ok) return c.json({ error: result.reason }, 422);
  await auditLog(c, "activate_prompt_version", "ai_prompt_version", id, {});
  return c.json({ ok: true });
});

// POST /prompts/:id/deactivate — turn off an active prompt (reverts to code default).
adminGradingRoutes.post("/prompts/:id/deactivate", async (c) => {
  // US-2353 AC3: deactivate is as dangerous as activate and had no gate.
  // Turning off the active prompt reverts every grade to the code default —
  // the same "changes live grading" the activate step-up exists for, reached
  // from the other direction. An asymmetric pair is a gap with a shape.
  {
    const stepUp = requireFreshStepUp(c);
    if (stepUp) return stepUp;
  }
  const id = c.req.param("id");
  const { error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .update({ is_active: false })
    .eq("id", id);
  if (error) return failSafe(c, 400, "Couldn't deactivate the prompt.", error, "admin.grading.prompts.deactivate");
  // US-571: drop the now-removed override from every replica's prompt cache.
  await invalidatePromptCache();
  await auditLog(c, "deactivate_prompt_version", "ai_prompt_version", id, {});
  return c.json({ ok: true });
});

// ── US-2130: authenticity eval gate ─────────────────────────────────────────
//
// The authenticity pass ships to real users (paid add-on, buyer check, and an
// unauthenticated public endpoint) while its golden-set gate has never run.
// These two routes make it runnable and inspectable. They deliberately do NOT
// introduce an authenticity prompt-version lifecycle — authenticity prompts are
// code constants, and inventing an activation flow to satisfy a checkbox is how
// authenticity-eval.ts became dead code in the first place (see the reasoning in
// authenticity-gate-guard_test.ts). When that lifecycle is genuinely needed, it
// must call assertAuthenticityPromptActivatable, which refuses by default.

// ── US-2145: resolve a seller's authenticity appeal ─────────────────────────

// GET /authenticity/appeals — the open queue, oldest first.
adminGradingRoutes.get("/authenticity/appeals", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("disputes")
    .select("id, grade_report_id, user_id, reason, status, created_at")
    .eq("kind", "authenticity")
    .in("status", ["open", "under_review"])
    // Oldest first: while an appeal is open the item is effectively unsellable
    // at its stated grade, so waiting time is itself a penalty.
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    return failSafe(c, 400, "Couldn't load appeals.", error, "admin.grading.authenticity.appeals");
  }
  return c.json({ appeals: data ?? [] });
});

// POST /authenticity/appeals/:id/resolve — uphold or reject.
adminGradingRoutes.post("/authenticity/appeals/:id/resolve", async (c) => {
  // Upholding withdraws a published verdict and reseals a certificate; rejecting
  // republishes one. Both are consequential enough for step-up.
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const outcome = body.outcome === "upheld" || body.outcome === "rejected" ? body.outcome : null;
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : "";
  if (!outcome) return c.json({ error: "outcome must be 'upheld' or 'rejected'." }, 400);
  if (!notes) return c.json({ error: "Resolution notes are required." }, 400);

  const { data: row } = await supabaseAdmin
    .from("disputes")
    .select("id, grade_report_id, status, kind")
    .eq("id", id)
    .maybeSingle();
  const appeal = row as { grade_report_id: string; status: string; kind: string } | null;
  if (!appeal || appeal.kind !== "authenticity") {
    return c.json({ error: "Authenticity appeal not found." }, 404);
  }
  if (appeal.status === "resolved" || appeal.status === "rejected") {
    return c.json({ error: "This appeal is already resolved." }, 409);
  }

  const { data: gr } = await supabaseAdmin
    .from("grade_reports")
    .select("authenticity_assessment, certificate_id")
    .eq("id", appeal.grade_report_id)
    .maybeSingle();
  const stored = (gr as { authenticity_assessment: Record<string, unknown> | null } | null)
    ?.authenticity_assessment ?? null;

  const plan = resolveAppeal(outcome);
  // Upheld → withdraw permanently. Rejected → restore exactly what was hidden;
  // the reviewer found the appeal unpersuasive, which is not a new finding about
  // the item, so nothing about the assessment should change.
  const next = plan.withdraw
    ? withdrawAssessment(stored, notes, new Date().toISOString())
    : restoreAssessmentAfterAppeal(stored);

  const update: Record<string, unknown> = { authenticity_assessment: next };
  const resealed = await resealAfterAuthenticityChange(
    appeal.grade_report_id,
    next as { verdict?: string | null; verdict_confidence?: number | null } | null,
  );
  if (resealed) Object.assign(update, resealed);

  const { error: uErr } = await supabaseAdmin
    .from("grade_reports")
    .update(update)
    .eq("id", appeal.grade_report_id);
  if (uErr) {
    return failSafe(c, 400, "Couldn't apply the resolution.", uErr, "admin.grading.authenticity.appeals.resolve");
  }

  await supabaseAdmin
    .from("disputes")
    .update({ status: outcome === "upheld" ? "resolved" : "rejected", resolution_notes: notes })
    .eq("id", id);

  // An upheld appeal is a CONFIRMED FALSE POSITIVE — the most valuable label the
  // system can obtain, and the error direction nothing else measures. Record it
  // through the same review path so it feeds accuracy and can be promoted.
  let reviewRecorded = false;
  if (plan.reviewerVerdict) {
    const { error: rErr } = await supabaseAdmin
      .from("authenticity_review_outcomes")
      .upsert({
        grade_report_id: appeal.grade_report_id,
        reviewer_id: userId,
        model_verdict: (stored?.appeal_hidden_original as Record<string, unknown> | undefined)
          ?.verdict ?? stored?.verdict ?? null,
        model_confidence: null,
        model_prompt_version: (stored?.prompt_version as string | undefined) ?? null,
        reviewer_verdict: plan.reviewerVerdict,
        tells_relied_on: [],
        reasoning: notes,
        reviewed_at: new Date().toISOString(),
      }, { onConflict: "grade_report_id" });
    reviewRecorded = !rErr;
  }

  await auditLog(c, "resolve_authenticity_appeal", "dispute", id, {
    outcome,
    grade_report_id: appeal.grade_report_id,
    withdrew_verdict: plan.withdraw,
    review_recorded: reviewRecorded,
  });

  return c.json({ ok: true, outcome, withdrew_verdict: plan.withdraw, review_recorded: reviewRecorded });
});

// ── US-2146: authenticity accuracy + drift ──────────────────────────────────
//
// The eval gate certifies a prompt version once. This is what says it is STILL
// true — and it reports the two error directions separately, because a single
// agreement rate stays flat while a version stops missing fakes and starts
// flagging genuine items.

// How many review outcomes any one authenticity aggregate reads.
//
// A cap with no ORDER BY is not a cap, it is an arbitrary sample: Postgres may
// return any 5000 rows, so "recent vs baseline" would be computed over a set
// that changes between calls. Every query below therefore orders before
// limiting, and says so when the cap actually bites — a silently truncated
// aggregate reads as complete, which is how the certificate sitemap quietly
// stopped at its first page.
const AUTHENTICITY_AGGREGATE_CAP = 5000;

function warnIfCapped(rows: number, what: string): void {
  if (rows >= AUTHENTICITY_AGGREGATE_CAP) {
    console.warn(
      `[authenticity] ${what} hit the ${AUTHENTICITY_AGGREGATE_CAP}-row cap — ` +
        `older outcomes are excluded and this aggregate is partial.`,
    );
  }
}

// Shared loader: the accuracy route and the post-review drift check must read
// the same shape, or the number an operator sees and the number that alerts
// could disagree.
async function loadAuthenticityObservations(): Promise<AuthenticityObservation[]> {
  const { data, error } = await supabaseAdmin
    .from("authenticity_review_outcomes")
    .select(
      "model_verdict, model_prompt_version, reviewer_verdict, reviewed_at, " +
        "grade_reports!inner(submissions!inner(brand))",
    )
    // Newest first: if the cap bites, the RECENT window — the one drift is
    // judged on — must be the part we keep intact.
    .order("reviewed_at", { ascending: false })
    .limit(AUTHENTICITY_AGGREGATE_CAP);
  if (error) throw new Error(error.message);
  warnIfCapped((data ?? []).length, "accuracy/drift");

  type Row = {
    model_verdict: string | null;
    model_prompt_version: string | null;
    reviewer_verdict: string;
    reviewed_at: string;
    grade_reports?: { submissions?: { brand?: string | null } | null } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => {
    const brand = r.grade_reports?.submissions?.brand?.trim();
    return {
      prompt_version: r.model_prompt_version,
      brand_key: brandKeyForRaw(brand),
      model_verdict: r.model_verdict,
      reviewer_verdict: r.reviewer_verdict,
      reviewed_at: r.reviewed_at,
    };
  });
}

// GET /authenticity/accuracy?since=ISO — accuracy by version and brand, + drift.
adminGradingRoutes.get("/authenticity/accuracy", async (c) => {
  let observations: AuthenticityObservation[];
  try {
    observations = await loadAuthenticityObservations();
  } catch (err) {
    return failSafe(
      c,
      400,
      "Couldn't load review outcomes.",
      err,
      "admin.grading.authenticity.accuracy",
    );
  }

  const report = computeAuthenticityAccuracy(observations);
  // Caller-supplied cutoff so an operator can ask "since we changed the model",
  // which is the question drift detection actually gets used for.
  const since = c.req.query("since");
  let drift = null;
  if (since) {
    const { recent, baseline } = splitByCutoff(observations, since);
    drift = detectAuthenticityDrift(recent, baseline);
  }

  return c.json({ ...report, drift, observations_considered: observations.length });
});

// ── US-2148: per-seller authenticity signal ─────────────────────────────────
//
// Operator visibility only. It does NOT write to reputation_events — that log is
// the buyer Trust Score (00417) and seller conduct is a different subject; see
// the correction recorded on US-2148.

// GET /authenticity/sellers — sellers ranked by confirmed findings + clustering.
adminGradingRoutes.get("/authenticity/sellers", async (c) => {
  // Assessments joined to their submission's owner. authenticity_assessment is
  // the BRAND add-on column (00172), not image_authenticity (photo-edit, 00061).
  const { data, error } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "created_at, authenticity_assessment, submissions!inner(user_id), " +
        "authenticity_review_outcomes(reviewer_verdict)",
    )
    .not("authenticity_assessment", "is", null)
    // Newest first so a capped read keeps the recent activity a clustering
    // check is actually about.
    .order("created_at", { ascending: false })
    .limit(AUTHENTICITY_AGGREGATE_CAP);
  if (error) {
    return failSafe(c, 400, "Couldn't load authenticity outcomes.", error, "admin.grading.authenticity.sellers");
  }

  type Row = {
    created_at: string;
    authenticity_assessment: { verdict?: string | null } | null;
    submissions?: { user_id?: string | null } | null;
    authenticity_review_outcomes?: { reviewer_verdict: string }[] | null;
  };
  // `as unknown as` — the typed client resolves an embedded-relation select to
  // GenericStringError[], the same shape mismatch content-public works around.
  warnIfCapped((data ?? []).length, "seller signal");
  const records: SellerAuthenticityRecord[] = ((data ?? []) as unknown as Row[])
    .map((r) => {
      const sellerId = r.submissions?.user_id;
      if (!sellerId) return null;
      return {
        seller_id: sellerId,
        occurred_at: r.created_at,
        model_verdict: r.authenticity_assessment?.verdict ?? null,
        // One outcome per report (unique index), so [0] is the resolution.
        reviewer_verdict: r.authenticity_review_outcomes?.[0]?.reviewer_verdict ?? null,
      };
    })
    .filter((r): r is SellerAuthenticityRecord => r !== null);

  const signals = summarizeSellerAuthenticity(records);
  return c.json({
    sellers: signals,
    clustered: signals.filter((s) => s.clustered).length,
    considered: records.length,
  });
});

// ── US-2147: reviewer tells → brand-knowledge candidates ────────────────────
//
// Read-only on purpose. This surfaces what reviewers keep relying on, ranked;
// an operator then writes the actual tell through the brand-knowledge curation
// surface, where validateTellsForWrite applies. Nothing here writes to the KB —
// frequency is evidence, not authority, and a tell entering the KB changes every
// future verdict for that brand.

// GET /authenticity/tell-candidates — ranked candidates from resolved reviews.
adminGradingRoutes.get("/authenticity/tell-candidates", async (c) => {
  const brandKey = c.req.query("brand_key")?.trim();

  // Join the outcome's tells to the brand behind its grade report. brand_key is
  // derived the same way the golden-set promotion derives it, so a candidate and
  // a promoted case agree on which brand they belong to.
  // Previously this limited ONLY when a brand filter was supplied — backwards,
  // since the unfiltered read is the larger one. Always ordered, always capped.
  const { data, error } = await supabaseAdmin
    .from("authenticity_review_outcomes")
    .select("reviewer_verdict, tells_relied_on, grade_reports!inner(submissions!inner(brand))")
    .order("reviewed_at", { ascending: false })
    .limit(AUTHENTICITY_AGGREGATE_CAP);
  if (error) {
    return failSafe(c, 400, "Couldn't load review outcomes.", error, "admin.grading.authenticity.tell_candidates");
  }

  type Row = {
    reviewer_verdict: string;
    tells_relied_on: string[] | null;
    grade_reports?: { submissions?: { brand?: string | null } | null } | null;
  };
  warnIfCapped((data ?? []).length, "tell candidates");
  const observations: ReviewTellObservation[] = ((data ?? []) as Row[])
    .map((r) => {
      const brand = r.grade_reports?.submissions?.brand?.trim();
      if (!brand) return null;
      // Drop rather than bucket under "": an unresolvable brand cannot join
      // brand_knowledge, so a candidate for it could never be promoted anyway.
      const key = brandKeyForRaw(brand);
      if (!key) return null;
      return {
        brand_key: key,
        reviewer_verdict: r.reviewer_verdict,
        tells_relied_on: r.tells_relied_on ?? [],
      };
    })
    .filter((o): o is ReviewTellObservation => o !== null)
    .filter((o) => !brandKey || o.brand_key === brandKey);

  const ranked = rankTellCandidates(observations);
  return c.json({
    // Split rather than filtered: an operator should see what is NOT yet
    // promotable too, since "three more reviews and this qualifies" is useful
    // signal and silently hiding it looks like there is no data.
    promotable: ranked.filter(isPromotable).map((cand) => ({
      ...cand,
      draft: draftTellFromCandidate(cand),
    })),
    emerging: ranked.filter((cand) => !isPromotable(cand)),
    observations_considered: observations.length,
  });
});

// ── US-2140: authenticity review outcomes → golden set ──────────────────────
//
// authenticityNeedsReview routes an uncertain or contradicted assessment to a
// human; these routes let that human resolve it, and then turn the resolution
// into an eval case. That promotion is the only source of golden-set cases that
// scales — everything else is hand-sourced.

// POST /authenticity/reviews — record what a reviewer concluded.
adminGradingRoutes.post("/authenticity/reviews", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const invalid = validateReviewOutcome(body);
  if (invalid) return c.json({ error: invalid }, 400);

  const reportId = String(body.grade_report_id);

  // Snapshot what the pass actually said, so a later re-assessment cannot
  // rewrite the record of what this reviewer was looking at.
  // NOTE: authenticity_assessment (00172, the BRAND authenticity add-on), NOT
  // image_authenticity (00061, photo-edit detection). They are different systems
  // and the prompt says so explicitly; snapshotting the wrong one would record a
  // photo-manipulation score as if it were the counterfeit verdict.
  const { data: reportRow } = await supabaseAdmin
    .from("grade_reports")
    .select("id, authenticity_assessment")
    .eq("id", reportId)
    .maybeSingle();
  if (!reportRow) return c.json({ error: "Grade report not found." }, 404);
  const assessment =
    (reportRow as { authenticity_assessment?: Record<string, unknown> | null })
      .authenticity_assessment ?? null;

  const { data, error } = await supabaseAdmin
    .from("authenticity_review_outcomes")
    .upsert({
      grade_report_id: reportId,
      human_review_id: typeof body.human_review_id === "string" ? body.human_review_id : null,
      reviewer_id: userId,
      model_verdict: (assessment?.verdict as string | undefined) ?? null,
      model_confidence: (assessment?.verdict_confidence as number | undefined) ?? null,
      model_prompt_version: (assessment?.prompt_version as string | undefined) ?? null,
      reviewer_verdict: body.reviewer_verdict,
      tells_relied_on: Array.isArray(body.tells_relied_on) ? body.tells_relied_on.map(String) : [],
      reasoning: typeof body.reasoning === "string" ? body.reasoning : null,
      reviewed_at: new Date().toISOString(),
    }, { onConflict: "grade_report_id" })
    .select("id")
    .single();
  if (error) {
    return failSafe(c, 400, "Couldn't record the review outcome.", error, "admin.grading.authenticity.reviews.create");
  }

  const modelVerdict = (assessment?.verdict as AuthenticityVerdict | undefined) ?? null;
  const reviewerVerdict = body.reviewer_verdict as ReviewerVerdict;
  await auditLog(c, "record_authenticity_review", "authenticity_review_outcome", (data as { id: string }).id, {
    grade_report_id: reportId,
    reviewer_verdict: reviewerVerdict,
    model_verdict: modelVerdict,
    overrode_model: overrodeModel(modelVerdict, reviewerVerdict),
    // Called out explicitly in the audit trail: this is the error class the eval
    // gate fails outright on, and the one where a buyer was actively misled.
    // (drift check fires below — a new review is exactly when drift can change)
    dangerous_override: isDangerousOverride(modelVerdict, reviewerVerdict),
  });

  // US-2146: a new review is the only thing that can move the error rates, so
  // this is exactly when drift can change. Fired here rather than from a cron —
  // the cron fleet is a manual per-environment install, and a check nobody
  // remembers to enable protects nothing. Best-effort; never fails the write.
  void checkAuthenticityDrift(
    () => loadAuthenticityObservations(),
    // 30-day recent window against everything before it.
    new Date(Date.now() - 30 * 86_400_000).toISOString(),
    (name, value, tags) => recordMetric(name, value, tags),
    (message) => console.warn(message),
  );

  return c.json({ id: (data as { id: string }).id }, 201);
});

// POST /authenticity/reviews/:id/promote — turn a resolved review into an eval
// case, carrying the submission's photos across.
adminGradingRoutes.post("/authenticity/reviews/:id/promote", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const { data: row } = await supabaseAdmin
    .from("authenticity_review_outcomes")
    .select("id, grade_report_id, reviewer_verdict, reasoning, golden_case_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) return c.json({ error: "Review outcome not found." }, 404);
  const outcome = row as {
    id: string;
    grade_report_id: string;
    reviewer_verdict: ReviewerVerdict;
    reasoning: string | null;
    golden_case_id: string | null;
  };

  // Resolve the submission behind the report, and the photos the eval replays.
  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select("submission_id")
    .eq("id", outcome.grade_report_id)
    .maybeSingle();
  const submissionId = (report as { submission_id?: string } | null)?.submission_id;
  if (!submissionId) return c.json({ error: "Grade report has no submission." }, 422);

  const { data: sub } = await supabaseAdmin
    .from("submissions")
    .select("brand, garment_type")
    .eq("id", submissionId)
    .maybeSingle();
  const { data: imgs } = await supabaseAdmin
    .from("submission_images")
    .select("image_type, storage_path")
    .eq("submission_id", submissionId);

  const images = ((imgs ?? []) as { image_type: string; storage_path: string }[]).map((i) => ({
    image_type: i.image_type,
    storage_path: i.storage_path,
  }));

  const check = canPromoteToGoldenSet(outcome, images.length, Boolean(outcome.golden_case_id));
  if (!check.ok) return c.json({ error: check.reason }, 422);

  const submission = (sub ?? {}) as { brand?: string | null; garment_type?: string | null };
  const brand = submission.brand?.trim() || null;
  // Alias-resolved, so a case promoted from a seller writing "YSL" keys to the
  // same brand_knowledge row as one written "Yves Saint Laurent". Without this
  // the golden set silently splits one brand across its spellings, and per-brand
  // coverage — which is what blocks activation — reads as thinner than it is.
  const promotedBrandKey = brandKeyForRaw(brand);
  if (!brand || !promotedBrandKey) {
    // brand_key joins brand_knowledge; a case with no brand cannot be scored
    // per-brand, and per-brand regression is what blocks activation.
    return c.json({ error: "The submission has no brand, so the case has no brand_key to score against." }, 422);
  }

  const { data: created, error: insErr } = await supabaseAdmin
    .from("authenticity_eval_cases")
    .insert({
      label: `Review-promoted: ${brand} (${outcome.reviewer_verdict})`,
      brand_key: promotedBrandKey,
      brand,
      garment_type: submission.garment_type ?? null,
      images,
      expected_label: outcome.reviewer_verdict,
      tags: ["review_promoted"],
      notes: outcome.reasoning,
      // Provenance: this label came from a named reviewer resolving a real
      // review, which is stronger than a hand-entered case with no source.
      source_url: `internal:authenticity_review_outcome/${outcome.id}`,
      created_by: userId,
    })
    .select("id")
    .single();
  if (insErr) {
    return failSafe(c, 400, "Couldn't create the golden-set case.", insErr, "admin.grading.authenticity.reviews.promote");
  }

  const caseId = (created as { id: string }).id;
  const { error: linkErr } = await supabaseAdmin
    .from("authenticity_review_outcomes")
    .update({ golden_case_id: caseId })
    .eq("id", outcome.id)
    // Guard the double-promote race: if another request linked this review
    // first, this update matches nothing and we surface it rather than leaving
    // two cases behind one review.
    .is("golden_case_id", null);
  if (linkErr) {
    return failSafe(c, 400, "Created the case but couldn't link it.", linkErr, "admin.grading.authenticity.reviews.link");
  }

  await auditLog(c, "promote_authenticity_review", "authenticity_eval_case", caseId, {
    review_outcome_id: outcome.id,
    expected_label: outcome.reviewer_verdict,
    image_count: images.length,
  });
  return c.json({ golden_case_id: caseId }, 201);
});

// ── US-2131: golden-set curation ────────────────────────────────────────────
//
// The gate is worthless without ground truth, and ground truth cannot be
// generated — it needs an expert to label real authentic-vs-counterfeit items.
// These routes are the surface that lets that happen. The table (00405) already
// carries every column required, including source_url for the PROVENANCE of a
// label, so no migration is involved.
//
// There is deliberately NO delete route. Per the grading-engine contract a
// shrinking golden set is a red flag, and deleting the cases a prompt fails is
// the easiest way to fake a passing gate. Cases are RETIRED (is_active=false),
// which preserves the record and is audited.

// US-2138: bound the read. Same reason as every other capped read here — a
// wide window must not pull an unbounded scan into one response.
const DECODER_CONTRADICTION_CAP = 200;

// GET /authenticity/decoder-contradictions — US-2138 AC7.
//
// Verdicts a DETERMINISTIC decoder capped, most recent first. Without this a
// capped verdict is unexplainable: an operator sees a low confidence and cannot
// tell whether the model was unsure or a decoder proved the code impossible.
//
// ⚠ OPERATOR-ONLY, and that is a security property rather than a placement
// preference. Each row names the rule that caught the item, which is exactly
// what someone would need to produce a code that passes next time. Deterministic
// checks are the most defensible signal here precisely because they are not
// guessable. This lives behind the /api/admin/* auth group; it must never be
// mirrored onto a seller or buyer surface.
adminGradingRoutes.get("/authenticity/decoder-contradictions", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("grade_reports")
    .select("id, submission_id, created_at, authenticity_assessment")
    // The key is absent on every report where nothing fired, which is almost
    // all of them — so filter in the DATABASE rather than pulling every report
    // and discarding it here.
    .not("authenticity_assessment->decoder_contradictions", "is", null)
    .order("created_at", { ascending: false })
    .limit(DECODER_CONTRADICTION_CAP);
  if (error) {
    return failSafe(
      c,
      400,
      "Couldn't load decoder contradictions.",
      error,
      "admin.grading.authenticity.decoder_contradictions",
    );
  }

  const rows = (data ?? []) as Array<{
    id: string;
    submission_id: string;
    created_at: string;
    // US-2804: there is no authenticity_verdict COLUMN. The verdict lives in
    // the assessment jsonb, which is how grade-adjustment.ts, the certificate
    // backfill, and line ~960 of this same file already read it.
    authenticity_assessment: {
      verdict?: string | null;
      verdict_confidence?: number;
      brand_assessed?: string | null;
      decoder_contradictions?: Array<{ code: string; message: string }>;
    } | null;
  }>;

  return c.json({
    // Surfaced rather than silent: a capped read is a sample of the newest rows,
    // which is a different claim from "all of them".
    truncated: rows.length >= DECODER_CONTRADICTION_CAP,
    contradictions: rows.map((r) => ({
      grade_report_id: r.id,
      submission_id: r.submission_id,
      created_at: r.created_at,
      verdict: r.authenticity_assessment?.verdict ?? null,
      verdict_confidence: r.authenticity_assessment?.verdict_confidence ?? null,
      brand: r.authenticity_assessment?.brand_assessed ?? null,
      flags: r.authenticity_assessment?.decoder_contradictions ?? [],
    })),
  });
});

// GET /authenticity/cases — the golden set + per-brand coverage.
adminGradingRoutes.get("/authenticity/cases", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("authenticity_eval_cases")
    .select("id, label, brand_key, brand, garment_type, expected_label, tags, is_active, notes, source_url, images, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    return failSafe(c, 400, "Couldn't load the authenticity golden set.", error, "admin.grading.authenticity.cases.list");
  }
  const rows = (data ?? []) as AuthenticityCaseRow[];
  return c.json({ cases: rows, coverage: summarizeCaseCoverage(rows) });
});

// POST /authenticity/cases — add a labeled case.
adminGradingRoutes.post("/authenticity/cases", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const invalid = validateAuthenticityCase(body);
  if (invalid) return c.json({ error: invalid }, 400);

  const { data, error } = await supabaseAdmin
    .from("authenticity_eval_cases")
    .insert({
      label: String(body.label).trim(),
      brand_key: String(body.brand_key).trim(),
      brand: typeof body.brand === "string" ? body.brand.trim() : null,
      garment_type: typeof body.garment_type === "string" ? body.garment_type : null,
      images: body.images,
      expected_label: body.expected_label,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      notes: typeof body.notes === "string" ? body.notes : null,
      source_url: typeof body.source_url === "string" ? body.source_url : null,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) {
    return failSafe(c, 400, "Couldn't add the case.", error, "admin.grading.authenticity.cases.create");
  }

  const id = (data as { id: string }).id;
  await auditLog(c, "create_authenticity_eval_case", "authenticity_eval_case", id, {
    brand_key: body.brand_key,
    expected_label: body.expected_label,
    // Recorded because a label with no stated provenance is the weak kind.
    has_source: Boolean(body.source_url),
  });
  return c.json({ id }, 201);
});

// POST /authenticity/cases/import — bulk-add labelled cases.
//
// The single-case POST does not scale to the actual job: an expert working
// through a labelled corpus. Partial success is reported per row rather than
// failing the batch, because re-uploading 50 rows over one typo is how people
// start bypassing validation.
adminGradingRoutes.post("/authenticity/cases/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null) as
    | { cases?: unknown }
    | unknown[]
    | null;
  const rows = Array.isArray(body) ? body : (body as { cases?: unknown })?.cases;

  const sizeError = validateBatchSize(rows);
  if (sizeError) return c.json({ error: sizeError }, 400);

  const { prepared, errors } = prepareImport(rows as GoldenSetImportRow[]);
  const warnings = coverageWarnings(prepared);

  let inserted = 0;
  if (prepared.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("authenticity_eval_cases")
      .insert(prepared.map((p) => ({ ...p, created_by: userId })))
      .select("id");
    if (error) {
      return failSafe(c, 400, "Couldn't import the cases.", error, "admin.grading.authenticity.import");
    }
    inserted = ((data ?? []) as { id: string }[]).length;
  }

  await auditLog(c, "import_authenticity_eval_cases", "authenticity_eval_case", null, {
    submitted: (rows as unknown[]).length,
    inserted,
    rejected: errors.length,
    brands: [...new Set(prepared.map((p) => p.brand_key))],
  });

  // 207-ish semantics via the body: the caller must be able to tell a full
  // success from a partial one WITHOUT parsing counts, so `rejected` is always
  // present and the failing rows are named.
  return c.json({
    submitted: (rows as unknown[]).length,
    inserted,
    rejected: errors.length,
    errors,
    // Not blocking — a corpus may legitimately arrive in two halves — but an
    // operator should know before an eval run spends a vision call per case.
    coverage_warnings: warnings,
  }, errors.length > 0 ? 207 : 201);
});

// PATCH /authenticity/cases/:id — correct a case, or retire it. Retiring is the
// only removal path; see the note above.
adminGradingRoutes.patch("/authenticity/cases/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const patch: Record<string, unknown> = {};
  if (typeof body.label === "string") patch.label = body.label.trim();
  if (typeof body.notes === "string") patch.notes = body.notes;
  if (typeof body.source_url === "string") patch.source_url = body.source_url;
  if (Array.isArray(body.tags)) patch.tags = body.tags.map(String);
  if (typeof body.is_active === "boolean") patch.is_active = body.is_active;
  if (typeof body.expected_label === "string") {
    if (!EXPECTED_LABELS.has(body.expected_label)) {
      return c.json({ error: `expected_label must be one of: ${[...EXPECTED_LABELS].join(", ")}` }, 400);
    }
    patch.expected_label = body.expected_label;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update." }, 400);

  const { error } = await supabaseAdmin
    .from("authenticity_eval_cases")
    .update(patch)
    .eq("id", id);
  if (error) {
    return failSafe(c, 400, "Couldn't update the case.", error, "admin.grading.authenticity.cases.update");
  }

  // Changing ground truth or retiring a case both alter what the gate certifies,
  // so both are audited with the before/after intent visible.
  await auditLog(c, "update_authenticity_eval_case", "authenticity_eval_case", id, patch);
  return c.json({ ok: true });
});

// GET /authenticity/gate — is the version actually serving traffic backed by a
// passing eval run, on the model that will serve it? Read-only.
adminGradingRoutes.get("/authenticity/gate", async (c) => {
  const versions = [AUTHENTICITY_PROMPT_VERSION, AUTHENTICITY_PROMPT_VERSION_GROUNDED];
  const statuses = await Promise.all(versions.map((v) => authenticityGateStatus(v)));
  return c.json({
    // The headline an operator needs: is ANY live version serving ungated?
    all_gated: statuses.every((s) => s.gated),
    versions: statuses,
  });
});

// POST /authenticity/eval — replay the labeled golden set through the
// authenticity pass and record the run. Costs real vision calls (one pass per
// case), so it is step-up gated rather than casually runnable.
adminGradingRoutes.post("/authenticity/eval", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({})) as { prompt_version?: string };
  // Default to the grounded constant — that is what the live pass uses when
  // brand tells are available, so it is the version worth certifying.
  const promptVersion = body.prompt_version?.trim() || AUTHENTICITY_PROMPT_VERSION_GROUNDED;

  try {
    const result = await runAuthenticityEval(promptVersion, userId);
    await auditLog(c, "run_authenticity_eval", "authenticity_eval_run", null, {
      prompt_version: result.prompt_version,
      model: result.model,
      passed: result.passed,
      agreement_rate: result.agreement_rate,
      dangerous_misses: result.dangerous_misses,
      cases_total: result.cases_total,
    });
    return c.json(result);
  } catch (err) {
    // The expected failure today is "no active cases" — the golden set is
    // operator-curated and empty until US-2131 seeds it. Surface that plainly
    // rather than as a generic 500; it is a setup state, not a bug.
    return c.json(
      {
        error: "Authenticity eval run failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }
});

// ── US-896: staged rollout / canary % ────────────────────────────────
//
// A canary routes a configurable PERCENTAGE of live grading traffic to an
// eval-passed challenger, bucketed by a stable per-submission hash, while the
// active champion serves the rest. The operator watches canary-vs-active
// signals before promoting (the existing /activate path) or rolling back.
// Live-percentage complement to shadow (offline). The grading kill-switch
// (feature_flags "grading") gates all grading, canary included (AC#4).

const CANARY_METRIC_LIMIT = 20_000;
const DISPUTE_IN_CHUNK = 1_000;

interface CanaryVersionMetrics {
  version_name: string;
  grades: number;
  mean_score: number | null;
  mean_confidence: number | null;
  human_review_rate: number | null;
  early_dispute_rate: number | null;
  dispute_count: number;
}

// Live metrics for one prompt VERSION over a window, read from grade_reports
// (.prompt_version records the composite version a grade shipped under) + the
// early-dispute join. Platform-admin analytics over the whole corpus.
async function computeCanaryVersionMetrics(
  versionName: string,
  since: string,
): Promise<CanaryVersionMetrics> {
  const empty: CanaryVersionMetrics = {
    version_name: versionName,
    grades: 0,
    mean_score: null,
    mean_confidence: null,
    human_review_rate: null,
    early_dispute_rate: null,
    dispute_count: 0,
  };

  const { data, error } = await supabaseAdmin
    .from("grade_reports")
    .select("id, overall_score, confidence_score, needs_human_review")
    .eq("prompt_version", versionName)
    .gte("created_at", since)
    .limit(CANARY_METRIC_LIMIT);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    id: string;
    overall_score: number;
    confidence_score: number;
    needs_human_review: boolean | null;
  }>;
  if (rows.length === 0) return empty;

  const grades = rows.length;
  const sumScore = rows.reduce((s, r) => s + Number(r.overall_score), 0);
  const sumConf = rows.reduce((s, r) => s + Number(r.confidence_score), 0);
  // US-2303: the TUNABLE threshold, not a literal. This counts how many grades
  // the review gate caught, so a hardcoded 0.75 meant lowering the threshold in
  // the admin UI moved the real gate while this metric kept scoring against the
  // old one — the calibration screen would report on a threshold nobody was
  // using any more, which is worse than not reporting.
  const reviewThreshold = reviewConfidenceThreshold();
  const reviewed = rows.filter(
    (r) => r.needs_human_review === true ||
      Number(r.confidence_score) < reviewThreshold,
  ).length;

  // Early dispute rate: of these grades, how many drew a dispute. Chunk the IN
  // so a large window stays a bounded set of queries.
  const ids = rows.map((r) => r.id);
  const disputed = new Set<string>();
  for (let i = 0; i < ids.length; i += DISPUTE_IN_CHUNK) {
    const slice = ids.slice(i, i + DISPUTE_IN_CHUNK);
    const { data: disp } = await supabaseAdmin
      .from("disputes")
      .select("grade_report_id")
      .in("grade_report_id", slice);
    for (const d of (disp ?? []) as Array<{ grade_report_id: string }>) {
      disputed.add(d.grade_report_id);
    }
  }

  return {
    version_name: versionName,
    grades,
    mean_score: sumScore / grades,
    mean_confidence: sumConf / grades,
    human_review_rate: reviewed / grades,
    early_dispute_rate: disputed.size / grades,
    dispute_count: disputed.size,
  };
}

// The active champion's version_name for a (stage, scope) slot — falls back to
// the code-default version name when no DB override is active (that's what the
// grades are attributed to). Mirrors resolveActivePrompt's scope preference.
async function resolveSlotActiveVersionName(
  stage: string,
  garmentScope: string | null,
): Promise<string> {
  const { data } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("version_name, garment_scope")
    .eq("stage", stage)
    .eq("is_active", true);
  const rows = (data ?? []) as Array<{ version_name: string; garment_scope: string | null }>;
  const scoped = garmentScope ? rows.find((r) => r.garment_scope === garmentScope) : undefined;
  const global = rows.find((r) => !r.garment_scope);
  const picked = scoped ?? global;
  if (picked) return picked.version_name;
  return stage === "composite" ? COMPOSITE_PROMPT_VERSION : PER_IMAGE_PROMPT_VERSION;
}

// GET /prompts/:id/canary?days=<n> — live canary-vs-active metrics side by side
// (mean score delta, confidence, human-review rate, early dispute rate). NOTE:
// grade_reports.prompt_version is the COMPOSITE version a grade shipped under,
// so live metrics are meaningful for composite-stage canaries (measurable=true).
adminGradingRoutes.get("/prompts/:id/canary", async (c) => {
  const id = c.req.param("id");
  const days = Math.min(Math.max(Number(c.req.query("days")) || 14, 1), 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data: row, error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select(
      "id, version_name, stage, garment_scope, is_active, is_canary, " +
        "rollout_percentage, rollout_started_at, eval_passed",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't load canary status.", error, "admin.grading.canary.get");
  if (!row) return c.json({ error: "Prompt version not found" }, 404);
  // The concatenated SELECT string defeats supabase-js's static row inference, so
  // cast through unknown (the shape is the select by construction).
  const v = row as unknown as {
    id: string;
    version_name: string;
    stage: string;
    garment_scope: string | null;
    is_active: boolean;
    is_canary: boolean;
    rollout_percentage: number | null;
    rollout_started_at: string | null;
    eval_passed: boolean | null;
  };

  try {
    const activeVersionName = await resolveSlotActiveVersionName(v.stage, v.garment_scope);
    const [canary, active] = await Promise.all([
      computeCanaryVersionMetrics(v.version_name, since),
      computeCanaryVersionMetrics(activeVersionName, since),
    ]);
    const scoreDelta =
      canary.mean_score !== null && active.mean_score !== null
        ? canary.mean_score - active.mean_score
        : null;
    return c.json({
      prompt: {
        id: v.id,
        version_name: v.version_name,
        stage: v.stage,
        garment_scope: v.garment_scope,
        is_active: v.is_active,
        is_canary: v.is_canary,
        rollout_percentage: v.rollout_percentage ?? 0,
        rollout_started_at: v.rollout_started_at,
        eval_passed: v.eval_passed,
      },
      active_version_name: activeVersionName,
      window_days: days,
      // Live grade attribution is by composite version; per-image canary metrics
      // can't be measured from grade_reports.
      measurable: v.stage === "composite",
      canary,
      active,
      score_delta: scoreDelta,
    });
  } catch (err) {
    return c.json(
      {
        error: "Failed to compute canary metrics",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// PATCH /prompts/:id/canary — set the canary traffic % (0 = roll back). Gated:
// eval must pass, the version can't be the active champion, and only one canary
// per (stage, scope) slot. Step-up + audited (changes live grading routing).
// Body: { rollout_percentage: 0..100 }.
adminGradingRoutes.patch("/prompts/:id/canary", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const id = c.req.param("id");
  let body: { rollout_percentage?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const pct = Number(body.rollout_percentage);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    return c.json({ error: "rollout_percentage must be an integer 0–100" }, 400);
  }

  const { data: row, error: loadErr } = await supabaseAdmin
    .from("ai_prompt_versions")
    // US-2300: qualified_model comes along. It was never selected, which is why
    // the check below could not have existed even if someone had written it.
    .select("id, stage, garment_scope, is_active, is_canary, eval_passed, qualified_model")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return failSafe(c, 500, "Couldn't load the prompt.", loadErr, "admin.grading.canary.load");
  if (!row) return c.json({ error: "Prompt version not found" }, 404);
  const v = row as {
    stage: string;
    garment_scope: string | null;
    is_active: boolean;
    is_canary: boolean;
    eval_passed: boolean | null;
    qualified_model: string | null;
  };

  if (pct > 0) {
    if (v.is_active) {
      return c.json(
        { error: "The active champion already serves 100% — it can't also be a canary. Use deactivate + promote a challenger instead." },
        422,
      );
    }
    // US-2300: the SAME gate activatePromptVersion applies. This route tested
    // only eval_passed, so a prompt qualified on model A could serve a live
    // slice of paying customers while DEFAULT_AI_MODEL was model B. A canary is
    // a smaller audience, not a lower bar — the grades it produces are sold.
    // US-2307: per-STAGE serving model, matching activatePromptVersion. Sharing
    // the gate function was never enough on its own — both callers passed the
    // composite model for every stage, so the two agreed and were both wrong
    // for per_image and listing_gen.
    const eligible = checkPromptServingEligibility(v, servingModelForStage(v.stage));
    if (!eligible.ok) return c.json({ error: eligible.reason }, 422);
    // One canary per slot: clear any OTHER canary in the same (stage, scope).
    let clear = supabaseAdmin
      .from("ai_prompt_versions")
      .update({ is_canary: false, rollout_percentage: 0, rollout_started_at: null })
      .eq("stage", v.stage)
      .eq("is_canary", true)
      .neq("id", id);
    clear = v.garment_scope
      ? clear.eq("garment_scope", v.garment_scope)
      : clear.is("garment_scope", null);
    await clear;
  }

  // Stamp rollout_started_at only when OPENING a new slice (not when adjusting an
  // already-running canary), so the "since rollout" window is preserved.
  const update: Record<string, unknown> =
    pct > 0
      ? {
          is_canary: true,
          rollout_percentage: pct,
          ...(v.is_canary ? {} : { rollout_started_at: new Date().toISOString() }),
        }
      : { is_canary: false, rollout_percentage: 0, rollout_started_at: null };

  const { data, error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return failSafe(c, 400, "Couldn't update the canary.", error, "admin.grading.canary.update");

  // Propagate the new routing to every replica's prompt cache immediately.
  await invalidatePromptCache();
  await auditLog(
    c,
    pct > 0 ? "set_prompt_canary" : "rollback_prompt_canary",
    "ai_prompt_version",
    id,
    { rollout_percentage: pct, stage: v.stage, garment_scope: v.garment_scope },
  );
  return c.json({ prompt: data });
});

// ── US-547: AutoLister listing-prompt self-improvement ────────────────
//
// The listing_gen prompt learns from which AI fields sellers keep vs change
// (captured at publish into listing_prompt_acceptance) paired with sell-through.
// These endpoints power the admin dashboard (AC3) and the A/B auto-promotion
// loop (AC2). Creating/eval-ing/activating a listing_gen candidate reuses the
// generic /prompts endpoints above (stage="listing_gen").

// GET /listing-prompts/performance — per-version keep-rate + sell-through.
adminGradingRoutes.get("/listing-prompts/performance", async (c) => {
  try {
    const stats = await summarizeListingPromptPerformance();
    return c.json({ stats });
  } catch (err) {
    return c.json(
      { error: "Failed to load listing-prompt performance", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// PATCH /listing-prompts/:id/trial — start/stop an A/B trial for a listing_gen
// candidate. A trialed (eval-passed, inactive) prompt takes ~50% of generations
// until auto-promotion resolves it. Body: { in_trial: boolean }.
adminGradingRoutes.patch("/listing-prompts/:id/trial", async (c) => {
  const id = c.req.param("id");
  let body: { in_trial?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const inTrial = body.in_trial === true;

  const { data: row, error: loadErr } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, stage, eval_passed, is_active")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return failSafe(c, 500, "Couldn't load the listing prompt.", loadErr, "admin.grading.listing.trial.load");
  if (!row) return c.json({ error: "Prompt version not found" }, 404);
  const v = row as { stage: string; eval_passed: boolean | null; is_active: boolean };
  if (v.stage !== "listing_gen") {
    return c.json({ error: "Only listing_gen prompts support A/B trials" }, 422);
  }
  if (inTrial && v.eval_passed !== true) {
    return c.json({ error: "Run the eval gate (must pass) before starting a trial" }, 422);
  }
  if (inTrial && v.is_active) {
    return c.json({ error: "The active champion cannot also be the trial challenger" }, 422);
  }

  // Only one challenger at a time: clear any other in-trial listing_gen row.
  if (inTrial) {
    await supabaseAdmin
      .from("ai_prompt_versions")
      .update({ in_trial: false })
      .eq("stage", "listing_gen")
      .eq("in_trial", true)
      .neq("id", id);
  }

  const { error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .update({ in_trial: inTrial, trial_started_at: inTrial ? new Date().toISOString() : null })
    .eq("id", id);
  if (error) return failSafe(c, 400, "Couldn't update the trial.", error, "admin.grading.listing.trial.update");
  await auditLog(c, "set_listing_prompt_trial", "ai_prompt_version", id, { in_trial: inTrial });
  return c.json({ ok: true, in_trial: inTrial });
});

// POST /listing-prompts/auto-promote — evaluate the in-trial challenger against
// the champion and promote (eval-gated) / end the trial / hold. Idempotent;
// safe to run on a schedule.
adminGradingRoutes.post("/listing-prompts/auto-promote", async (c) => {
  try {
    const decision = await autoPromoteListingPrompt();
    if (decision.action === "promoted" || decision.action === "trial_ended") {
      await auditLog(c, "auto_promote_listing_prompt", "ai_prompt_version", null, {
        action: decision.action,
        challenger: decision.challenger ?? null,
        champion: decision.champion ?? null,
        challenger_score: decision.challengerScore ?? null,
        champion_score: decision.championScore ?? null,
        sample: decision.sample ?? null,
      });
    }
    return c.json(decision);
  } catch (err) {
    return c.json(
      { error: "Auto-promote failed", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// ── Shadow / A-B grading (US-330) ────────────────────────────────────

// PATCH /prompts/:id/shadow — mark a candidate composite prompt to run in
// shadow on live traffic, with cost guardrails. Body:
//   { is_shadow: bool, shadow_sample_rate?: 0..1, shadow_daily_cap?: int }
// Shadow runs are advisory only and never affect a customer's grade;
// activation still requires the eval gate (POST /prompts/:id/activate).
adminGradingRoutes.patch("/prompts/:id/shadow", async (c) => {
  const id = c.req.param("id");
  let body: {
    is_shadow?: boolean;
    shadow_sample_rate?: number;
    shadow_daily_cap?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Only composite-stage candidates can be shadowed (per-image shadowing would
  // require a full re-grade; the composite re-run reuses per-image analyses).
  const { data: row, error: loadErr } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, stage")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return failSafe(c, 500, "Couldn't load the prompt.", loadErr, "admin.grading.shadow.load");
  if (!row) return c.json({ error: "Prompt version not found" }, 404);
  if ((row as { stage: string }).stage !== "composite") {
    return c.json({ error: "Only composite-stage prompts can be shadowed" }, 422);
  }

  const update: Record<string, unknown> = {};
  if (typeof body.is_shadow === "boolean") update.is_shadow = body.is_shadow;
  if (body.shadow_sample_rate !== undefined) {
    const r = Number(body.shadow_sample_rate);
    if (!Number.isFinite(r) || r < 0 || r > 1) {
      return c.json({ error: "shadow_sample_rate must be between 0 and 1" }, 400);
    }
    update.shadow_sample_rate = r;
  }
  if (body.shadow_daily_cap !== undefined) {
    const cap = Number(body.shadow_daily_cap);
    if (!Number.isInteger(cap) || cap < 0) {
      return c.json({ error: "shadow_daily_cap must be a non-negative integer" }, 400);
    }
    update.shadow_daily_cap = cap;
  }
  if (Object.keys(update).length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return failSafe(c, 400, "Couldn't update shadow mode.", error, "admin.grading.shadow.update");
  await auditLog(c, "set_prompt_shadow", "ai_prompt_version", id, update);
  return c.json({ prompt: data });
});

// GET /shadow/comparison?version=<name>&days=<n> — aggregate shadow-vs-active
// comparison for a candidate: score-delta distribution, agreement rate, and
// per-tag divergence (e.g. distressed_denim). Admin-only platform analytics.
// US-1564 wire decision: WIRED — Shadow tab of GradingAccuracyPanel.
adminGradingRoutes.get("/shadow/comparison", async (c) => {
  const version = (c.req.query("version") ?? "").trim();
  if (!version) return c.json({ error: "version query param is required" }, 400);
  const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // US-2443: `stage` is optional and unset means BOTH, which is the honest
  // default — a caller that does not know the column exists gets everything
  // rather than a silently composite-only answer. The two stages are never
  // aggregated by accident in practice because a candidate label belongs to one
  // stage, but the filter is here for the case where a name is reused.
  const stage = (c.req.query("stage") ?? "").trim();
  if (stage && stage !== "per_image" && stage !== "composite") {
    return c.json({ error: "stage must be per_image or composite" }, 400);
  }

  let q = supabaseAdmin
    .from("grading_shadow_results")
    .select(
      "score_delta, agreement, tags, shadow_overall_score, error, " +
        "tier_agreement, per_factor_deltas, vision_calls",
    )
    .eq("shadow_prompt_version_name", version)
    .gte("created_at", since)
    .limit(10_000);
  if (stage) q = q.eq("stage", stage);
  const { data, error } = await q;
  if (error) return failSafe(c, 500, "Couldn't load the shadow comparison.", error, "admin.grading.shadow.comparison");
  const summary = summarizeComparisons((data ?? []) as unknown as ShadowRow[]);
  return c.json({ version, days, stage: stage || null, ...summary });
});

// GET /shadow/results?version=<name>&limit=<n> — recent shadow rows for
// inspection (the divergent cases an admin wants to eyeball).
// US-1564 wire decision: WIRED — Shadow tab (divergent-row inspection + version picker).
adminGradingRoutes.get("/shadow/results", async (c) => {
  const version = (c.req.query("version") ?? "").trim();
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  let q = supabaseAdmin
    .from("grading_shadow_results")
    .select(
      "id, submission_id, shadow_prompt_version_name, active_prompt_version_name, " +
        "active_overall_score, active_grade_tier, shadow_overall_score, shadow_grade_tier, " +
        "score_delta, agreement, tags, error, created_at, " +
        // US-2443: which stage the row came from, and what it cost. Without
        // `stage` an admin eyeballing divergent rows cannot tell a per-image
        // comparison from a composite one, and they mean different things.
        "stage, tier_agreement, per_factor_deltas, images_analyzed, vision_calls",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (version) q = q.eq("shadow_prompt_version_name", version);
  const stage = (c.req.query("stage") ?? "").trim();
  if (stage && stage !== "per_image" && stage !== "composite") {
    return c.json({ error: "stage must be per_image or composite" }, 400);
  }
  if (stage) q = q.eq("stage", stage);
  const { data, error } = await q;
  if (error) return failSafe(c, 500, "Couldn't load shadow results.", error, "admin.grading.shadow.results");
  return c.json({ results: data ?? [] });
});

// ── Eval cases (golden set) ──────────────────────────────────────────

// GET /eval/cases — list golden cases.
adminGradingRoutes.get("/eval/cases", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("grading_eval_cases")
    .select("*")
    .is("deleted_at", null) // US-2037: retired cases are auditable, not listed.
    .order("created_at", { ascending: false });
  if (error) return failSafe(c, 500, "Couldn't load eval cases.", error, "admin.grading.eval.cases.list");
  return c.json({ cases: data ?? [] });
});

// POST /eval/cases — add a golden case. images is [{ image_type, storage_path }].
// US-2307 AC4: the asymmetry was NOT deliberate, and the decision is recorded
// here rather than in a story note nobody will read next to this code.
//
// PATCH and DELETE on a case required step-up; creating one did not. The
// implied reasoning is that editing ground truth is dangerous and adding to it
// is routine. That gets the threat backwards.
//
// The golden set IS the eval gate. A prompt version is promoted to live paid
// traffic on the strength of clearing MAE/agreement thresholds against these
// cases, so whoever controls the cases controls the gate. Adding a fabricated
// case with lenient expected scores is the straightforward way to make a
// failing prompt pass — it needs no edit to anything that already exists and
// leaves the existing cases untouched, which is exactly what makes it the
// quieter path. The grading-engine contract says the set grows from REAL
// corrected grades and never synthetic fabrications; that rule needed a gate
// and had none.
//
// So all four writers now match: create, promote, promote-batch, edit, delete.
adminGradingRoutes.post("/eval/cases", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const userId = c.get("userId");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const label = String(body.label ?? "").trim();
  const garmentType = String(body.garment_type ?? "").trim();
  const garmentCategory = String(body.garment_category ?? "").trim();
  const expectedScore = Number(body.expected_score);
  const expectedTier = String(body.expected_tier ?? "").trim();

  if (!label) return c.json({ error: "label is required" }, 400);
  if (!garmentType) return c.json({ error: "garment_type is required" }, 400);
  if (!garmentCategory) return c.json({ error: "garment_category is required" }, 400);
  if (!Number.isFinite(expectedScore) || expectedScore < 1 || expectedScore > 10) {
    return c.json({ error: "expected_score must be 1.0–10.0" }, 400);
  }
  if (!expectedTier) return c.json({ error: "expected_tier is required" }, 400);
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return c.json({ error: "images must be a non-empty array of { image_type, storage_path }" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("grading_eval_cases")
    .insert({
      label,
      garment_type: garmentType,
      garment_category: garmentCategory,
      brand: body.brand ? String(body.brand) : null,
      description: body.description ? String(body.description) : null,
      style_attributes: Array.isArray(body.style_attributes) ? body.style_attributes : [],
      images: body.images,
      expected_score: expectedScore,
      expected_tier: expectedTier,
      tags: Array.isArray(body.tags) ? body.tags : [],
      notes: body.notes ? String(body.notes) : null,
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) return failSafe(c, 400, "Couldn't save the eval case.", error, "admin.grading.eval.cases.create");

  await auditLog(c, "create_eval_case", "grading_eval_case", data.id, { label });
  return c.json({ case: data }, 201);
});

// POST /eval/cases/promote — promote a corrected grade into a CANDIDATE eval
// case (is_active=false, pending approval). US-329: the self-improvement loop.
// Body: { grade_report_id, source?: "human_review" | "dispute" }. Idempotent —
// one candidate per grade report (dedup on source_grade_report_id).
// US-2307 AC4: DELIBERATELY NOT step-up gated, and the reasoning is the same
// one that gates the route above rather than a softer version of it.
//
// This creates a CANDIDATE (is_active=false). A candidate counts for nothing:
// the eval loads `.eq("is_active", true)`, so it cannot influence the gate
// until an admin approves it via PATCH /eval/cases/:id — which IS step-up
// gated. The privileged act is the approval, and it is already guarded.
//
// The second reason is stronger. This endpoint is called automatically and
// best-effort by the web client after a reviewer adjusts a grade
// (src/lib/eval-candidates.ts), inside a try/catch that swallows everything so
// it can never block the correction it follows. A step-up here would not
// prompt anybody — it would return 403 into a catch that discards it, and the
// self-improvement loop would stop growing with nothing to show for it. That
// is the go-quiet-on-failure shape, added on purpose.
adminGradingRoutes.post("/eval/cases/promote", async (c) => {
  const userId = c.get("userId");
  let body: { grade_report_id?: string; source?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const reportId = (body.grade_report_id ?? "").trim();
  if (!reportId) return c.json({ error: "grade_report_id is required" }, 400);
  const source = body.source === "dispute" ? "dispute" : "human_review";

  const result = await promoteGradeReportToEvalCase(reportId, source, userId);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400);
  if (result.already) {
    return c.json({ ok: true, already: true, case_id: result.case_id });
  }

  await auditLog(c, "promote_eval_candidate", "grading_eval_case", result.case_id, {
    source,
    grade_report_id: reportId,
  });
  return c.json({ ok: true, case_id: result.case_id }, 201);
});

// POST /eval/cases/promote-batch — sweep recent high-signal corrections (a
// reviewer moved the score by >= min_delta points, or flagged an
// intentional-design misread) and promote each into a CANDIDATE golden eval case
// so coverage grows automatically (US-1068). Idempotent (dedup on source grade
// report); candidates still need approval before counting toward the gate.
// Body: { min_delta?, since_days?, limit? }. Safe to run on a schedule.
// US-2307 AC4: not gated, for the same reason as the single promote — it also
// writes is_active=false candidates (grading-eval.ts), so nothing it creates
// reaches the eval gate without a step-up-gated approval.
//
// It is bulk, which is what made gating it tempting. But bulk-creating rows
// that count for nothing is not a privileged act, and the cost was concrete:
// this one IS operator-triggered from a button whose handler has no step-up
// replay path, so gating it would have turned "Grow from corrections" into an
// error toast.
adminGradingRoutes.post("/eval/cases/promote-batch", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await promoteHighSignalEvalCandidates({
      minDelta: Number(body.min_delta),
      sinceDays: Number(body.since_days),
      limit: Number(body.limit),
      createdBy: userId,
    });
    if (result.promoted > 0) {
      await auditLog(c, "promote_eval_candidates_batch", "grading_eval_case", null, {
        scanned: result.scanned,
        high_signal: result.high_signal,
        promoted: result.promoted,
        already_present: result.already_present,
      });
    }
    return c.json(result);
  } catch (err) {
    return c.json(
      {
        error: "Batch promotion failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// PATCH /eval/cases/:id — edit an eval case (whitelist of mutable fields).
//
// US-2037: step-up gated, matching /prompts/:id/activate, /prompts/:id/canary
// and /review/:id/adjust. Editing the golden set changes what "passing the eval
// gate" MEANS, which is at least as consequential as activating a prompt.
adminGradingRoutes.patch("/eval/cases/:id", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const allowed = [
    "label", "garment_type", "garment_category", "brand", "description",
    "style_attributes", "images", "expected_score", "expected_tier", "tags",
    "is_active", "notes",
  ];
  const update: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }
  if (Object.keys(update).length === 0) {
    return c.json({ error: "No mutable fields supplied" }, 400);
  }

  // US-2037: the ground truth is immutable once it has been used to judge a
  // prompt version. Re-scoring a case retroactively invalidates every run that
  // already graded against the old expectation — the historical MAE/agreement
  // numbers stay in the table but silently stop meaning what they say. If the
  // expectation was genuinely wrong, retire the case and add a corrected one;
  // that leaves both versions visible instead of rewriting the past.
  const groundTruthEdits = ["expected_score", "expected_tier"].filter((k) => k in update);
  if (groundTruthEdits.length > 0) {
    const { data: usedIn, error: usedErr } = await supabaseAdmin
      .from("grading_eval_runs")
      .select("id")
      .eq("passed", true)
      .contains("per_case", [{ case_id: id }])
      .limit(1);
    // Fail CLOSED: if we can't prove the case is unused, don't let the ground
    // truth move. An unverifiable edit to the benchmark is the exact thing this
    // guard exists to prevent.
    if (usedErr) {
      return failSafe(
        c,
        503,
        "Couldn't verify whether this case has been used in a passing eval run, so its expected score can't be edited right now.",
        usedErr,
        "admin.grading.eval.cases.immutability",
      );
    }
    if (usedIn && usedIn.length > 0) {
      return c.json(
        {
          error:
            `This case has already been used in a passing eval run, so ${groundTruthEdits.join(" and ")} ` +
            `is immutable (US-2037). Retire this case (DELETE) and add a corrected one instead — ` +
            `editing it in place would silently invalidate every historical accuracy comparison.`,
        },
        409,
      );
    }
  }

  const { data, error } = await supabaseAdmin
    .from("grading_eval_cases")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select("*")
    .single();
  if (error) return failSafe(c, 400, "Couldn't update the eval case.", error, "admin.grading.eval.cases.update");

  await auditLog(c, "update_eval_case", "grading_eval_case", id, { fields: Object.keys(update) });
  return c.json({ case: data });
});

// DELETE /eval/cases/:id — SOFT delete (US-2037).
//
// Was a hard delete, which let an operator quietly shrink the golden set until a
// stubborn prompt version passed, with no way to see afterwards what the
// benchmark used to contain. The row now survives with a deleted_at tombstone:
// every read path filters it out, the audit trail keeps a subject to point at,
// and the monitor's golden_set_shrank alert fires on the size change.
adminGradingRoutes.delete("/eval/cases/:id", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("grading_eval_cases")
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id, label")
    .maybeSingle();
  if (error) return failSafe(c, 400, "Couldn't delete the eval case.", error, "admin.grading.eval.cases.delete");
  if (!data) return c.json({ error: "Eval case not found (or already deleted)" }, 404);
  await auditLog(c, "delete_eval_case", "grading_eval_case", id, {
    soft: true,
    label: (data as { label: string }).label,
  });
  return c.json({ ok: true });
});

// GET /eval/runs — recent eval runs.
adminGradingRoutes.get("/eval/runs", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("grading_eval_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return failSafe(c, 500, "Couldn't load eval runs.", error, "admin.grading.eval.runs");
  return c.json({ runs: data ?? [] });
});

// ── US-1067: few-shot exemplar sets (self-improving prompt) ───────────
//
// Mine human-corrected grades (intentional-design misreads, large corrections)
// into a curated, versioned, PII-free few-shot block the composite grading
// prompt leans on. A set is INERT until it passes the SAME golden-set eval gate
// the prompt gate uses and is explicitly activated; the active block is appended
// to the composite system prompt (prompt-cached) so the model gets the hard
// cases right WITHOUT a larger reasoning budget.

// GET /exemplars — list exemplar sets (newest first).
adminGradingRoutes.get("/exemplars", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("grading_exemplar_sets")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return failSafe(c, 500, "Couldn't load exemplars.", error, "admin.grading.exemplars.list");
  return c.json({ sets: data ?? [] });
});

// POST /exemplars/assemble — mine recent corrections into a CANDIDATE set
// (inactive, un-evaluated). Body: { version_name, garment_category?, min_delta?,
// per_category_cap?, total_cap?, since_days?, notes? }.
adminGradingRoutes.post("/exemplars/assemble", async (c) => {
  const userId = c.get("userId");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const versionName = String(body.version_name ?? "").trim();
  if (!versionName) return c.json({ error: "version_name is required" }, 400);

  try {
    const set = await assembleExemplarSet({
      versionName,
      garmentCategory: body.garment_category ? String(body.garment_category) : null,
      minDelta: body.min_delta !== undefined ? Number(body.min_delta) : undefined,
      perCategoryCap:
        body.per_category_cap !== undefined ? Number(body.per_category_cap) : undefined,
      totalCap: body.total_cap !== undefined ? Number(body.total_cap) : undefined,
      sinceDays: body.since_days !== undefined ? Number(body.since_days) : undefined,
      notes: body.notes ? String(body.notes) : null,
      createdBy: userId,
    });
    await auditLog(c, "assemble_exemplar_set", "grading_exemplar_set", set.id, {
      version_name: versionName,
      garment_category: set.garment_category,
      exemplar_count: set.exemplar_count,
      source_review_count: set.source_review_count,
    });
    return c.json({ set }, 201);
  } catch (err) {
    return c.json(
      { error: "Failed to assemble exemplar set", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
});

// POST /exemplars/:id/eval — run the golden-set eval gate with the candidate
// block injected; records the impact (MAE + agreement + token cost) on the set.
adminGradingRoutes.post("/exemplars/:id/eval", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  try {
    const result = await evalExemplarSet(id, userId);
    await auditLog(c, "run_exemplar_eval", "grading_exemplar_set", id, {
      passed: result.passed,
      mae: result.mean_absolute_error,
      agreement_rate: result.agreement_rate,
      cases_total: result.cases_total,
      block_tokens: result.block_tokens,
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: "Exemplar eval failed", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
});

// POST /exemplars/:id/activate — promote to active (gated: requires a passing
// eval). Step-up + audited: it changes live grading.
adminGradingRoutes.post("/exemplars/:id/activate", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const id = c.req.param("id");
  const result = await activateExemplarSet(id);
  if (!result.ok) return c.json({ error: result.reason }, 422);
  await auditLog(c, "activate_exemplar_set", "grading_exemplar_set", id, {});
  return c.json({ ok: true });
});

// POST /exemplars/:id/deactivate — turn off an active set (reverts grading to no
// exemplar block).
adminGradingRoutes.post("/exemplars/:id/deactivate", async (c) => {
  // US-2353 AC3: same asymmetry as the prompt pair above. Removing an active
  // exemplar changes what the grader compares against.
  {
    const stepUp = requireFreshStepUp(c);
    if (stepUp) return stepUp;
  }
  const id = c.req.param("id");
  await deactivateExemplarSet(id);
  await auditLog(c, "deactivate_exemplar_set", "grading_exemplar_set", id, {});
  return c.json({ ok: true });
});

// ── US-1557: confidence-calibration view ─────────────────────────────
//
// GET /calibration-thresholds — the persisted per-category calibration
// (thresholds + reliability curves + enabled flag). Manual override / enable
// happens through the system-settings editor (key
// grading_confidence_calibration) — this is the read-only curve view.
adminGradingRoutes.get("/calibration-thresholds", async (c) => {
  const calibration = await getSetting<CalibrationSetting>(
    CALIBRATION_SETTING_KEY,
    EMPTY_CALIBRATION,
  );
  return c.json({
    calibration,
    flat_threshold: reviewConfidenceThreshold(),
  });
});

// ── Regression monitor (US-327) ──────────────────────────────────────

// GET /monitor/runs — recent automated quality-monitor runs (drift/alerts).
adminGradingRoutes.get("/monitor/runs", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("grading_monitor_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return failSafe(c, 500, "Couldn't load monitor runs.", error, "admin.grading.monitor.runs");
  return c.json({ runs: data ?? [] });
});

// POST /monitor/run — trigger a monitor scan on demand (same logic as the cron).
adminGradingRoutes.post("/monitor/run", async (c) => {
  try {
    const result = await runGradingRegressionScan("manual");
    await auditLog(c, "run_grading_monitor", "grading_monitor", null, {
      severity: result.severity,
      alert_count: result.alerts.length,
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: "Monitor scan failed", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// ── Inter-rater reliability studies (US-334) ──────────────────────
// Blind multi-rater rounds: 2+ reviewers grade the same submissions without
// seeing the AI grade or one another's scores. We then compute the
// human-vs-human baseline + Krippendorff's alpha and compare the AI's agreement
// with the human consensus against it.

// POST /reliability/studies — create a study. Body: { name, tolerance? }.
adminGradingRoutes.post("/reliability/studies", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);
  const tolerance = typeof body.tolerance === "number" && body.tolerance > 0 &&
      body.tolerance <= 5
    ? body.tolerance
    : 0.5;

  const { data, error } = await supabaseAdmin
    .from("reliability_studies")
    .insert({ name, tolerance, created_by: userId })
    .select()
    .single();
  if (error) return failSafe(c, 500, "Couldn't create the study.", error, "admin.grading.reliability.studies.create");
  await auditLog(c, "create_reliability_study", "reliability_study", data.id, {
    name,
    tolerance,
  });
  return c.json({ study: data }, 201);
});

// GET /reliability/studies — list studies with item/rating/reviewer counts.
adminGradingRoutes.get("/reliability/studies", async (c) => {
  const { data: studies, error } = await supabaseAdmin
    .from("reliability_studies")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return failSafe(c, 500, "Couldn't load studies.", error, "admin.grading.reliability.studies.list");

  const ids = (studies ?? []).map((s) => s.id);
  const counts: Record<string, { items: number; ratings: number; reviewers: number }> = {};
  for (const id of ids) counts[id] = { items: 0, ratings: 0, reviewers: 0 };

  if (ids.length > 0) {
    const { data: items } = await supabaseAdmin
      .from("reliability_study_items")
      .select("study_id")
      .in("study_id", ids);
    for (const r of items ?? []) counts[r.study_id].items++;

    const { data: ratings } = await supabaseAdmin
      .from("reliability_ratings")
      .select("study_id, reviewer_id")
      .in("study_id", ids);
    const reviewerSets: Record<string, Set<string>> = {};
    for (const r of ratings ?? []) {
      counts[r.study_id].ratings++;
      (reviewerSets[r.study_id] ??= new Set()).add(r.reviewer_id);
    }
    for (const id of ids) counts[id].reviewers = reviewerSets[id]?.size ?? 0;
  }

  return c.json({
    studies: (studies ?? []).map((s) => ({ ...s, counts: counts[s.id] })),
  });
});

// POST /reliability/studies/:id/items — add submissions to the sample.
// Body: { submission_ids: string[] }.
adminGradingRoutes.post("/reliability/studies/:id/items", async (c) => {
  const studyId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const subIds: string[] = Array.isArray(body.submission_ids)
    ? body.submission_ids.filter((s: unknown): s is string => typeof s === "string")
    : [];
  if (subIds.length === 0) return c.json({ error: "submission_ids required" }, 400);

  // Only certified-gradeable submissions make sense; we don't restrict tenant
  // here because reliability studies are a platform-admin function over the
  // whole grade corpus.
  const rows = subIds.map((submission_id) => ({ study_id: studyId, submission_id }));
  const { error } = await supabaseAdmin
    .from("reliability_study_items")
    .upsert(rows, { onConflict: "study_id,submission_id", ignoreDuplicates: true });
  if (error) return failSafe(c, 500, "Couldn't add study items.", error, "admin.grading.reliability.items");
  await auditLog(c, "add_reliability_items", "reliability_study", studyId, {
    count: subIds.length,
  });
  return c.json({ added: subIds.length });
});

// GET /reliability/studies/:id/queue — the BLIND rating queue for the current
// reviewer: study submissions they haven't rated yet, with NO AI grade and NO
// other reviewers' scores. This is what enforces blindness.
adminGradingRoutes.get("/reliability/studies/:id/queue", async (c) => {
  const studyId = c.req.param("id");
  const userId = c.get("userId");

  const { data: items } = await supabaseAdmin
    .from("reliability_study_items")
    .select("submission_id")
    .eq("study_id", studyId);
  const allIds = (items ?? []).map((i) => i.submission_id);

  const { data: mine } = await supabaseAdmin
    .from("reliability_ratings")
    .select("submission_id")
    .eq("study_id", studyId)
    .eq("reviewer_id", userId);
  const ratedByMe = new Set((mine ?? []).map((r) => r.submission_id));
  const todo = allIds.filter((id) => !ratedByMe.has(id));

  // MINIMIZED payload (US-488): only the non-identifying garment attributes a
  // blind grade needs — never the grade_report (AI score), anyone else's
  // rating, the owner's identity, or seller-authored free text (title /
  // description can carry PII and bias a blind condition grade). The
  // allowlist lives in reliability-privacy.ts.
  let queue: unknown[] = [];
  if (todo.length > 0) {
    const { data: subs } = await supabaseAdmin
      .from("submissions")
      .select(RELIABILITY_QUEUE_SELECT)
      .in("id", todo);
    // supabase-js can't parse a runtime-built SELECT string, so it infers an
    // error type; the shape is RELIABILITY_QUEUE_FIELDS by construction.
    queue = ((subs ?? []) as unknown as Record<string, unknown>[]).map(
      minimizeReliabilityQueueRow,
    );
  }

  // QA access to the customer-data sample is itself logged (US-488).
  await auditLog(c, "view_reliability_queue", "reliability_study", studyId, {
    item_count: todo.length,
  });

  return c.json({ remaining: todo.length, total: allIds.length, queue });
});

// GET /reliability/studies/:id/items/:submissionId/photos — short-lived signed
// photo URLs for ONE study item so the reviewer can blind-grade it (US-488).
// The grant is scoped to study membership (an arbitrary submission id that was
// never sampled into the study returns 404), the payload is minimized (no
// storage_path — it embeds the owner's user UUID — and no owner/submission
// metadata beyond the images), and EVERY call writes a per-item audit row
// naming the reviewer, study, and submission viewed.
adminGradingRoutes.get(
  "/reliability/studies/:id/items/:submissionId/photos",
  async (c) => {
    const studyId = c.req.param("id");
    const submissionId = c.req.param("submissionId");

    const { data: item } = await supabaseAdmin
      .from("reliability_study_items")
      .select("id")
      .eq("study_id", studyId)
      .eq("submission_id", submissionId)
      .maybeSingle();
    if (!item) return c.json({ error: "Submission is not in this study" }, 404);

    const { data: imagesRaw } = await supabaseAdmin
      .from("submission_images")
      .select("id, image_type, storage_path, display_order")
      .eq("submission_id", submissionId)
      .order("display_order", { ascending: true });
    const images = (imagesRaw ?? []) as Array<{
      id: string;
      image_type: string;
      storage_path: string;
      display_order: number;
    }>;

    // Batch-sign (≤ 900s; private bucket — US-276).
    let signed: Record<string, string> = {};
    if (images.length > 0) {
      const { data: urls } = await supabaseAdmin.storage
        .from("submission-images")
        .createSignedUrls(images.map((i) => i.storage_path), REVIEW_IMAGE_TTL);
      signed = Object.fromEntries(
        (urls ?? [])
          .map((u, idx) => [images[idx].id, u.signedUrl] as const)
          .filter(([, url]) => Boolean(url)),
      );
    }

    // Per-item-viewed audit trail (US-488) — written before the URLs are
    // handed out so the view is on record even if the response is dropped.
    await auditLog(c, "view_reliability_item", "submission", submissionId, {
      study_id: studyId,
      image_count: images.length,
    });

    return c.json({
      images: images.map((i) => minimizeReliabilityPhoto(i, signed[i.id] ?? null)),
    });
  },
);

// POST /reliability/studies/:id/ratings — submit/update the current reviewer's
// blind rating of one submission. Body: { submission_id, overall_score, ... }.
adminGradingRoutes.post("/reliability/studies/:id/ratings", async (c) => {
  const studyId = c.req.param("id");
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));

  const submissionId = typeof body.submission_id === "string" ? body.submission_id : "";
  const overall = Number(body.overall_score);
  if (!submissionId) return c.json({ error: "submission_id required" }, 400);
  if (!Number.isFinite(overall) || overall < 1 || overall > 10) {
    return c.json({ error: "overall_score must be 1.0–10.0" }, 400);
  }

  // Guard: the study must be open and contain this submission.
  const { data: study } = await supabaseAdmin
    .from("reliability_studies")
    .select("status")
    .eq("id", studyId)
    .maybeSingle();
  if (!study) return c.json({ error: "Study not found" }, 404);
  if (study.status !== "open") return c.json({ error: "Study is closed" }, 409);

  const { data: item } = await supabaseAdmin
    .from("reliability_study_items")
    .select("id")
    .eq("study_id", studyId)
    .eq("submission_id", submissionId)
    .maybeSingle();
  if (!item) return c.json({ error: "Submission is not in this study" }, 400);

  const optionalScore = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
  };

  const { error } = await supabaseAdmin
    .from("reliability_ratings")
    .upsert({
      study_id: studyId,
      submission_id: submissionId,
      reviewer_id: userId,
      overall_score: overall,
      fabric_condition_score: optionalScore(body.fabric_condition_score),
      structural_integrity_score: optionalScore(body.structural_integrity_score),
      cosmetic_appearance_score: optionalScore(body.cosmetic_appearance_score),
      functional_elements_score: optionalScore(body.functional_elements_score),
      odor_cleanliness_score: optionalScore(body.odor_cleanliness_score),
      notes: typeof body.notes === "string" ? body.notes : null,
    }, { onConflict: "study_id,submission_id,reviewer_id" });
  if (error) return failSafe(c, 500, "Couldn't save the rating.", error, "admin.grading.reliability.ratings");
  return c.json({ ok: true });
});

// POST /reliability/studies/:id/close — close a study to further ratings.
adminGradingRoutes.post("/reliability/studies/:id/close", async (c) => {
  const studyId = c.req.param("id");
  const { error } = await supabaseAdmin
    .from("reliability_studies")
    .update({ status: "closed" })
    .eq("id", studyId);
  if (error) return failSafe(c, 500, "Couldn't close the study.", error, "admin.grading.reliability.close");
  await auditLog(c, "close_reliability_study", "reliability_study", studyId, {});
  return c.json({ ok: true });
});

// POST /reliability/studies/:id/publish — mark/unmark a study as published to
// the public transparency report (US-866). Only the human-vs-human baseline of
// a CLOSED study should appear publicly, so publishing requires status=closed.
// Body: { published: boolean } (defaults to true).
adminGradingRoutes.post("/reliability/studies/:id/publish", async (c) => {
  const studyId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const published = body.published === undefined ? true : body.published === true;

  const { data: study, error: studyErr } = await supabaseAdmin
    .from("reliability_studies")
    .select("id, status")
    .eq("id", studyId)
    .maybeSingle();
  if (studyErr) return failSafe(c, 500, "Couldn't load the study.", studyErr, "admin.grading.reliability.publish.load");
  if (!study) return c.json({ error: "Study not found" }, 404);
  if (published && study.status !== "closed") {
    return c.json({ error: "Close the study before publishing it to transparency" }, 400);
  }

  const { error } = await supabaseAdmin
    .from("reliability_studies")
    .update({ published_to_transparency: published })
    .eq("id", studyId);
  if (error) return failSafe(c, 500, "Couldn't publish the study.", error, "admin.grading.reliability.publish");
  await auditLog(c, "publish_reliability_study", "reliability_study", studyId, {
    published,
  });
  return c.json({ ok: true, published });
});

// GET /reliability/studies/:id/report — compute the IRR report: human baseline,
// Krippendorff's alpha, and AI-vs-human-consensus comparison.
adminGradingRoutes.get("/reliability/studies/:id/report", async (c) => {
  const studyId = c.req.param("id");

  const { data: study, error: studyErr } = await supabaseAdmin
    .from("reliability_studies")
    .select("*")
    .eq("id", studyId)
    .maybeSingle();
  if (studyErr) return failSafe(c, 500, "Couldn't load the study report.", studyErr, "admin.grading.reliability.report");
  if (!study) return c.json({ error: "Study not found" }, 404);

  const { data: itemRows } = await supabaseAdmin
    .from("reliability_study_items")
    .select("submission_id")
    .eq("study_id", studyId);
  const submissionIds = (itemRows ?? []).map((r) => r.submission_id);

  const { data: ratingRows } = await supabaseAdmin
    .from("reliability_ratings")
    .select("submission_id, overall_score")
    .eq("study_id", studyId);

  // Group ratings by submission into the ItemRatings matrix irr.ts expects.
  const byItem = new Map<string, number[]>();
  for (const id of submissionIds) byItem.set(id, []);
  for (const r of ratingRows ?? []) {
    byItem.get(r.submission_id)?.push(Number(r.overall_score));
  }
  const items: ItemRatings[] = [...byItem.entries()].map(([item_id, scores]) => ({
    item_id,
    scores,
  }));

  // AI score per submission (the latest grade_report overall_score).
  const aiScores = new Map<string, number>();
  if (submissionIds.length > 0) {
    const { data: reports } = await supabaseAdmin
      .from("grade_reports")
      .select("submission_id, overall_score")
      .in("submission_id", submissionIds);
    for (const r of reports ?? []) {
      aiScores.set(r.submission_id, Number(r.overall_score));
    }
  }

  const report = computeIrrReport(items, aiScores, Number(study.tolerance));
  return c.json({ study, report });
});

// ── Human-review queue (US-775) ──────────────────────────────────────
//
// The low-confidence human-review loop, moved server-side. The old admin UI
// mutated grades via the browser Supabase client, which (1) couldn't reseal the
// certificate integrity hash (CERT_SIGNING_KEY is edge-only) so an adjusted
// grade's public certificate verified as 'mismatch', and (2) bypassed the MFA
// step-up every other money/grade-mutating admin action requires. These
// endpoints fix both: every adjust reseals the cert, every mutation is
// step-up-gated + audited.

const REVIEW_QUEUE_LIMIT = 200;
const REVIEW_IMAGE_TTL = 900; // ≤ 900s signed URLs for the private bucket (US-276).

// US-1293: a review claim older than this is stale (the operator walked away) and
// may be reclaimed, so a crashed/idle session never wedges an item in the queue.
// US-2505 moved the constant and the staleness rule into ../lib/review-claim.ts
// so the DECIDING routes enforce exactly the same rule /claim does, and so that
// rule is unit-testable without a DB.

// `confidence_label` is a computed CASE alias that lives ONLY in the
// public_certificate VIEW (migration 00082+), never as a grade_reports column —
// selecting it off the base table 42703s. Derive it in code from
// confidence_score using the SAME thresholds as the view so the queue matches
// the public certificate.
// US-2303: these literals are DELIBERATELY not the tunable review threshold.
// They are display buckets that must match the SQL view byte for byte — moving
// them with the gate would make the admin queue disagree with the public
// certificate about the same grade, which is a worse failure than a stale
// bucket boundary. Declared in confidence-threshold-sites_test.ts so a future
// sweep does not "fix" them.
function confidenceLabelFor(confidenceScore: number): string {
  if (confidenceScore >= 0.9) return "very_high";
  if (confidenceScore >= 0.75) return "high";
  if (confidenceScore >= 0.6) return "moderate";
  return "reviewed";
}

interface QueueReportRow {
  id: string;
  submission_id: string;
  overall_score: number;
  grade_tier: string;
  confidence_score: number;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string;
  needs_human_review: boolean;
  human_reviewed: boolean;
  review_claimed_by: string | null;
  review_claimed_at: string | null;
  review_due_at: string | null;
  created_at: string;
}

// GET /review-queue — EVERY preliminary grade awaiting human finalization
// (mandatory review). PRIORITY-ORDERED by review_due_at (= submit time + the
// requested grade-speed tier SLA), so express (1h) surfaces before premium (12h)
// before standard (48h), and an overdue item rises to the top. Returns
// per-factor scores, confidence, AI reasoning, the customer, the requested tier,
// and queue_age_seconds (oldest unreviewed) for SLA.
adminGradingRoutes.get("/review-queue", async (c) => {
  const viewerId = c.get("userId");
  const { data: reportsRaw, error } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "id, submission_id, overall_score, grade_tier, confidence_score, " +
        "fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, " +
        "functional_elements_score, odor_cleanliness_score, ai_summary, needs_human_review, " +
        "human_reviewed, review_claimed_by, review_claimed_at, review_due_at, created_at, " +
        "detailed_notes, defects_found",
    )
    // Every preliminary grade that hasn't been finalized or sent back yet.
    .eq("review_status", "pending")
    .eq("human_reviewed", false)
    .is("superseded_at", null)
    // Priority: earliest review-due first (tier SLA); fall back to age.
    .order("review_due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(REVIEW_QUEUE_LIMIT);

  if (error) {
    console.error("[admin-grading] review-queue query failed:", error);
    return c.json({ error: "Failed to load review queue" }, 500);
  }

  const reports = (reportsRaw ?? []) as unknown as QueueReportRow[];
  const submissionIds = reports.map((r) => r.submission_id);

  const subById = new Map<
    string,
    {
      id: string;
      user_id: string;
      title: string;
      garment_type: string;
      garment_category: string;
      service_tier: string | null;
      created_at: string;
    }
  >();
  const emailByUser = new Map<string, { email: string; full_name: string | null }>();
  if (submissionIds.length > 0) {
    const { data: subs } = await supabaseAdmin
      .from("submissions")
      .select("id, user_id, title, garment_type, garment_category, service_tier, created_at")
      .in("id", submissionIds);
    for (
      const s of (subs ?? []) as Array<{
        id: string;
        user_id: string;
        title: string;
        garment_type: string;
        garment_category: string;
        service_tier: string | null;
        created_at: string;
      }>
    ) {
      subById.set(s.id, s);
    }
    // Resolve both the submitter AND any current claimer in one users lookup.
    const userIds = [
      ...new Set([
        ...[...subById.values()].map((s) => s.user_id),
        ...reports.map((r) => r.review_claimed_by).filter((id): id is string => Boolean(id)),
      ]),
    ];
    if (userIds.length > 0) {
      const { data: users } = await supabaseAdmin
        .from("users")
        .select("id, email, full_name")
        .in("id", userIds);
      for (const u of (users ?? []) as Array<{ id: string; email: string; full_name: string | null }>) {
        emailByUser.set(u.id, { email: u.email, full_name: u.full_name });
      }
    }
  }

  // US-1558: information-value context — golden-set + exemplar coverage per
  // category, recent defect-combo frequencies, and the US-1557 calibrated
  // thresholds. Shared with the reorder_review_queue write tool (US-1658) so
  // the queue view and the agent's reorder rank identically.
  const infoCtx: ReviewInfoContext = await buildReviewInfoContext();

  const now = Date.now();
  const items = reports.map((r) => {
    const sub = subById.get(r.submission_id);
    const user = sub ? emailByUser.get(sub.user_id) : undefined;
    // A claim is "active" only while it's fresh; a stale claim (operator walked
    // away) is presented as reclaimable so the queue never wedges (US-1293).
    const claimAgeMs = r.review_claimed_at ? now - new Date(r.review_claimed_at).getTime() : null;
    const claimActive =
      Boolean(r.review_claimed_by) && claimAgeMs !== null && claimAgeMs < REVIEW_CLAIM_TTL_SEC * 1000;
    const claimer = claimActive && r.review_claimed_by ? emailByUser.get(r.review_claimed_by) : undefined;
    return {
      report_id: r.id,
      submission_id: r.submission_id,
      title: sub?.title ?? null,
      garment_type: sub?.garment_type ?? null,
      garment_category: sub?.garment_category ?? null,
      user_email: user?.email ?? null,
      user_name: user?.full_name ?? null,
      overall_score: Number(r.overall_score),
      grade_tier: r.grade_tier,
      confidence_score: Number(r.confidence_score),
      confidence_label: confidenceLabelFor(Number(r.confidence_score)),
      factor_scores: {
        fabric_condition_score: Number(r.fabric_condition_score),
        structural_integrity_score: Number(r.structural_integrity_score),
        cosmetic_appearance_score: Number(r.cosmetic_appearance_score),
        functional_elements_score: Number(r.functional_elements_score),
        odor_cleanliness_score: Number(r.odor_cleanliness_score),
      },
      ai_summary: r.ai_summary,
      // US-1536: the peer-norm outlier context ("similar items: median 6.5,
      // n=23"), when this grade was flagged. Reviewers see WHY it's here.
      peer_norm: ((r as unknown as { detailed_notes?: Record<string, string> | null })
        .detailed_notes?.peer_norm) ?? null,
      // US-1558: information-value ranking (active-learning routing) — the
      // score + the reviewer-facing reasons for why this item ranks high.
      ...(() => {
        const defects = (r as unknown as { defects_found?: unknown }).defects_found;
        const types = Array.isArray(defects)
          ? (defects as Array<{ defect_type?: string }>)
            .map((d) => d?.defect_type ?? "").filter(Boolean)
          : [];
        const iv = informationValue({
          garmentCategory: sub?.garment_category ?? null,
          confidence: Number(r.confidence_score),
          defectTypes: types,
        }, infoCtx);
        return {
          info_value: iv.score,
          info_factors: iv.factors,
          info_reasons: iv.reasons,
        };
      })(),
      created_at: r.created_at,
      waiting_ms: now - new Date(r.created_at).getTime(),
      // Mandatory-review priority signals: the requested grade-speed tier and the
      // SLA due time. overdue = past due (front of the queue).
      service_tier: sub?.service_tier ?? "standard",
      review_due_at: r.review_due_at,
      overdue: r.review_due_at ? new Date(r.review_due_at).getTime() < now : false,
      // Claim-lock state (US-1293): null when free/stale, else who holds it.
      claimed_by: claimActive ? r.review_claimed_by : null,
      claimed_by_me: claimActive && r.review_claimed_by === viewerId,
      claimed_by_email: claimer?.email ?? null,
      claimed_by_name: claimer?.full_name ?? null,
      claimed_at: claimActive ? r.review_claimed_at : null,
    };
  });

  // Queue age = how long the OLDEST unreviewed item has waited (for SLA alerting).
  const queueAgeSeconds = items.length > 0
    ? Math.floor(Math.max(...items.map((i) => i.waiting_ms)) / 1000)
    : 0;

  return c.json({ data: items, count: items.length, queue_age_seconds: queueAgeSeconds });
});

// GET /review/:id — full detail for one report incl. AI reasoning/tells and the
// submission photos as short-lived signed URLs (≤ 900s; private bucket).
adminGradingRoutes.get("/review/:id", async (c) => {
  const reportId = c.req.param("id");

  const { data: report, error } = await supabaseAdmin
    .from("grade_reports")
    .select("*")
    .eq("id", reportId)
    .maybeSingle();
  if (error || !report) return c.json({ error: "Report not found" }, 404);

  const r = report as { submission_id: string };
  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, title, garment_type, garment_category, created_at")
    .eq("id", r.submission_id)
    .maybeSingle();

  const { data: imagesRaw } = await supabaseAdmin
    .from("submission_images")
    .select("id, image_type, storage_path, display_order")
    .eq("submission_id", r.submission_id)
    .order("display_order", { ascending: true });
  const images = (imagesRaw ?? []) as Array<{
    id: string;
    image_type: string;
    storage_path: string;
    display_order: number;
  }>;

  // Batch-sign the photo paths (≤ 900s) instead of getPublicUrl on the private
  // bucket.
  let signed: Record<string, string> = {};
  if (images.length > 0) {
    const { data: urls } = await supabaseAdmin.storage
      .from("submission-images")
      .createSignedUrls(images.map((i) => i.storage_path), REVIEW_IMAGE_TTL);
    signed = Object.fromEntries(
      (urls ?? [])
        .map((u, idx) => [images[idx].id, u.signedUrl] as const)
        .filter(([, url]) => Boolean(url)),
    );
  }

  return c.json({
    report,
    submission: submission ?? null,
    images: images.map((i) => ({ ...i, signed_url: signed[i.id] ?? null })),
  });
});

// POST /review/:id/claim — take a soft, TTL-expiring lock so two operators
// don't work the same item (US-1293). Idempotent for the current holder; 409s
// when another operator holds a FRESH claim. A stale claim (older than the TTL)
// is reclaimable so a crashed/idle session never wedges the queue.
adminGradingRoutes.post("/review/:id/claim", async (c) => {
  const adminId = c.get("userId");
  const reportId = c.req.param("id");

  const { data: row, error } = await supabaseAdmin
    .from("grade_reports")
    .select("id, human_reviewed, review_claimed_by, review_claimed_at")
    .eq("id", reportId)
    .maybeSingle();
  if (error || !row) return c.json({ error: "Report not found" }, 404);
  const r = row as {
    human_reviewed: boolean | null;
    review_claimed_by: string | null;
    review_claimed_at: string | null;
  };

  if (r.human_reviewed) {
    return c.json({ error: "This grade has already been reviewed." }, 409);
  }

  const claimAgeMs = r.review_claimed_at
    ? Date.now() - new Date(r.review_claimed_at).getTime()
    : null;
  const claimActive =
    Boolean(r.review_claimed_by) && claimAgeMs !== null && claimAgeMs < REVIEW_CLAIM_TTL_SEC * 1000;
  if (claimActive && r.review_claimed_by !== adminId) {
    // Surface who holds it so the UI can label the lock.
    const { data: holder } = await supabaseAdmin
      .from("users")
      .select("email, full_name")
      .eq("id", r.review_claimed_by!)
      .maybeSingle();
    const h = holder as { email: string; full_name: string | null } | null;
    return c.json(
      {
        error: "Another operator is already reviewing this item.",
        code: "ALREADY_CLAIMED",
        claimed_by_email: h?.email ?? null,
        claimed_by_name: h?.full_name ?? null,
      },
      409,
    );
  }

  const claimedAt = new Date().toISOString();
  const { error: updErr } = await supabaseAdmin
    .from("grade_reports")
    .update({ review_claimed_by: adminId, review_claimed_at: claimedAt })
    .eq("id", reportId);
  if (updErr) return c.json({ error: "Failed to claim item" }, 500);

  await auditLog(c, "grading.review_claimed", "grade_report", reportId, {});
  return c.json({ ok: true, claimed_at: claimedAt });
});

// POST /review/:id/release — drop my claim so another operator can pick it up.
// Only the current holder can release (a no-op for anyone else).
adminGradingRoutes.post("/review/:id/release", async (c) => {
  const adminId = c.get("userId");
  const reportId = c.req.param("id");

  const { error } = await supabaseAdmin
    .from("grade_reports")
    .update({ review_claimed_by: null, review_claimed_at: null })
    .eq("id", reportId)
    .eq("review_claimed_by", adminId);
  if (error) return c.json({ error: "Failed to release claim" }, 500);
  return c.json({ ok: true });
});

// Load + validate a report for a mutating review action. Returns the row or a
// JSON error Response.
async function loadReportForReview(reportId: string) {
  const { data, error } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "id, submission_id, overall_score, grade_tier, ai_summary, buyer_writeup, certificate_id, " +
        "fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, " +
        "functional_elements_score, odor_cleanliness_score, coverage",
    )
    .eq("id", reportId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as {
    id: string;
    submission_id: string;
    overall_score: number;
    grade_tier: string;
    ai_summary: string;
    buyer_writeup: string | null;
    certificate_id: string | null;
    // US-1279: carried into a reseal so the integrity-v3 hash keeps matching.
    coverage:
      | { coverage_pct?: number | null; covered_zones?: string[] | null }
      | null;
  };
}

/**
 * US-2505: enforce the review claim on the DECIDING routes, not just on /claim.
 *
 * The TTL claim (US-1293) was advisory: /claim 409s when someone else holds the
 * item, but approve, adjust and send-back never looked. /admin/reviews doesn't
 * call /claim at all, so two operators — one on each admin page — could both
 * finalize the same report. `finalizeGradeReview` reports `alreadyFinal` so the
 * GRADE survived, but each decision inserted its own `human_reviews` row,
 * crediting one outcome to two reviewers in the table the adjust route feeds as
 * the self-improvement dataset.
 *
 * Same staleness rule as /claim: a claim older than the TTL is not a lock, so a
 * crashed session can never wedge the queue. An unclaimed report is allowed
 * through — claiming stays optional, it just becomes binding once taken.
 *
 * Returns a 409 Response to bail with, or null to proceed.
 */
async function assertClaimNotHeldByAnother(
  c: Parameters<typeof auditLog>[0],
  reportId: string,
  adminId: string,
): Promise<Response | null> {
  const { data, error } = await supabaseAdmin
    .from("grade_reports")
    .select("human_reviewed, review_claimed_by, review_claimed_at")
    .eq("id", reportId)
    .maybeSingle();
  // A read failure must not silently unlock the item — fail closed.
  if (error) {
    return c.json({ error: "Couldn't verify the review claim. Try again." }, 503);
  }
  if (!data) return null; // the caller's own 404 path reports a missing report

  const r = data as {
    human_reviewed: boolean | null;
    review_claimed_by: string | null;
    review_claimed_at: string | null;
  };

  const verdict = reviewClaimVerdict({
    humanReviewed: r.human_reviewed,
    claimedBy: r.review_claimed_by,
    claimedAt: r.review_claimed_at,
    adminId,
    nowMs: Date.now(),
  });
  if (verdict === "ok") return null;
  if (verdict === "already_reviewed") {
    return c.json(
      { error: "This grade has already been reviewed.", code: "ALREADY_REVIEWED" },
      409,
    );
  }

  const { data: holder } = await supabaseAdmin
    .from("users")
    .select("email, full_name")
    .eq("id", r.review_claimed_by)
    .maybeSingle();
  const h = holder as { email: string; full_name: string | null } | null;
  return c.json(
    {
      error: "Another operator is already reviewing this item.",
      code: "ALREADY_CLAIMED",
      claimed_by_email: h?.email ?? null,
      claimed_by_name: h?.full_name ?? null,
    },
    409,
  );
}

// POST /review/:id/approve — accept the AI grade as-is and FINALIZE it
// (mandatory review). Records the human review, then finalizeGradeReview makes
// the grade official: certificate goes live, the linked item goes 'graded', the
// seller is notified. No certified field changes → no reseal needed.
adminGradingRoutes.post("/review/:id/approve", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const adminId = c.get("userId");
  const reportId = c.req.param("id");
  const claimed = await assertClaimNotHeldByAnother(c, reportId, adminId);
  if (claimed) return claimed;

  let body: { notes?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "";

  const report = await loadReportForReview(reportId);
  if (!report) return c.json({ error: "Report not found" }, 404);

  const { error: revErr } = await supabaseAdmin.from("human_reviews").insert({
    grade_report_id: report.id,
    reviewer_id: adminId,
    original_score: report.overall_score,
    adjusted_score: null,
    review_notes: notes || "Approved AI grade as-is.",
  });
  if (revErr) {
    console.error("[admin-grading] approve: human_reviews insert failed:", revErr);
    return c.json({ error: "Failed to record review" }, 500);
  }

  // Finalize: flips review_status→approved, clears the review flags, advances the
  // submission to completed, and runs all the go-live wiring + seller notice.
  const result = await finalizeGradeReview(report.id, { reviewerId: adminId, modified: false });
  if (!result.ok) {
    return c.json({ error: "Grade report not found" }, 404);
  }

  await auditLog(c, "grading.review_approved", "grade_report", report.id, {
    submission_id: report.submission_id,
    original_score: report.overall_score,
    already_final: result.alreadyFinal ?? false,
  });
  return c.json({ ok: true, finalized: !result.alreadyFinal });
});

// POST /review/:id/adjust — correct the per-factor scores. Records the original
// AI grade + per-factor corrections for the self-improvement dataset (00050),
// updates the grade, and **reseals the certificate integrity hash** so the
// public certificate keeps verifying.
adminGradingRoutes.post("/review/:id/adjust", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const adminId = c.get("userId");
  const reportId = c.req.param("id");
  const claimed = await assertClaimNotHeldByAnother(c, reportId, adminId);
  if (claimed) return claimed;

  let body: {
    factors?: Partial<Record<keyof FactorScores, unknown>>;
    notes?: unknown;
    intentional_misread?: unknown;
  };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "";
  if (!notes) return c.json({ error: "Review notes are required for an adjustment" }, 400);

  const f = body.factors ?? {};
  const keys: (keyof FactorScores)[] = [
    "fabric_condition_score",
    "structural_integrity_score",
    "cosmetic_appearance_score",
    "functional_elements_score",
    "odor_cleanliness_score",
  ];
  const factors = {} as FactorScores;
  for (const k of keys) {
    const n = Number(f[k]);
    if (!Number.isFinite(n)) return c.json({ error: `Missing/invalid score: ${k}` }, 400);
    factors[k] = clampScore(n);
  }

  const report = await loadReportForReview(reportId);
  if (!report) return c.json({ error: "Report not found" }, 404);

  const overall = computeWeightedOverall(factors);
  const tier = scoreToGradeTier(overall);

  // US-478: enforce the >1.5-point rule SERVER-SIDE (the client only disables
  // the button). A large correction requires a super_admin and cannot be
  // bypassed by a direct API call.
  if (
    requiresSuperAdmin(report.overall_score, overall) &&
    c.get("adminRole") !== "super_admin"
  ) {
    return c.json(
      {
        error:
          "A grade change greater than 1.5 points requires super-admin approval.",
        code: "SUPER_ADMIN_REQUIRED",
      },
      403,
    );
  }

  const { error: revErr } = await supabaseAdmin.from("human_reviews").insert({
    grade_report_id: report.id,
    reviewer_id: adminId,
    original_score: report.overall_score, // the ORIGINAL AI grade (training signal)
    adjusted_score: overall,
    adjusted_fabric_condition: factors.fabric_condition_score,
    adjusted_structural_integrity: factors.structural_integrity_score,
    adjusted_cosmetic_appearance: factors.cosmetic_appearance_score,
    adjusted_functional_elements: factors.functional_elements_score,
    adjusted_odor_cleanliness: factors.odor_cleanliness_score,
    intentional_misread: body.intentional_misread === true,
    review_notes: notes,
  });
  if (revErr) {
    console.error("[admin-grading] adjust: human_reviews insert failed:", revErr);
    return c.json({ error: "Failed to record review" }, 500);
  }

  // Write the corrected scores, reseal the certificate over the NEW certified
  // fields (US-333/US-770), and VERIFY a row changed (US-474) — a 0-row update
  // must surface a real error, not a false success. The shared helper is the
  // single source of truth shared with dispute resolution.
  let resealed = false;
  try {
    const result = await applyGradeAdjustment(
      supabaseAdmin as unknown as CheckedUpdateClient,
      report,
      factors,
      { human_reviewed: true, needs_human_review: false, review_claimed_by: null, review_claimed_at: null },
    );
    resealed = result.resealed;
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Grade report not found or unchanged" }, 409);
    }
    console.error("[admin-grading] adjust: grade_reports update failed:", err);
    return c.json({ error: "Failed to update grade" }, 500);
  }

  // Finalize the corrected grade (mandatory review): mark it modified, advance
  // the submission to completed, run the go-live wiring, and notify the seller.
  const finalizeResult = await finalizeGradeReview(report.id, {
    reviewerId: adminId,
    modified: true,
  });
  if (!finalizeResult.ok) {
    return c.json({ error: "Grade report not found" }, 404);
  }

  // US-577: re-grade changed the score — evict the certificate's edge-cached SSR
  // page + share images AND the edge-stored rendered PNGs so the corrected grade
  // is served immediately.
  if (report.certificate_id) {
    invalidateCertificate(report.certificate_id).catch((e) =>
      console.warn("[admin-grading] cert cache invalidation failed:", e),
    );
  }

  await auditLog(c, "grading.review_adjusted", "grade_report", report.id, {
    submission_id: report.submission_id,
    original_score: report.overall_score,
    adjusted_score: overall,
    adjusted_factors: factors,
    intentional_misread: body.intentional_misread === true,
    resealed,
    notes,
  });
  return c.json({ ok: true, overall_score: overall, grade_tier: tier, resealed });
});

// POST /review/:id/send-back — the photos can't support a reliable grade. Set
// the submission to needs_photos (the seller adds clearer photos + resubmits),
// withhold the certificate, and record the review.
adminGradingRoutes.post("/review/:id/send-back", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const adminId = c.get("userId");
  const reportId = c.req.param("id");
  const claimed = await assertClaimNotHeldByAnother(c, reportId, adminId);
  if (claimed) return claimed;

  let body: { notes?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "";

  const report = await loadReportForReview(reportId);
  if (!report) return c.json({ error: "Report not found" }, 404);

  const { error: revErr } = await supabaseAdmin.from("human_reviews").insert({
    grade_report_id: report.id,
    reviewer_id: adminId,
    original_score: report.overall_score,
    adjusted_score: null,
    review_notes: notes || "Sent back for better photos.",
  });
  if (revErr) {
    console.error("[admin-grading] send-back: human_reviews insert failed:", revErr);
    return c.json({ error: "Failed to record review" }, 500);
  }

  // Withhold the certificate so a needs_photos item isn't publicly certified,
  // and clear the review flag.
  await supabaseAdmin
    .from("grade_reports")
    .update({
      certificate_id: null,
      needs_human_review: false,
      human_reviewed: true,
      review_claimed_by: null,
      review_claimed_at: null,
    })
    .eq("id", report.id);

  // Cert goes dark — drop its edge-stored rendered images (they'd otherwise linger).
  if (report.certificate_id) {
    deleteCertImages(report.certificate_id).catch(() => {});
  }

  // Move the submission to needs_photos with a reviewer-facing prompt.
  await supabaseAdmin
    .from("submissions")
    .update({
      status: "needs_photos",
      quality_feedback: {
        summary:
          "A reviewer determined the photos weren't clear enough to grade reliably. " +
          "Please retake the flagged photos and resubmit — you weren't charged.",
        photo_requests: notes ? [notes] : [],
        assessed_at: new Date().toISOString(),
      },
    })
    .eq("id", report.submission_id);

  await auditLog(c, "grading.review_sent_back", "grade_report", report.id, {
    submission_id: report.submission_id,
    notes,
  });
  return c.json({ ok: true });
});

// ── Reject-and-regrade (US-479) ──────────────────────────────────────
//
// POST /submissions/:id/regrade — re-run the grading pipeline for a submission
// and SUPERSEDE the prior report. Replaces the old admin "re-trigger grading"
// browser write, which only set status='processing' and re-ran nothing — so the
// submission hung in 'processing' forever with no worker. The server endpoint
// supersedes the active report(s), resets the row so the pipeline can re-claim
// it, and re-invokes processSubmission in-process (the edge service IS the
// worker). The submission reaches a terminal status (completed/failed); the
// stuck/stranded-paid sweeps are the backstop if the container dies mid-grade.
//
// Inherits authMiddleware + adminAuthMiddleware (admin JWT + standing AAL2) from
// the /api/admin/* group — same gate as moderation reject (which also fails a
// grade); no extra step-up, consistent with that action.
adminGradingRoutes.post("/submissions/:id/regrade", async (c) => {
  const id = c.req.param("id");
  const result = await regradeSubmission(id, defaultRegradeStore);
  if (!result.ok) return c.json({ error: result.error }, result.status as 404);

  await auditLog(c, "grading.regrade", "submission", id, {
    previous_status: result.previousStatus,
    superseded_report_ids: result.supersededReportIds,
    title: result.title,
  });
  return c.json({ ok: true, superseded: result.supersededReportIds.length });
});

// POST /submissions/:id/mark-failed — give up on a submission wedged in
// 'processing' (US-2376). The manual counterpart to the poison-orphan sweep:
// same operation, run by a human who doesn't want to wait for the attempt
// budget to burn down.
//
// It calls the SAME failUngradedSubmission the sweep does, so all three steps
// happen: the status flips, the charge for the ungraded submission is reversed,
// and the FlipDesk bridge link stops hanging at "processing". The browser-side
// version this replaces did only the first of those — it left the customer
// charged for a grade they never received — and in fact did none of them, since
// there is no admin UPDATE policy on public.submissions, so RLS matched zero
// rows while PostgREST reported success.
//
// The helper re-asserts status='processing' in the UPDATE, so a grade that
// finished in the race window between the admin opening the dialog and
// confirming it is left alone and reported back as a conflict — never
// double-refunded. Same gate as regrade (admin + standing AAL2 + the router's
// grading:review scope); no extra step-up, matching the sibling action that
// also discards a grade run.
adminGradingRoutes.post("/submissions/:id/mark-failed", async (c) => {
  const id = c.req.param("id");

  const { data: submission, error: lookupErr } = await supabaseAdmin
    .from("submissions")
    .select("id, status, title")
    .eq("id", id)
    .maybeSingle();
  if (lookupErr) {
    return failSafe(c, 500, "Couldn't look up the submission.", lookupErr, "admin.grading.mark_failed.lookup");
  }
  if (!submission) return c.json({ error: "Submission not found" }, 404);

  const row = submission as { status: string; title: string | null };
  if (row.status !== "processing") {
    return c.json(
      {
        error: `Only a submission stuck in processing can be marked failed — this one is ${row.status}.`,
        status: row.status,
      },
      409,
    );
  }

  const owned = await failUngradedSubmission(
    id,
    "marked failed by an admin (stuck in processing)",
    "An admin marked this grade failed; the charge was reversed.",
  );
  if (!owned) {
    // It left 'processing' between the lookup and the claim — a grade landed.
    return c.json({ error: "The submission finished grading just now — nothing was changed." }, 409);
  }

  await auditLog(c, "grading.mark_failed", "submission", id, {
    previous_status: row.status,
    title: row.title,
    charge_reversed: true,
  });
  return c.json({ ok: true });
});

// ── US-1533: garment expectation baselines ──────────────────────────────────
//
// GET  /baselines?brand=&category=&limit=   — browse/search cached briefs
// PUT  /baselines/:id { brief }             — reviewer corrects a bad brief
//
// Reads in the grading pipeline are DB-fresh (no in-memory cache), so an edit
// here is live on the very next grade — the edit IS the cache invalidation.
adminGradingRoutes.get("/baselines", async (c) => {
  const brand = c.req.query("brand")?.trim().toLowerCase() || null;
  const category = c.req.query("category")?.trim().toLowerCase() || null;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50") || 50, 1), 200);

  let query = supabaseAdmin
    .from("garment_baselines")
    .select("id, brand, garment_category, style, brief, model, prompt_version, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (brand) query = query.ilike("brand", `%${brand}%`);
  if (category) query = query.eq("garment_category", category);

  const { data, error } = await query;
  if (error) {
    console.error("[admin-grading] baselines list failed:", error);
    return c.json({ error: "Failed to load baselines" }, 500);
  }
  return c.json({ baselines: data ?? [] });
});

adminGradingRoutes.put("/baselines/:id", async (c) => {
  // US-2353 AC2: this overwrites the expectation baseline the grader is
  // measured against. Moving the yardstick is how a regression stops looking
  // like one.
  {
    const stepUp = requireFreshStepUp(c);
    if (stepUp) return stepUp;
  }
  const id = c.req.param("id");
  let body: { brief?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (brief === "" || brief.length > 2000) {
    return c.json({ error: "brief must be a non-empty string of at most 2000 chars" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("garment_baselines")
    .update({ brief })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[admin-grading] baseline update failed:", error);
    return c.json({ error: "Failed to update baseline" }, 500);
  }
  if (!data) return c.json({ error: "Baseline not found" }, 404);

  await auditLog(c, "grading.baseline_edit", "garment_baseline", id, {
    brief_length: brief.length,
  });
  return c.json({ ok: true });
});

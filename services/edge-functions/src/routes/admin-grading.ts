import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import {
  computeAccuracySummary,
  computeConfidenceCalibration,
  computeOutcomeFeedback,
  computeWeeklyAccuracySummary,
  exportTrainingDataset,
} from "../lib/accuracy-tracking.ts";
import { activatePromptVersion, runEval } from "../lib/grading-eval.ts";
import { runGradingRegressionScan } from "../lib/grading-monitor.ts";
import { computeIrrReport, type ItemRatings } from "../lib/irr.ts";

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

const STAGES = ["per_image", "composite"] as const;
type Stage = (typeof STAGES)[number];

// Map a 1.0–10.0 score to its grade_tier (mirrors ai-grading.scoreToGradeTier).
function scoreToTier(score: number): string {
  if (score >= 10.0) return "NWT";
  if (score >= 9.0) return "NWOT";
  if (score >= 8.0) return "Excellent";
  if (score >= 7.0) return "Very Good";
  if (score >= 6.0) return "Good";
  if (score >= 5.0) return "Fair";
  return "Poor";
}

// ── Accuracy ───────────────────────────────────────────────────────

// GET /accuracy?period=week  — aggregate accuracy metrics.
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

// GET /accuracy/outcomes — post-sale feedback (dispute rate + grade↔price) per category.
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

// GET /training-export — JSONL of human-reviewed grades for offline analysis /
// few-shot exemplar curation. Returns text/plain so it downloads cleanly.
adminGradingRoutes.get("/training-export", async (c) => {
  try {
    const jsonl = await exportTrainingDataset();
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
  if (error) return c.json({ error: error.message }, 500);
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
  if (error) return c.json({ error: error.message }, 400);

  await auditLog(c, "create_prompt_version", "ai_prompt_version", data.id, {
    version_name: versionName,
    stage,
    garment_scope: body.garment_scope ?? null,
  });
  return c.json({ prompt: data }, 201);
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

// POST /prompts/:id/activate — promote to active. Gated: requires a passing eval.
adminGradingRoutes.post("/prompts/:id/activate", async (c) => {
  const id = c.req.param("id");
  const result = await activatePromptVersion(id);
  if (!result.ok) return c.json({ error: result.reason }, 422);
  await auditLog(c, "activate_prompt_version", "ai_prompt_version", id, {});
  return c.json({ ok: true });
});

// POST /prompts/:id/deactivate — turn off an active prompt (reverts to code default).
adminGradingRoutes.post("/prompts/:id/deactivate", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .update({ is_active: false })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  await auditLog(c, "deactivate_prompt_version", "ai_prompt_version", id, {});
  return c.json({ ok: true });
});

// ── Eval cases (golden set) ──────────────────────────────────────────

// GET /eval/cases — list golden cases.
adminGradingRoutes.get("/eval/cases", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("grading_eval_cases")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ cases: data ?? [] });
});

// POST /eval/cases — add a golden case. images is [{ image_type, storage_path }].
adminGradingRoutes.post("/eval/cases", async (c) => {
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
  if (error) return c.json({ error: error.message }, 400);

  await auditLog(c, "create_eval_case", "grading_eval_case", data.id, { label });
  return c.json({ case: data }, 201);
});

// POST /eval/cases/promote — promote a corrected grade into a CANDIDATE eval
// case (is_active=false, pending approval). US-329: the self-improvement loop.
// Body: { grade_report_id, source?: "human_review" | "dispute" }. Idempotent —
// one candidate per grade report (dedup on source_grade_report_id).
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

  // Dedup: skip if a candidate already exists for this grade report.
  const { data: existing } = await supabaseAdmin
    .from("grading_eval_cases")
    .select("id")
    .eq("source_grade_report_id", reportId)
    .maybeSingle();
  if (existing) {
    return c.json({ ok: true, already: true, case_id: (existing as { id: string }).id });
  }

  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select("id, overall_score, submission_id")
    .eq("id", reportId)
    .maybeSingle();
  if (!report) return c.json({ error: "Grade report not found" }, 404);

  // The corrected truth comes from the most recent human review (if any).
  const { data: review } = await supabaseAdmin
    .from("human_reviews")
    .select("adjusted_score, intentional_misread, reviewed_at")
    .eq("grade_report_id", reportId)
    .order("reviewed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const r = report as { overall_score: number; submission_id: string };
  const rv = review as { adjusted_score: number | null; intentional_misread: boolean | null } | null;
  const expectedScore =
    rv && typeof rv.adjusted_score === "number" ? rv.adjusted_score : r.overall_score;
  const intentionalMisread = rv?.intentional_misread === true;

  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select("garment_type, garment_category, brand, title, description, style_attributes")
    .eq("id", r.submission_id)
    .maybeSingle();
  if (!submission) return c.json({ error: "Submission not found" }, 404);
  const s = submission as {
    garment_type: string;
    garment_category: string;
    brand: string | null;
    title: string;
    description: string | null;
    style_attributes: string[] | null;
  };

  const { data: imgs } = await supabaseAdmin
    .from("submission_images")
    .select("image_type, storage_path")
    .eq("submission_id", r.submission_id)
    .order("display_order", { ascending: true });
  const images = (imgs ?? []).map((i) => ({
    image_type: (i as { image_type: string }).image_type,
    storage_path: (i as { storage_path: string }).storage_path,
  }));
  if (images.length === 0) {
    return c.json({ error: "Submission has no images to build a case from" }, 422);
  }

  const label = `${s.brand ? s.brand + " " : ""}${s.title}`.slice(0, 120).trim();
  const tags = [
    s.garment_category,
    ...(intentionalMisread ? ["intentional_misread"] : []),
    source,
  ];
  const notes =
    `Auto-promoted from ${source} (${new Date().toISOString().slice(0, 10)}). ` +
    `AI ${r.overall_score} → corrected ${expectedScore}.` +
    (intentionalMisread ? " Flagged intentional-design misread." : "") +
    " Pending approval before it counts toward the eval gate.";

  const { data: inserted, error } = await supabaseAdmin
    .from("grading_eval_cases")
    .insert({
      label,
      garment_type: s.garment_type,
      garment_category: s.garment_category,
      brand: s.brand,
      description: s.description,
      style_attributes: Array.isArray(s.style_attributes) ? s.style_attributes : [],
      images,
      expected_score: expectedScore,
      expected_tier: scoreToTier(expectedScore),
      tags,
      is_active: false,
      notes,
      source_grade_report_id: reportId,
      source,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) return c.json({ error: error.message }, 400);

  await auditLog(c, "promote_eval_candidate", "grading_eval_case", inserted.id, {
    source,
    grade_report_id: reportId,
    expected_score: expectedScore,
    intentional_misread: intentionalMisread,
  });
  return c.json({ ok: true, case_id: inserted.id }, 201);
});

// PATCH /eval/cases/:id — edit an eval case (whitelist of mutable fields).
adminGradingRoutes.patch("/eval/cases/:id", async (c) => {
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

  const { data, error } = await supabaseAdmin
    .from("grading_eval_cases")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 400);

  await auditLog(c, "update_eval_case", "grading_eval_case", id, { fields: Object.keys(update) });
  return c.json({ case: data });
});

// DELETE /eval/cases/:id
adminGradingRoutes.delete("/eval/cases/:id", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabaseAdmin.from("grading_eval_cases").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  await auditLog(c, "delete_eval_case", "grading_eval_case", id, {});
  return c.json({ ok: true });
});

// GET /eval/runs — recent eval runs.
adminGradingRoutes.get("/eval/runs", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("grading_eval_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ runs: data ?? [] });
});

// ── Regression monitor (US-327) ──────────────────────────────────────

// GET /monitor/runs — recent automated quality-monitor runs (drift/alerts).
adminGradingRoutes.get("/monitor/runs", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("grading_monitor_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return c.json({ error: error.message }, 500);
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
  if (error) return c.json({ error: error.message }, 500);
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
  if (error) return c.json({ error: error.message }, 500);

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
  if (error) return c.json({ error: error.message }, 500);
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

  // Return only the garment metadata + images needed to grade — never the
  // grade_report (AI score) or anyone else's rating.
  let queue: unknown[] = [];
  if (todo.length > 0) {
    const { data: subs } = await supabaseAdmin
      .from("submissions")
      .select("id, garment_type, garment_category, brand, title, description")
      .in("id", todo);
    queue = subs ?? [];
  }
  return c.json({ remaining: todo.length, total: allIds.length, queue });
});

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
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// POST /reliability/studies/:id/close — close a study to further ratings.
adminGradingRoutes.post("/reliability/studies/:id/close", async (c) => {
  const studyId = c.req.param("id");
  const { error } = await supabaseAdmin
    .from("reliability_studies")
    .update({ status: "closed" })
    .eq("id", studyId);
  if (error) return c.json({ error: error.message }, 500);
  await auditLog(c, "close_reliability_study", "reliability_study", studyId, {});
  return c.json({ ok: true });
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
  if (studyErr) return c.json({ error: studyErr.message }, 500);
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

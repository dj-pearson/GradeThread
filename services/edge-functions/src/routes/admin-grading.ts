import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  computeAccuracySummary,
  computeOutcomeFeedback,
  computeWeeklyAccuracySummary,
  exportTrainingDataset,
} from "../lib/accuracy-tracking.ts";
import { activatePromptVersion, runEval } from "../lib/grading-eval.ts";

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

async function auditLog(
  adminUserId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin.from("admin_audit_log").insert({
    admin_user_id: adminUserId,
    action,
    target_type: targetType,
    target_id: targetId,
    details,
  });
  if (error) console.error("[admin-grading] audit log insert failed:", error.message);
}

const STAGES = ["per_image", "composite"] as const;
type Stage = (typeof STAGES)[number];

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
  const userId = c.get("userId");
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

  await auditLog(userId, "create_prompt_version", "ai_prompt_version", data.id, {
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
    await auditLog(userId, "run_prompt_eval", "ai_prompt_version", id, {
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
  const userId = c.get("userId");
  const id = c.req.param("id");
  const result = await activatePromptVersion(id);
  if (!result.ok) return c.json({ error: result.reason }, 422);
  await auditLog(userId, "activate_prompt_version", "ai_prompt_version", id, {});
  return c.json({ ok: true });
});

// POST /prompts/:id/deactivate — turn off an active prompt (reverts to code default).
adminGradingRoutes.post("/prompts/:id/deactivate", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const { error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .update({ is_active: false })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  await auditLog(userId, "deactivate_prompt_version", "ai_prompt_version", id, {});
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

  await auditLog(userId, "create_eval_case", "grading_eval_case", data.id, { label });
  return c.json({ case: data }, 201);
});

// PATCH /eval/cases/:id — edit an eval case (whitelist of mutable fields).
adminGradingRoutes.patch("/eval/cases/:id", async (c) => {
  const userId = c.get("userId");
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

  await auditLog(userId, "update_eval_case", "grading_eval_case", id, { fields: Object.keys(update) });
  return c.json({ case: data });
});

// DELETE /eval/cases/:id
adminGradingRoutes.delete("/eval/cases/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const { error } = await supabaseAdmin.from("grading_eval_cases").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  await auditLog(userId, "delete_eval_case", "grading_eval_case", id, {});
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

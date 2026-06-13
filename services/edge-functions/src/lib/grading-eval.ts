import { supabaseAdmin } from "./supabase.ts";
import {
  analyzeImage,
  compositeGrade,
  type GarmentInfo,
  invalidatePromptCache,
  type PerImageAnalysis,
  type ResolvedPrompt,
} from "./ai-grading.ts";
import { getGradingCompositeModel } from "./ai-config.ts";
import { runListingEval } from "./listing-eval.ts";

// ─── Eval harness + activation gate ─────────────────────────────────
//
// Scores a candidate prompt version against a golden set of expert-graded
// garments (grading_eval_cases) BEFORE it's allowed to go active. The set
// must include the cases that previously broke — distressed denim, raw hems,
// acid wash — so a prompt regression on intentional design is caught here
// instead of in production.

// Activation thresholds. A run must clear BOTH to pass. Tunable per-deploy.
function maxMae(): number {
  const raw = Number(Deno.env.get("EVAL_MAX_MAE"));
  return Number.isFinite(raw) && raw > 0 ? raw : 1.0;
}
function minAgreement(): number {
  const raw = Number(Deno.env.get("EVAL_MIN_AGREEMENT"));
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.7;
}

/** The published activation gate (max MAE / min agreement). Exported so the
 *  public transparency report and the regression monitor cite the SAME
 *  thresholds the activation gate enforces. */
export function evalThresholds(): { max_mae: number; min_agreement: number } {
  return { max_mae: maxMae(), min_agreement: minAgreement() };
}

interface EvalCaseRow {
  id: string;
  label: string;
  garment_type: string;
  garment_category: string;
  brand: string | null;
  description: string | null;
  style_attributes: string[] | null;
  images: Array<{ image_type: string; storage_path: string }>;
  expected_score: number;
  expected_tier: string;
  tags: string[] | null;
}

export interface EvalCaseResult {
  case_id: string;
  label: string;
  garment_category: string;
  tags: string[];
  expected_score: number;
  predicted_score: number | null;
  error: number | null;
  agreed: boolean;
  failed_reason?: string;
}

export interface EvalTagResult {
  tag: string;
  mean_absolute_error: number;
  agreement_rate: number;
  count: number;
}

export interface EvalRunResult {
  run_id: string | null;
  prompt_version_id: string;
  prompt_version_name: string;
  model: string;
  mean_absolute_error: number;
  agreement_rate: number;
  cases_total: number;
  cases_passed: number;
  passed: boolean;
  thresholds: { max_mae: number; min_agreement: number };
  per_case: EvalCaseResult[];
  per_tag: Record<string, EvalTagResult>;
}

// Chunked base64 (mirrors grading-pipeline.ts uint8ToBase64).
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

async function downloadCaseImage(
  storagePath: string,
): Promise<{ dataUri: string } | { error: string }> {
  const { data, error } = await supabaseAdmin.storage
    .from("submission-images")
    .download(storagePath);
  if (error || !data) {
    return { error: `download failed: ${error?.message ?? "no body"}` };
  }
  const buf = await data.arrayBuffer();
  const ext = storagePath.split(".").pop()?.toLowerCase() || "jpg";
  const mediaMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  const media = mediaMap[ext] || "image/jpeg";
  return { dataUri: `data:${media};base64,${uint8ToBase64(new Uint8Array(buf))}` };
}

/**
 * Run the active eval set against a candidate prompt version and persist a
 * grading_eval_runs row. The candidate's prompt_text overrides ONLY its stage
 * (per_image or composite); the other stage uses whatever is active. An empty
 * prompt_text (the seeded code-default rows) means "evaluate current default
 * behavior" — no override is applied for that stage.
 */
export async function runEval(
  promptVersionId: string,
  triggeredBy: string | null,
): Promise<EvalRunResult> {
  // Load the candidate prompt version.
  const { data: version, error: versionError } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, version_name, prompt_text, stage, garment_scope")
    .eq("id", promptVersionId)
    .single();
  if (versionError || !version) {
    throw new Error(`Prompt version not found: ${promptVersionId}`);
  }
  const v = version as {
    id: string;
    version_name: string;
    prompt_text: string | null;
    stage: "per_image" | "composite" | "listing_gen";
    garment_scope: string | null;
  };

  // US-311: listing_gen prompts have a separate eval path with golden
  // listing cases and listing-specific thresholds (title length, required
  // aspect coverage, price sanity) — not grading MAE/agreement. Dispatch to
  // listing-eval and return its result in the shared EvalRunResult shape.
  if (v.stage === "listing_gen") {
    return await runListingEval({
      promptVersionId: v.id,
      promptVersionName: v.version_name,
      promptText: v.prompt_text,
      triggeredBy,
    });
  }

  const override: ResolvedPrompt | undefined =
    v.prompt_text && v.prompt_text.trim().length > 0
      ? { text: v.prompt_text, versionName: v.version_name }
      : undefined;
  const perImageOverride = v.stage === "per_image" ? override : undefined;
  const compositeOverride = v.stage === "composite" ? override : undefined;

  // Load active eval cases, optionally scoped to the version's garment_scope.
  let casesQuery = supabaseAdmin
    .from("grading_eval_cases")
    .select(
      "id, label, garment_type, garment_category, brand, description, style_attributes, images, expected_score, expected_tier, tags",
    )
    .eq("is_active", true);
  if (v.garment_scope) {
    casesQuery = casesQuery.eq("garment_category", v.garment_scope);
  }
  const { data: cases, error: casesError } = await casesQuery;
  if (casesError) throw new Error(`Failed to load eval cases: ${casesError.message}`);
  if (!cases || cases.length === 0) {
    throw new Error(
      "No active eval cases" +
        (v.garment_scope ? ` for category "${v.garment_scope}"` : "") +
        ". Add golden cases before running the eval gate.",
    );
  }

  const model = getGradingCompositeModel();
  const perCase: EvalCaseResult[] = [];

  for (const row of cases as EvalCaseRow[]) {
    const styleHint = Array.isArray(row.style_attributes) ? row.style_attributes : [];
    try {
      const images = Array.isArray(row.images) ? row.images : [];
      if (images.length === 0) throw new Error("case has no images");

      // Per-image analysis (sequential to keep eval load modest).
      const perImage: PerImageAnalysis[] = [];
      for (const img of images) {
        const dl = await downloadCaseImage(img.storage_path);
        if ("error" in dl) throw new Error(`${img.storage_path}: ${dl.error}`);
        perImage.push(
          await analyzeImage(
            dl.dataUri,
            img.image_type,
            row.garment_type,
            row.garment_category,
            styleHint,
            perImageOverride,
          ),
        );
      }

      const garmentInfo: GarmentInfo = {
        garment_type: row.garment_type,
        garment_category: row.garment_category,
        brand: row.brand,
        title: row.label,
        description: row.description,
        style_attributes: styleHint,
      };
      const result = await compositeGrade(perImage, garmentInfo, compositeOverride);
      const error = Math.abs(result.overall_score - row.expected_score);

      perCase.push({
        case_id: row.id,
        label: row.label,
        garment_category: row.garment_category,
        tags: row.tags ?? [],
        expected_score: row.expected_score,
        predicted_score: result.overall_score,
        error,
        agreed: error <= 0.5,
      });
    } catch (err) {
      perCase.push({
        case_id: row.id,
        label: row.label,
        garment_category: row.garment_category,
        tags: row.tags ?? [],
        expected_score: row.expected_score,
        predicted_score: null,
        error: null,
        agreed: false,
        failed_reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Aggregate over cases that produced a prediction. A case that errored
  // (no prediction) counts against the pass rate but not the MAE average.
  const scored = perCase.filter((c) => c.error !== null);
  const mae =
    scored.length > 0
      ? scored.reduce((s, c) => s + (c.error ?? 0), 0) / scored.length
      : Number.POSITIVE_INFINITY;
  const casesPassed = perCase.filter((c) => c.agreed).length;
  const agreementRate = perCase.length > 0 ? casesPassed / perCase.length : 0;

  // Per-tag breakdown (distressed_denim, raw_hem, …).
  const tagBuckets = new Map<string, EvalCaseResult[]>();
  for (const c of perCase) {
    for (const tag of c.tags) {
      const arr = tagBuckets.get(tag) ?? [];
      arr.push(c);
      tagBuckets.set(tag, arr);
    }
  }
  const perTag: Record<string, EvalTagResult> = {};
  for (const [tag, arr] of tagBuckets) {
    const tagScored = arr.filter((c) => c.error !== null);
    perTag[tag] = {
      tag,
      mean_absolute_error:
        tagScored.length > 0
          ? tagScored.reduce((s, c) => s + (c.error ?? 0), 0) / tagScored.length
          : 0,
      agreement_rate: arr.length > 0 ? arr.filter((c) => c.agreed).length / arr.length : 0,
      count: arr.length,
    };
  }

  const thresholds = { max_mae: maxMae(), min_agreement: minAgreement() };
  const passed =
    Number.isFinite(mae) &&
    mae <= thresholds.max_mae &&
    agreementRate >= thresholds.min_agreement;

  // Persist the run.
  const { data: runRow, error: runError } = await supabaseAdmin
    .from("grading_eval_runs")
    .insert({
      prompt_version_id: v.id,
      prompt_version_name: v.version_name,
      model,
      mean_absolute_error: Number.isFinite(mae) ? Number(mae.toFixed(2)) : 99.99,
      agreement_rate: Number(agreementRate.toFixed(4)),
      cases_total: perCase.length,
      cases_passed: casesPassed,
      passed,
      per_case: perCase,
      per_tag: perTag,
      triggered_by: triggeredBy,
    })
    .select("id")
    .single();
  if (runError) {
    console.error("[grading-eval] failed to persist run:", runError.message);
  }

  // Record the latest eval outcome on the prompt version for the activation gate.
  const runId = runRow ? (runRow as { id: string }).id : null;
  await supabaseAdmin
    .from("ai_prompt_versions")
    .update({ eval_passed: passed, eval_run_id: runId })
    .eq("id", v.id);

  return {
    run_id: runId,
    prompt_version_id: v.id,
    prompt_version_name: v.version_name,
    model,
    mean_absolute_error: Number.isFinite(mae) ? Number(mae.toFixed(2)) : Number.POSITIVE_INFINITY,
    agreement_rate: Number(agreementRate.toFixed(4)),
    cases_total: perCase.length,
    cases_passed: casesPassed,
    passed,
    thresholds,
    per_case: perCase,
    per_tag: perTag,
  };
}

/**
 * Activation gate. A prompt version may go active only if its most recent eval
 * run passed. Returns { ok } or { ok:false, reason } for the admin route to
 * surface. Mutates is_active + deactivates the previous active prompt for the
 * same (stage, scope) inside a best-effort sequence.
 */
export async function activatePromptVersion(
  promptVersionId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data: version, error } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, stage, garment_scope, eval_passed")
    .eq("id", promptVersionId)
    .single();
  if (error || !version) return { ok: false, reason: "Prompt version not found" };

  const v = version as {
    id: string;
    stage: string;
    garment_scope: string | null;
    eval_passed: boolean | null;
  };

  if (v.eval_passed !== true) {
    return {
      ok: false,
      reason:
        "Prompt version has not passed the eval gate. Run the eval and clear the MAE/agreement thresholds before activating.",
    };
  }

  // Deactivate the current active prompt for the same stage + scope slot.
  let deactivateQuery = supabaseAdmin
    .from("ai_prompt_versions")
    .update({ is_active: false })
    .eq("stage", v.stage)
    .eq("is_active", true);
  deactivateQuery = v.garment_scope
    ? deactivateQuery.eq("garment_scope", v.garment_scope)
    : deactivateQuery.is("garment_scope", null);
  await deactivateQuery;

  const { error: activateError } = await supabaseAdmin
    .from("ai_prompt_versions")
    .update({ is_active: true })
    .eq("id", v.id);
  if (activateError) return { ok: false, reason: activateError.message };

  // US-571: purge the grading-prompt cache cluster-wide so the newly activated
  // version takes effect on every replica immediately, not after a local TTL.
  await invalidatePromptCache();

  return { ok: true };
}

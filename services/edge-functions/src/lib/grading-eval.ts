import { supabaseAdmin } from "./supabase.ts";
import {
  analyzeImage,
  compositeGrade,
  type CompositeGradeResult,
  type FactorScores,
  type GarmentInfo,
  invalidatePromptCache,
  type PerImageAnalysis,
  type ResolvedPrompt,
  unversionedPromptSurfaceHash,
} from "./ai-grading.ts";
import {
  type ActiveBlockVersion,
  activeBlockVersions,
  type BlockVersionRow,
  COVERED_BLOCK_KEYS,
  loadBlockVersion,
  PROMPT_BLOCK_KEYS,
  type PromptBlockKey,
  type PromptBlockOverrides,
} from "./prompt-blocks.ts";
import { isAllowedGradingModel, servingModelForStage } from "./ai-config.ts";
import { runListingEval } from "./listing-eval.ts";
import { scoreToGradeTier } from "./human-review.ts";
import { downloadGradingImage } from "./grading-image-encoding.ts";

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
  /**
   * US-2432: what this run did NOT test.
   *
   * A candidate's `prompt_text` overrides the SYSTEM prompt for its stage. The
   * USER message — garment-type and category criteria, the response schema, the
   * Rules block, the factor-weights line, the fabric criteria — is compiled into
   * the binary and is therefore IDENTICAL on both legs of the comparison. So a
   * pass certifies the system prompt against a user-message surface it never
   * varied and cannot report.
   *
   * `hash` fingerprints that surface. Two runs with different hashes measured
   * different prompts and must not be compared, however close their MAE looks.
   *
   * US-2438 changed `covered` from a constant `false` to the list of block keys
   * the registry can version — those are no longer ambient. It is a list rather
   * than a boolean because coverage is PARTIAL and saying so is the point: the
   * response schema and the Rules block are still compiled in with no identity,
   * so a `true` here would overstate the gate exactly the way the old comment
   * warned about.
   *
   * `blocks` closes the hole the seam opened in the hash. `hash` digests the CODE
   * DEFAULTS, so an ACTIVE block row silently changes what ran without moving it
   * — two runs under different block versions would read as comparable. Listing
   * the active overrides makes that visible. An empty list means the registry is
   * empty and the hash alone still describes the surface.
   */
  unversioned_surface: {
    hash: string;
    covered: readonly string[];
    blocks: ActiveBlockVersion[];
  };
}

/**
 * Eval's wrapper around the shared downloader: a failed case is REPORTED, never
 * thrown, so one unreadable photo drops that case instead of failing the run.
 *
 * The base64 + magic-byte logic used to be re-implemented here under a comment
 * saying it mirrored grading-pipeline.ts. It now lives in
 * grading-image-encoding.ts (US-2443) and there is one copy.
 */
export async function downloadCaseImage(
  storagePath: string,
): Promise<{ dataUri: string } | { error: string }> {
  try {
    return { dataUri: await downloadGradingImage(storagePath) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
  // US-1034: pin a specific (allowlisted) model for both grading stages so the
  // same golden cases can be scored under model A vs B; ignored if not allowed.
  modelOverride?: string,
  // US-2438 AC3: score a BLOCK candidate instead of a system-prompt candidate.
  // When set, `promptVersionId` is ignored — the system prompt stays whatever is
  // active, and exactly one user-message block is pinned to this row.
  blockCandidate?: { blockVersionId: string },
): Promise<EvalRunResult> {
  // ── The candidate, from either table ──
  //
  // Both drive the same four things: which stage to override, which garment
  // scope filters the cases, what to call the run, and which row gets the
  // pass/fail written back. So ONE loop serves both rather than a second copy of
  // the case runner — a fork here is how the two gates would come to disagree
  // about what "passed" means.
  let v: {
    id: string;
    version_name: string;
    prompt_text: string | null;
    stage: "per_image" | "composite" | "listing_gen";
    garment_scope: string | null;
  };
  let blockOverride: PromptBlockOverrides | undefined;
  let blockRow: BlockVersionRow | null = null;

  if (blockCandidate) {
    blockRow = await loadBlockVersion(blockCandidate.blockVersionId);
    if (!blockRow) {
      // Also the path for a row naming a block_key the resolver does not know.
      // Inert is right when SERVING (a typo must not take down grading) and
      // wrong at the GATE: scoring a row that can never serve records a pass for
      // a change that cannot take effect.
      throw new Error(
        `Prompt block version not found (or names an unknown block): ${blockCandidate.blockVersionId}`,
      );
    }
    // US-2438 AC2 — THE REFUSAL THAT WAS DOCUMENTED AND NOT ENFORCED.
    //
    // compositeGrade() carries a comment saying a block override is
    // "deliberately NOT accepted here yet". That decision was real and correct.
    // It was also only ever written down: this function reads `blockRow.stage`
    // and happily accepts a COMPOSITE block candidate, builds `blockOverride`
    // from it, and then passes that override to analyzeImage ONLY — the
    // per-image stage, whose prompt does not contain any composite block.
    //
    // So a composite block candidate ran the CHAMPION end to end and stamped the
    // result into grading_eval_runs under the candidate's own label. Not a
    // missing feature: a FALSE PASS, and the most expensive shape one can take
    // — a gate reporting that an unmeasured change qualified.
    //
    // Refused here until compositeGrade takes the override, because the honest
    // failure is loud. When it does, delete this block and thread `blockOverride`
    // into the compositeGrade call below; the prompt builder already accepts it
    // (buildCompositeUserPrompt's `blocks` parameter, US-2438 AC1).
    if (blockRow.stage === "composite") {
      throw new Error(
        `Block version ${blockRow.version_name} is a COMPOSITE block, and the eval ` +
          `gate cannot measure one yet: compositeGrade() does not accept a block ` +
          `override, so this run would score the champion and report it as the ` +
          `candidate. See US-2438 AC2. Per-image block candidates are supported.`,
      );
    }
    const text = (blockRow.block_text ?? "").trim();
    if (text.length === 0) {
      // An empty block_text means "the code default, under this version name" —
      // the prompt already in production. Running anyway stamps a pass on a row
      // that changes nothing, which later reads as a qualified change.
      throw new Error(
        `Block version ${blockRow.version_name} has empty block_text, which means ` +
          `"use the code default under this name". There is nothing for the gate ` +
          `to measure; activate it directly if that is the intent.`,
      );
    }
    blockOverride = {
      [blockRow.block_key as PromptBlockKey]: {
        text,
        versionName: blockRow.version_name,
      },
    };
    v = {
      id: blockRow.id,
      version_name:
        `block:${blockRow.block_key}[${blockRow.garment_scope ?? "*"}]=${blockRow.version_name}`,
      // Left null so BOTH stage overrides stay undefined below: a block eval
      // must not also pin a system prompt, or a pass cannot say which of the two
      // earned it.
      prompt_text: null,
      stage: blockRow.stage,
      garment_scope: blockRow.garment_scope,
    };
  } else {
    // Load the candidate prompt version.
    const { data: version, error: versionError } = await supabaseAdmin
      .from("ai_prompt_versions")
      .select("id, version_name, prompt_text, stage, garment_scope")
      .eq("id", promptVersionId)
      .single();
    if (versionError || !version) {
      throw new Error(`Prompt version not found: ${promptVersionId}`);
    }
    v = version as typeof v;
  }

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
    .eq("is_active", true)
    .is("deleted_at", null); // US-2037: retired cases never re-enter the gate.
  if (v.garment_scope) {
    // US-2438: which COLUMN a scope filters on is the block's decision, not a
    // constant. `ai_prompt_versions.garment_scope` has always been a
    // garment_category, but `garment_type_criteria` is scoped by garment_TYPE —
    // filtering that by category selects zero cases, and "no active eval cases"
    // reads as a missing golden set rather than as this bug.
    const column = blockRow &&
        PROMPT_BLOCK_KEYS[blockRow.block_key as PromptBlockKey].scopeDimension ===
          "garment_type"
      ? "garment_type"
      : "garment_category";
    casesQuery = casesQuery.eq(column, v.garment_scope);
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

  // US-2307: the eval runs on, and stamps, the model THIS STAGE will serve on.
  //
  // It used to be getGradingCompositeModel() for every stage, and the stamp is
  // what the activation gate later compares — so the two agreed with each other
  // while both being wrong for per_image, which serves on getDefaultModel().
  // A per_image prompt could be qualified on the composite model and then serve
  // every paid grade on a different one, with eval_passed reading true. That is
  // the exact hole US-2036 was filed to close, one stage over from where it was
  // closed.
  //
  // No-op unless GRADING_COMPOSITE_MODEL is set: without the override both
  // helpers return the same string. It only diverges when an operator has
  // deliberately split the models, which is precisely when the old behaviour
  // was already wrong.
  const model =
    modelOverride && isAllowedGradingModel(modelOverride)
      ? modelOverride
      : servingModelForStage(v.stage);
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
            modelOverride,
            // No bucketKey: an eval is not a customer submission, so it must
            // never take a canary slice — it has to measure the champion.
            undefined,
            "",
            blockOverride,
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
      const result = await compositeGrade(
        perImage,
        garmentInfo,
        compositeOverride,
        modelOverride,
        undefined, // bucketKey
        "", // baselineBlock
        [], // verificationImages
        true, // US-1643: eval measures the prompt — never the live exemplar block
      );
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

  // US-2432: state the blind spot out loud, next to the verdict it qualifies.
  //
  // Logged unconditionally rather than only on a pass, because the number a
  // reader most wants to compare is a FAILING run against the passing one that
  // preceded it — and if the surface moved between them, the delta they are
  // about to attribute to the prompt is not the prompt.
  const surfaceHash = unversionedPromptSurfaceHash();
  // US-2438: the hash digests the CODE DEFAULTS, so an active block row changes
  // what ran without moving it. Report the overrides beside it or the fingerprint
  // quietly starts lying about which runs are comparable.
  const activeBlocks = await activeBlockVersions(
    v.stage === "composite" ? "composite" : "per_image",
  );
  console.log(
    `[grading-eval] run ${v.version_name} (${v.stage}) — unversioned user-message ` +
      `surface ${surfaceHash}, NOT under test. Compare only against runs sharing ` +
      `this hash; a different one measured a different prompt.` +
      (activeBlocks.length > 0
        ? ` Active block overrides (versioned, and NOT part of that hash): ` +
          activeBlocks
            .map((b) => `${b.blockKey}[${b.garmentScope ?? "*"}]=${b.versionName}`)
            .join(", ") +
          `. Two runs differing here measured different prompts even with the same hash.`
        : ` No block overrides active.`),
  );

  // Persist the run.
  const { data: runRow, error: runError } = await supabaseAdmin
    .from("grading_eval_runs")
    .insert({
      // NULL for a block eval: v.id is an ai_prompt_block_versions id and this
      // column is an FK to ai_prompt_versions. The run is identified instead by
      // prompt_version_name, which carries the full
      // "block:<key>[<scope>]=<version>" label. No migration is needed — the
      // column has been nullable since 00050.
      prompt_version_id: blockRow ? null : v.id,
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
  //
  // US-2036: stamp WHICH model produced the pass. eval_passed alone is a naked
  // boolean — it says the prompt cleared the thresholds but not what it cleared
  // them WITH, so a later env change to the grading model inherited a pass it
  // never earned. qualified_model is cleared on a failing run so a stale pass
  // from an earlier model can't linger on the row.
  const runId = runRow ? (runRow as { id: string }).id : null;
  if (blockRow) {
    // The block table carries eval_passed/eval_run_id for exactly this. It has
    // no qualified_model, and that is not an oversight to paper over: a block
    // does not choose a model, it rides whichever one its stage serves on, so
    // US-2036's model stamp belongs on the stage's own prompt version.
    await supabaseAdmin
      .from("ai_prompt_block_versions")
      .update({ eval_passed: passed, eval_run_id: runId })
      .eq("id", blockRow.id);
  } else {
    await supabaseAdmin
      .from("ai_prompt_versions")
      .update({ eval_passed: passed, eval_run_id: runId, qualified_model: passed ? model : null })
      .eq("id", v.id);
  }

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
    unversioned_surface: {
      hash: surfaceHash,
      covered: COVERED_BLOCK_KEYS,
      blocks: activeBlocks,
    },
  };
}

// ─── US-590: single-submission prompt dry-run ───────────────────────
//
// The admin "Test prompt" action runs a candidate prompt against ONE chosen
// real submission and returns its grade side-by-side with the ACTIVE prompt's
// grade for the same submission, so an operator can eyeball the divergence
// before eval-gating/activating. Unlike runEval (the whole golden set, gated),
// this is an interactive spot-check — no persistence, no gate.

/** Flattened, UI-friendly view of a composite grade for the dry-run comparison. */
export interface DryRunGrade {
  overall_score: number;
  grade_tier: string;
  factor_scores: FactorScores;
  confidence_score: number;
  needs_human_review: boolean;
  ai_summary: string;
  defects_found: number;
  style_attributes: number;
  prompt_version: string;
}

export interface DryRunResult {
  submission: {
    id: string;
    title: string;
    garment_type: string;
    garment_category: string;
    image_count: number;
  };
  /** Which stage the candidate overrides; the other stage uses the active prompt. */
  stage: "per_image" | "composite";
  /** True when the candidate's prompt_text is empty (a code-default row) — the
   *  candidate and active grades are then expected to match. */
  candidate_uses_default: boolean;
  candidate: DryRunGrade;
  active: DryRunGrade;
}

function toDryRunGrade(r: CompositeGradeResult): DryRunGrade {
  return {
    overall_score: r.overall_score,
    grade_tier: r.grade_tier,
    factor_scores: r.factor_scores,
    confidence_score: r.confidence_score,
    needs_human_review: r.needs_human_review,
    ai_summary: r.ai_summary,
    defects_found: r.defects_found.length,
    style_attributes: r.style_attributes.length,
    prompt_version: r.prompt_version,
  };
}

/**
 * Grade ONE submission twice — once with the candidate prompt override and once
 * with the active prompt — and return both for side-by-side comparison.
 *
 * For a composite-stage candidate the per-image analyses are computed ONCE
 * (they're identical for both runs) and only the composite call is repeated, so
 * the override is the only thing that differs. For a per-image-stage candidate
 * the per-image pass itself changes, so it's run twice and each feeds its own
 * composite. listing_gen prompts are not gradeable here (use the listing eval).
 */
export async function runPromptDryRun(
  promptVersionId: string,
  submissionId: string,
): Promise<DryRunResult> {
  const { data: version, error: versionError } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, version_name, prompt_text, stage")
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
  };
  if (v.stage === "listing_gen") {
    throw new Error(
      "listing_gen prompts can't be grade-tested. Use the listing eval gate instead.",
    );
  }

  const { data: submission, error: subError } = await supabaseAdmin
    .from("submissions")
    .select("id, title, garment_type, garment_category, brand, description, style_attributes")
    .eq("id", submissionId)
    .single();
  if (subError || !submission) {
    throw new Error(`Submission not found: ${submissionId}`);
  }
  const s = submission as {
    id: string;
    title: string;
    garment_type: string;
    garment_category: string;
    brand: string | null;
    description: string | null;
    style_attributes: string[] | null;
  };

  const { data: imageRows, error: imgError } = await supabaseAdmin
    .from("submission_images")
    .select("image_type, storage_path, display_order")
    .eq("submission_id", submissionId)
    .order("display_order", { ascending: true });
  if (imgError) throw new Error(`Failed to load submission images: ${imgError.message}`);
  const images = (imageRows ?? []) as Array<{ image_type: string; storage_path: string }>;
  if (images.length === 0) {
    throw new Error("Submission has no images to grade.");
  }

  // Download each image once; both runs reuse the bytes.
  const downloaded: Array<{ image_type: string; dataUri: string }> = [];
  for (const img of images) {
    const dl = await downloadCaseImage(img.storage_path);
    if ("error" in dl) throw new Error(`${img.storage_path}: ${dl.error}`);
    downloaded.push({ image_type: img.image_type, dataUri: dl.dataUri });
  }

  const styleHint = Array.isArray(s.style_attributes) ? s.style_attributes : [];
  const garmentInfo: GarmentInfo = {
    garment_type: s.garment_type,
    garment_category: s.garment_category,
    brand: s.brand,
    title: s.title,
    description: s.description,
    style_attributes: styleHint,
  };

  const override: ResolvedPrompt | undefined =
    v.prompt_text && v.prompt_text.trim().length > 0
      ? { text: v.prompt_text, versionName: v.version_name }
      : undefined;

  const analyzeAll = async (o?: ResolvedPrompt): Promise<PerImageAnalysis[]> => {
    const out: PerImageAnalysis[] = [];
    for (const im of downloaded) {
      out.push(
        await analyzeImage(
          im.dataUri,
          im.image_type,
          s.garment_type,
          s.garment_category,
          styleHint,
          o,
        ),
      );
    }
    return out;
  };

  let candidate: CompositeGradeResult;
  let active: CompositeGradeResult;
  if (v.stage === "per_image") {
    const [perImageActive, perImageCandidate] = [
      await analyzeAll(undefined),
      await analyzeAll(override),
    ];
    // US-1643: suppress the live exemplar block on BOTH legs (the trailing
    // `true`) so the dry-run compares prompts, not exemplar presence.
    active = await compositeGrade(
      perImageActive, garmentInfo, undefined, undefined, undefined, "", [], true,
    );
    candidate = await compositeGrade(
      perImageCandidate, garmentInfo, undefined, undefined, undefined, "", [], true,
    );
  } else {
    // composite stage: per-image is shared; only the composite prompt differs.
    const perImage = await analyzeAll(undefined);
    active = await compositeGrade(
      perImage, garmentInfo, undefined, undefined, undefined, "", [], true,
    );
    candidate = await compositeGrade(
      perImage, garmentInfo, override, undefined, undefined, "", [], true,
    );
  }

  return {
    submission: {
      id: s.id,
      title: s.title,
      garment_type: s.garment_type,
      garment_category: s.garment_category,
      image_count: downloaded.length,
    },
    stage: v.stage,
    candidate_uses_default: override === undefined,
    candidate: toDryRunGrade(candidate),
    active: toDryRunGrade(active),
  };
}

/**
 * US-2300: THE gate that decides whether a prompt version may take live paid
 * traffic. One implementation, called by every path that routes traffic.
 *
 * There are two such paths and they drifted. `activatePromptVersion` carried
 * the full check; the CANARY route (admin-grading.ts) tested only
 * `eval_passed` and never even selected `qualified_model` — so a prompt
 * qualified on model A could serve a live slice of paying customers while
 * DEFAULT_AI_MODEL was model B. A canary is a smaller audience, not a lower
 * bar: the grades it produces are sold.
 *
 * Pure, so the rule can be tested without a database, and shared so a THIRD
 * path (a scheduled auto-promoter, a bulk tool) cannot quietly reintroduce the
 * gap. The lifecycle contract in the grading-engine skill is what this enforces.
 *
 * FAILS CLOSED on a missing stamp: an eval pass we cannot attribute to a model
 * is not a pass we can honour.
 */
export function checkPromptServingEligibility(
  v: { eval_passed: boolean | null; qualified_model: string | null },
  liveModel: string,
): { ok: true } | { ok: false; reason: string } {
  if (v.eval_passed !== true) {
    return {
      ok: false,
      reason:
        "Prompt version has not passed the eval gate. Run the eval and clear the MAE/agreement thresholds before serving traffic.",
    };
  }
  // US-2036: the pass must belong to the model that will actually serve traffic.
  // Without this, an operator could qualify a prompt on model A, change
  // DEFAULT_AI_MODEL to model B via env (no deploy, no eval, no audit entry),
  // and ship — every subsequent paid grade then comes from a model that never
  // cleared the MAE/agreement thresholds, while eval_passed still reads true.
  if (!v.qualified_model) {
    return {
      ok: false,
      reason:
        `This version's eval pass predates model attribution (US-2036), so we can't prove it was qualified on the live grading model (${liveModel}). Re-run the eval before serving traffic.`,
    };
  }
  if (v.qualified_model !== liveModel) {
    return {
      ok: false,
      reason:
        `Model mismatch: this version passed the eval on "${v.qualified_model}" but live grading runs "${liveModel}". Re-run the eval against the live model before serving traffic.`,
    };
  }
  return { ok: true };
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
    .select("id, stage, garment_scope, eval_passed, qualified_model")
    .eq("id", promptVersionId)
    .single();
  if (error || !version) return { ok: false, reason: "Prompt version not found" };

  const v = version as {
    id: string;
    stage: string;
    garment_scope: string | null;
    eval_passed: boolean | null;
    qualified_model: string | null;
  };

  // US-2300: one shared gate, so the canary route and this one cannot drift.
  // US-2307: compared against the model THIS STAGE serves on, not the composite
  // model for every stage. A listing_gen prompt runs on getDefaultModel(), so
  // gating it on the composite model proved the wrong thing — and refused it
  // outright once the two diverge.
  const eligible = checkPromptServingEligibility(v, servingModelForStage(v.stage));
  if (!eligible.ok) return eligible;

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

  // US-896: promoting to active = "promote canary to 100%". Clear the canary
  // flags so the now-champion is never ALSO routed to as a canary challenger.
  const { error: activateError } = await supabaseAdmin
    .from("ai_prompt_versions")
    .update({
      is_active: true,
      is_canary: false,
      rollout_percentage: 0,
      rollout_started_at: null,
    })
    .eq("id", v.id);
  if (activateError) return { ok: false, reason: activateError.message };

  // US-571: purge the grading-prompt cache cluster-wide so the newly activated
  // version takes effect on every replica immediately, not after a local TTL.
  await invalidatePromptCache();

  return { ok: true };
}

// ─── US-329 / US-1068: golden-set growth from corrections ───────────
//
// A corrected grade (reviewer-adjusted or dispute-resolved) is the highest-value
// kind of eval case — it's a real mistake the benchmark should defend against
// forever. promoteGradeReportToEvalCase turns ONE such grade report into a
// CANDIDATE eval case (is_active=false, pending admin approval). It is idempotent
// (dedup on source_grade_report_id) so re-running never multiplies the set.

export type PromoteEvalResult =
  | { ok: true; case_id: string; already: boolean }
  | { ok: false; status: number; error: string };

/**
 * Promote the corrected grade behind `gradeReportId` into a candidate golden
 * eval case. The expected (ground-truth) score is the reviewer's adjusted score
 * when present, else the AI's own score (an approved-as-is grade is still a
 * useful "we got this right" anchor). Extracted from the admin route so both the
 * single-promote endpoint and the batch high-signal sweep share one code path.
 */
export async function promoteGradeReportToEvalCase(
  gradeReportId: string,
  source: "human_review" | "dispute",
  createdBy: string | null,
): Promise<PromoteEvalResult> {
  // Dedup: at most one candidate per source grade report.
  const { data: existing } = await supabaseAdmin
    .from("grading_eval_cases")
    .select("id")
    .eq("source_grade_report_id", gradeReportId)
    .maybeSingle();
  if (existing) {
    return { ok: true, case_id: (existing as { id: string }).id, already: true };
  }

  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select("id, overall_score, submission_id")
    .eq("id", gradeReportId)
    .maybeSingle();
  if (!report) return { ok: false, status: 404, error: "Grade report not found" };
  const r = report as { overall_score: number; submission_id: string };

  // The corrected truth comes from the most recent human review (if any).
  const { data: review } = await supabaseAdmin
    .from("human_reviews")
    .select("adjusted_score, intentional_misread, reviewed_at")
    .eq("grade_report_id", gradeReportId)
    .order("reviewed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const rv = review as
    | { adjusted_score: number | null; intentional_misread: boolean | null }
    | null;
  const expectedScore =
    rv && typeof rv.adjusted_score === "number" ? rv.adjusted_score : r.overall_score;
  const intentionalMisread = rv?.intentional_misread === true;

  const { data: submission } = await supabaseAdmin
    .from("submissions")
    .select("garment_type, garment_category, brand, title, description, style_attributes")
    .eq("id", r.submission_id)
    .maybeSingle();
  if (!submission) return { ok: false, status: 404, error: "Submission not found" };
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
    return { ok: false, status: 422, error: "Submission has no images to build a case from" };
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
      expected_tier: scoreToGradeTier(expectedScore),
      tags,
      is_active: false,
      notes,
      source_grade_report_id: gradeReportId,
      source,
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (error) return { ok: false, status: 400, error: error.message };

  return { ok: true, case_id: (inserted as { id: string }).id, already: false };
}

/** A correction worth turning into a golden case: a flagged intentional-design
 *  misread, or a score the reviewer moved by at least `minDelta` points. An
 *  approved-as-is review (no adjusted score, no misread flag) is NOT high-signal
 *  — it adds no new failure mode. Pure + unit-tested. */
export function isHighSignalCorrection(
  review: {
    original_score: number;
    adjusted_score: number | null;
    intentional_misread: boolean | null;
  },
  minDelta: number,
): boolean {
  if (review.intentional_misread === true) return true;
  if (review.adjusted_score === null || review.adjusted_score === undefined) return false;
  return Math.abs(review.adjusted_score - review.original_score) >= minDelta;
}

export interface HighSignalPromoteOptions {
  /** Minimum |adjusted − original| points for a non-misread review to qualify. */
  minDelta?: number;
  /** Only scan reviews from the last N days. */
  sinceDays?: number;
  /** Cap how many candidates a single sweep promotes. */
  limit?: number;
  createdBy?: string | null;
}

export interface HighSignalPromoteResult {
  scanned: number;
  high_signal: number;
  promoted: number;
  already_present: number;
  skipped: number;
  candidates: Array<{ grade_report_id: string; case_id: string | null; status: string }>;
}

// Bound the review scan so one sweep stays a single cheap query even as the
// review corpus grows; the newest reviews are the ones worth harvesting.
const HIGH_SIGNAL_SCAN_CAP = 1_000;

/**
 * Batch the self-improvement loop: scan recent human reviews for high-signal
 * corrections and promote each into a candidate golden eval case so coverage
 * grows automatically from real mistakes. Idempotent end-to-end — dedup on the
 * source grade report means an already-harvested correction is counted as
 * `already_present`, never duplicated. Candidates still land inactive and must
 * pass the human review/approve step before they count toward the eval gate.
 */
export async function promoteHighSignalEvalCandidates(
  opts: HighSignalPromoteOptions = {},
): Promise<HighSignalPromoteResult> {
  const minDelta = Number.isFinite(opts.minDelta) && (opts.minDelta as number) > 0
    ? (opts.minDelta as number)
    : 1.0;
  const sinceDays = Number.isFinite(opts.sinceDays) && (opts.sinceDays as number) > 0
    ? (opts.sinceDays as number)
    : 30;
  const limit = Math.min(
    Math.max(Number.isFinite(opts.limit) ? (opts.limit as number) : 50, 1),
    200,
  );
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const { data: reviews, error } = await supabaseAdmin
    .from("human_reviews")
    .select("grade_report_id, original_score, adjusted_score, intentional_misread, reviewed_at")
    .gte("reviewed_at", since)
    .order("reviewed_at", { ascending: false })
    .limit(HIGH_SIGNAL_SCAN_CAP);
  if (error) throw new Error(`Failed to scan reviews: ${error.message}`);

  const rows = (reviews ?? []) as Array<{
    grade_report_id: string;
    original_score: number;
    adjusted_score: number | null;
    intentional_misread: boolean | null;
  }>;

  // One report can have several reviews; the query is newest-first so the first
  // time we see a report id carries its latest correction. Dedup to that.
  const seen = new Set<string>();
  const highSignalIds: string[] = [];
  for (const row of rows) {
    if (seen.has(row.grade_report_id)) continue;
    seen.add(row.grade_report_id);
    if (isHighSignalCorrection(row, minDelta)) highSignalIds.push(row.grade_report_id);
  }

  const result: HighSignalPromoteResult = {
    scanned: rows.length,
    high_signal: highSignalIds.length,
    promoted: 0,
    already_present: 0,
    skipped: 0,
    candidates: [],
  };

  for (const reportId of highSignalIds.slice(0, limit)) {
    const promoted = await promoteGradeReportToEvalCase(
      reportId,
      "human_review",
      opts.createdBy ?? null,
    );
    if (promoted.ok && promoted.already) {
      result.already_present++;
      result.candidates.push({ grade_report_id: reportId, case_id: promoted.case_id, status: "already_present" });
    } else if (promoted.ok) {
      result.promoted++;
      result.candidates.push({ grade_report_id: reportId, case_id: promoted.case_id, status: "promoted" });
    } else {
      result.skipped++;
      result.candidates.push({ grade_report_id: reportId, case_id: null, status: `skipped: ${promoted.error}` });
    }
  }

  return result;
}

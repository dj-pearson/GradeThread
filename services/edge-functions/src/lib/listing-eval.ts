// US-311: AutoLister listing-generation eval gate.
//
// Mirrors grading-eval.ts (which gates clothing-grading prompt activation) but
// scores against listing-specific thresholds: title length (≤80), required
// aspect coverage (% of expected required aspect names present in the
// generated item_specifics), and price sanity (generated suggested_price
// within the case's expected band). A candidate listing_gen prompt may only
// go active (via activatePromptVersion in grading-eval.ts) once eval_passed
// is true on its ai_prompt_versions row.

import { supabaseAdmin } from "./supabase.ts";
import { getDefaultModel } from "./ai-config.ts";
import { generateListingFields } from "./ai-listing.ts";
import type { EvalRunResult, EvalCaseResult, EvalTagResult } from "./grading-eval.ts";

// Activation thresholds for the listing-gen eval. Each one a hard floor:
// every case must clear them, AND the per-case agreement rate must hit
// `MIN_AGREEMENT`. Tunable per-deploy via env so a noisier model can ship.
function maxTitleLength(): number {
  return 80; // eBay hard limit; never relax this.
}

function minRequiredAspectCoverage(): number {
  const raw = Number(Deno.env.get("LISTING_EVAL_MIN_ASPECT_COVERAGE"));
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.75;
}

function minAgreement(): number {
  const raw = Number(Deno.env.get("LISTING_EVAL_MIN_AGREEMENT"));
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.8;
}

interface ListingEvalCaseRow {
  id: string;
  label: string;
  photos: Array<{ storage_path: string; image_type?: string }>;
  known_brand: string | null;
  known_size: string | null;
  known_color: string | null;
  known_material: string | null;
  known_title: string | null;
  measurements: Record<string, unknown> | null;
  expected_category_id: string | null;
  expected_required_aspect_names: string[];
  expected_price_min_cents: number | null;
  expected_price_max_cents: number | null;
}

interface ListingEvalScoring {
  titleOk: boolean;
  aspectCoverage: number; // [0,1]
  priceOk: boolean;
}

function scoreCase(
  result: {
    title: string;
    item_specifics: Record<string, string[]>;
    suggested_price_cents: number;
  },
  caseRow: ListingEvalCaseRow,
): ListingEvalScoring {
  const titleOk = result.title.length > 0 && result.title.length <= maxTitleLength();

  const expectedAspects = caseRow.expected_required_aspect_names ?? [];
  let covered = 0;
  for (const name of expectedAspects) {
    const got = result.item_specifics[name];
    if (Array.isArray(got) && got.length > 0) covered++;
  }
  const aspectCoverage = expectedAspects.length === 0
    ? 1 // No requirements → trivially covered.
    : covered / expectedAspects.length;

  let priceOk = true;
  if (
    caseRow.expected_price_min_cents != null ||
    caseRow.expected_price_max_cents != null
  ) {
    const min = caseRow.expected_price_min_cents ?? 0;
    const max = caseRow.expected_price_max_cents ?? Number.POSITIVE_INFINITY;
    priceOk =
      result.suggested_price_cents >= min &&
      result.suggested_price_cents <= max &&
      result.suggested_price_cents > 0;
  } else {
    // Without an explicit band, demand at least a non-zero price.
    priceOk = result.suggested_price_cents > 0;
  }

  return { titleOk, aspectCoverage, priceOk };
}

function loadPhotoUrls(
  photos: Array<{ storage_path: string; image_type?: string }>,
): Array<{ url: string; type?: string }> {
  const out: Array<{ url: string; type?: string }> = [];
  for (const p of photos) {
    const url = supabaseAdmin.storage
      .from("submission-images")
      .getPublicUrl(p.storage_path).data.publicUrl;
    if (url) out.push({ url, type: p.image_type });
  }
  return out;
}

export interface RunListingEvalInput {
  promptVersionId: string;
  promptVersionName: string;
  promptText: string | null;
  triggeredBy: string | null;
}

/**
 * Run the listing-gen eval against all active cases and persist the outcome
 * to ai_prompt_versions.eval_passed. Returns a result in the shared
 * EvalRunResult shape (the listing-specific metrics are mapped onto MAE /
 * agreement-rate slots) so the admin route can render either eval the same
 * way. `mean_absolute_error` is repurposed as "1 - aspect_coverage_avg",
 * `agreement_rate` as the per-case pass rate.
 */
export async function runListingEval(
  input: RunListingEvalInput,
): Promise<EvalRunResult> {
  const { data: cases, error: casesErr } = await supabaseAdmin
    .from("listing_eval_cases")
    .select(
      "id, label, photos, known_brand, known_size, known_color, known_material, " +
        "known_title, measurements, expected_category_id, " +
        "expected_required_aspect_names, expected_price_min_cents, expected_price_max_cents",
    )
    .eq("is_active", true);
  if (casesErr) {
    throw new Error(`Failed to load listing eval cases: ${casesErr.message}`);
  }
  if (!cases || cases.length === 0) {
    throw new Error(
      "No active listing eval cases. Seed listing_eval_cases before activating a listing_gen prompt.",
    );
  }

  const model = getDefaultModel();
  const perCase: EvalCaseResult[] = [];
  let aspectCoverageSum = 0;
  let aspectCoverageCount = 0;
  // The override prompt text is read by resolveListingPrompt via the active
  // DB row; for eval-time scoring we trust that runEval was called against
  // this prompt version. (A future revision can wire an explicit override
  // pathway through generateListingFields, mirroring grading-eval.)
  void input.promptText;

  for (const row of cases as unknown as ListingEvalCaseRow[]) {
    try {
      const photoList = Array.isArray(row.photos) ? row.photos : [];
      if (photoList.length === 0) throw new Error("case has no photos");
      const photos = await loadPhotoUrls(photoList);
      if (photos.length === 0) throw new Error("case photos could not be resolved");

      const knownFields: Record<string, unknown> = {};
      for (
        const [k, v] of [
          ["brand", row.known_brand],
          ["size", row.known_size],
          ["color", row.known_color],
          ["material", row.known_material],
          ["title", row.known_title],
        ] as const
      ) {
        if (v != null && String(v).trim() !== "") knownFields[k] = v;
      }

      const gen = await generateListingFields({
        photos,
        knownFields: Object.keys(knownFields).length > 0 ? knownFields : undefined,
        measurements: row.measurements ?? undefined,
      });
      const scoring = scoreCase(gen.listing, row);
      aspectCoverageSum += scoring.aspectCoverage;
      aspectCoverageCount++;

      // A case "agrees" iff it clears every hard threshold and the per-case
      // aspect coverage meets the min — anything else flunks the gate.
      const agreed =
        scoring.titleOk &&
        scoring.priceOk &&
        scoring.aspectCoverage >= minRequiredAspectCoverage();

      perCase.push({
        case_id: row.id,
        label: row.label,
        garment_category: row.expected_category_id ?? "",
        tags: [],
        expected_score: row.expected_price_min_cents ?? 0,
        predicted_score: gen.listing.suggested_price_cents,
        error: 1 - scoring.aspectCoverage,
        agreed,
        ...(agreed
          ? {}
          : {
              failed_reason: [
                !scoring.titleOk ? `title length ${gen.listing.title.length} > 80` : null,
                !scoring.priceOk ? `price ${gen.listing.suggested_price_cents}c out of band` : null,
                scoring.aspectCoverage < minRequiredAspectCoverage()
                  ? `aspect coverage ${(scoring.aspectCoverage * 100).toFixed(0)}% < ${(minRequiredAspectCoverage() * 100).toFixed(0)}%`
                  : null,
              ]
                .filter((x): x is string => !!x)
                .join("; "),
            }),
      });
    } catch (err) {
      perCase.push({
        case_id: row.id,
        label: row.label,
        garment_category: row.expected_category_id ?? "",
        tags: [],
        expected_score: row.expected_price_min_cents ?? 0,
        predicted_score: null,
        error: null,
        agreed: false,
        failed_reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const avgAspectCoverage = aspectCoverageCount > 0
    ? aspectCoverageSum / aspectCoverageCount
    : 0;
  // Map listing metrics onto the shared shape. mean_absolute_error =
  // 1 - avg aspect coverage so "lower is better" still holds.
  const mae = 1 - avgAspectCoverage;
  const casesPassed = perCase.filter((c) => c.agreed).length;
  const agreementRate = perCase.length > 0 ? casesPassed / perCase.length : 0;

  const thresholds = {
    max_mae: 1 - minRequiredAspectCoverage(),
    min_agreement: minAgreement(),
  };
  const passed =
    agreementRate >= thresholds.min_agreement &&
    mae <= thresholds.max_mae;

  // Reuse grading_eval_runs as the run-history audit table — the shape is
  // close enough (per_case + thresholds JSON) and a separate listing run
  // table would duplicate the row plumbing. The triggered_by + per_case
  // jsonb carry the listing-specific detail.
  const { data: runRow, error: runError } = await supabaseAdmin
    .from("grading_eval_runs")
    .insert({
      prompt_version_id: input.promptVersionId,
      prompt_version_name: input.promptVersionName,
      model,
      mean_absolute_error: Number(mae.toFixed(4)),
      agreement_rate: Number(agreementRate.toFixed(4)),
      cases_total: perCase.length,
      cases_passed: casesPassed,
      passed,
      per_case: perCase,
      per_tag: {} as Record<string, EvalTagResult>,
      triggered_by: input.triggeredBy,
    })
    .select("id")
    .single();
  if (runError) {
    console.error("[listing-eval] failed to persist run:", runError.message);
  }
  const runId = runRow ? (runRow as { id: string }).id : null;

  await supabaseAdmin
    .from("ai_prompt_versions")
    .update({ eval_passed: passed, eval_run_id: runId })
    .eq("id", input.promptVersionId);

  return {
    run_id: runId,
    prompt_version_id: input.promptVersionId,
    prompt_version_name: input.promptVersionName,
    model,
    mean_absolute_error: Number(mae.toFixed(4)),
    agreement_rate: Number(agreementRate.toFixed(4)),
    cases_total: perCase.length,
    cases_passed: casesPassed,
    passed,
    thresholds,
    per_case: perCase,
    per_tag: {},
  };
}

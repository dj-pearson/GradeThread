// US-1770: authenticity golden-set eval gate.
//
// Mirrors grading-eval.ts (runEval) for the brand-authenticity add-on: replay a
// labeled authentic-vs-counterfeit golden set through the authenticity pass
// (US-1769) and score how often the derived verdict matches the expert label,
// so a candidate authenticity prompt version must clear an accuracy gate BEFORE
// it activates for real users (shadow → eval → activate). Per-brand accuracy is
// tracked so a regression on one brand can block activation (AC3).
//
// The gate is deliberately strict on the ONE error that matters most: calling a
// KNOWN counterfeit "likely authentic" (a "dangerous miss"). Any dangerous miss
// fails the gate regardless of overall agreement — we would rather be
// inconclusive than confidently wrong on a fake.

import { supabaseAdmin } from "./supabase.ts";
import { getDefaultModel } from "./ai-config.ts";
import { downloadCaseImage } from "./grading-eval.ts";
import { assessAuthenticity, type AuthenticityVerdict } from "./ai-authenticity.ts";
import { getEffectiveTells } from "./brand-authenticity.ts";
import type { GarmentInfo } from "./ai-grading.ts";

export type ExpectedLabel = "authentic" | "counterfeit" | "inconclusive";

// Map the model's verdict onto the golden-set label vocabulary so they compare.
export function verdictToLabel(verdict: AuthenticityVerdict): ExpectedLabel {
  if (verdict === "likely_authentic") return "authentic";
  if (verdict === "red_flags") return "counterfeit";
  return "inconclusive";
}

// A case "agrees" when the derived verdict class equals the expert label.
export function caseAgrees(expected: ExpectedLabel, verdict: AuthenticityVerdict): boolean {
  return verdictToLabel(verdict) === expected;
}

// The worst error: a KNOWN counterfeit that the pass called likely-authentic.
export function isDangerousMiss(expected: ExpectedLabel, verdict: AuthenticityVerdict): boolean {
  return expected === "counterfeit" && verdict === "likely_authentic";
}

// Min overall agreement to pass. Env-tunable; conservative default.
export function authenticityEvalMinAgreement(): number {
  const raw = Number(Deno.env.get("AUTHENTICITY_EVAL_MIN_AGREEMENT"));
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.8;
}

export interface AuthenticityCaseResult {
  case_id: string;
  label: string;
  brand_key: string;
  expected_label: ExpectedLabel;
  verdict: AuthenticityVerdict | "error";
  verdict_confidence: number | null;
  agreed: boolean;
  dangerous_miss: boolean;
  error?: string;
}

export interface PerBrandAccuracy {
  total: number;
  agreed: number;
  dangerous_misses: number;
  agreement_rate: number;
}

export interface AuthenticityEvalResult {
  prompt_version: string;
  model: string;
  cases_total: number;
  cases_agreed: number;
  agreement_rate: number;
  dangerous_misses: number;
  passed: boolean;
  per_case: AuthenticityCaseResult[];
  per_brand: Record<string, PerBrandAccuracy>;
}

/**
 * Aggregate per-case results into overall + per-brand accuracy and the gate
 * decision. Pure + exported for tests. The gate passes only when overall
 * agreement clears the threshold AND there are zero dangerous misses.
 */
export function aggregateAuthenticityEval(
  perCase: AuthenticityCaseResult[],
  minAgreement: number,
): {
  cases_total: number;
  cases_agreed: number;
  agreement_rate: number;
  dangerous_misses: number;
  passed: boolean;
  per_brand: Record<string, PerBrandAccuracy>;
} {
  const total = perCase.length;
  const agreed = perCase.filter((c) => c.agreed).length;
  const dangerous = perCase.filter((c) => c.dangerous_miss).length;
  const rate = total > 0 ? agreed / total : 0;

  const per_brand: Record<string, PerBrandAccuracy> = {};
  for (const c of perCase) {
    const b = (per_brand[c.brand_key] ??= {
      total: 0,
      agreed: 0,
      dangerous_misses: 0,
      agreement_rate: 0,
    });
    b.total += 1;
    if (c.agreed) b.agreed += 1;
    if (c.dangerous_miss) b.dangerous_misses += 1;
  }
  for (const b of Object.values(per_brand)) {
    b.agreement_rate = b.total > 0 ? Number((b.agreed / b.total).toFixed(4)) : 0;
  }

  const passed = total > 0 && rate >= minAgreement && dangerous === 0;
  return {
    cases_total: total,
    cases_agreed: agreed,
    agreement_rate: Number(rate.toFixed(4)),
    dangerous_misses: dangerous,
    passed,
    per_brand,
  };
}

interface EvalCaseRow {
  id: string;
  label: string;
  brand_key: string;
  brand: string | null;
  garment_type: string | null;
  images: { image_type: string; storage_path: string }[];
  expected_label: ExpectedLabel;
}

/**
 * Run the active authenticity golden set through the authenticity pass and
 * persist an authenticity_eval_runs row. `promptVersionLabel` is recorded on the
 * run for attribution; the pass itself is grounded per-case in that brand's
 * structured tells (US-1768), matching the live grounded path (US-1769). Throws
 * if there are no active cases — the gate can't certify a prompt with no golden
 * set (never fabricate cases to make it pass).
 */
export async function runAuthenticityEval(
  promptVersionLabel: string,
  triggeredBy: string | null,
): Promise<AuthenticityEvalResult> {
  const { data: cases, error } = await supabaseAdmin
    .from("authenticity_eval_cases")
    .select("id, label, brand_key, brand, garment_type, images, expected_label")
    .eq("is_active", true);
  if (error) throw new Error(`Failed to load authenticity eval cases: ${error.message}`);
  if (!cases || cases.length === 0) {
    throw new Error("No active authenticity eval cases. Add labeled golden cases before running the gate.");
  }

  const model = getDefaultModel();
  const perCase: AuthenticityCaseResult[] = [];

  for (const row of cases as EvalCaseRow[]) {
    const base: Omit<AuthenticityCaseResult, "verdict" | "verdict_confidence" | "agreed" | "dangerous_miss"> = {
      case_id: row.id,
      label: row.label,
      brand_key: row.brand_key,
      expected_label: row.expected_label,
    };
    try {
      const images = Array.isArray(row.images) ? row.images : [];
      if (images.length === 0) throw new Error("case has no images");

      const dataUris: { imageType: string; dataUri: string }[] = [];
      for (const img of images) {
        const dl = await downloadCaseImage(img.storage_path);
        if ("error" in dl) throw new Error(`${img.storage_path}: ${dl.error}`);
        dataUris.push({ imageType: img.image_type, dataUri: dl.dataUri });
      }

      const tells = await getEffectiveTells(row.brand_key).catch(() => []);
      const garmentInfo: GarmentInfo = {
        garment_type: row.garment_type ?? "other",
        garment_category: "other",
        brand: row.brand,
        title: row.label,
        description: null,
        style_attributes: [],
      };
      const assessment = await assessAuthenticity(dataUris, garmentInfo, { tells });
      const agreed = caseAgrees(row.expected_label, assessment.verdict);
      perCase.push({
        ...base,
        verdict: assessment.verdict,
        verdict_confidence: assessment.verdict_confidence,
        agreed,
        dangerous_miss: isDangerousMiss(row.expected_label, assessment.verdict),
      });
    } catch (err) {
      perCase.push({
        ...base,
        verdict: "error",
        verdict_confidence: null,
        agreed: false,
        dangerous_miss: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const agg = aggregateAuthenticityEval(perCase, authenticityEvalMinAgreement());

  const result: AuthenticityEvalResult = {
    prompt_version: promptVersionLabel,
    model,
    cases_total: agg.cases_total,
    cases_agreed: agg.cases_agreed,
    agreement_rate: agg.agreement_rate,
    dangerous_misses: agg.dangerous_misses,
    passed: agg.passed,
    per_case: perCase,
    per_brand: agg.per_brand,
  };

  // Persist the run (best-effort — a logging failure never loses the verdict).
  const { error: insErr } = await supabaseAdmin.from("authenticity_eval_runs").insert({
    prompt_version: result.prompt_version,
    model: result.model,
    cases_total: result.cases_total,
    cases_agreed: result.cases_agreed,
    agreement_rate: result.agreement_rate,
    passed: result.passed,
    per_case: result.per_case,
    per_brand: result.per_brand,
    triggered_by: triggeredBy,
  });
  if (insErr) {
    console.error("[authenticity-eval] failed to persist run:", insErr.message);
  }

  return result;
}

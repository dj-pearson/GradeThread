// US-1770: authenticity golden-set eval gate.
//
// ⚠ STATUS (US-2130, 2026-07-19): PARTIALLY WIRED. Read this before trusting it.
//
//   NOW WIRED: authenticityGateStatus / assertAuthenticityPromptActivatable /
//   warnAuthenticityGate (below). main.ts warns at boot when a live authenticity
//   prompt has no passing eval run, so "ungated" is no longer silent.
//
//   STILL NOT ENFORCED: runAuthenticityEval does not BLOCK anything, because
//   authenticity prompts are code constants rather than ai_prompt_versions rows —
//   there is no activation call to intercept. assertAuthenticityPromptActivatable
//   exists so that when that path is built it fails closed by default.
//
//   STILL MISSING: the golden set itself. authenticity_eval_cases has no seed
//   rows, so runAuthenticityEval throws on first call and warnAuthenticityGate
//   will report ungated for every version until real labeled cases exist
//   (US-2131 — expert-dependent, cannot be generated).
//
// The history below is kept because it explains how a safety gate shipped
// green-tested and unenforced, which is the failure mode this module now guards.
//
// ↳ WAS REGISTERED AS UNWIRED: vault/70-agent/shipped-but-unwired.md — all six
//   exports had zero non-self callers (US-1996).
//
// US-1770 is marked passes:true in the archive while its OWN notes say
// "[DEFERRED 2026-07-09]" — it was deferred pending a held migration and closed
// anyway. runAuthenticityEval has zero callers outside this file's tests, and
// there is no authenticity prompt-activation path for it to gate (admin-grading.ts
// has no authenticity hooks at all).
//
// The unmet ACs are AC1 — a candidate authenticity prompt must clear an accuracy
// gate BEFORE activation — and AC3, per-brand regressions blocking activation.
// Neither is enforced by anything, because no authenticity prompt-activation path
// exists for this to gate.
//
// ⚠ CORRECTION (2026-07-18): an earlier version of this comment also claimed AC2's
// human-review routing was missing. That was WRONG. authenticityNeedsReview()
// in ai-authenticity.ts routes a red_flags verdict (or a low-confidence branded
// assessment) to a human, wired at grading-pipeline.ts:2054 and unit-tested. The
// mistake came from grepping red_flags, finding only the note site ~400 lines
// earlier, and not noticing the routing reaches the assessment through a helper
// rather than through that field. So the net that catches a bad CALL exists; what
// is missing is the gate that would stop a bad PROMPT VERSION shipping.
//
// Do not read this module's green tests as evidence the gate exists. Tracked in
// US-1996.
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
import {
  assessAuthenticity,
  AUTHENTICITY_PROMPT_VERSION,
  AUTHENTICITY_PROMPT_VERSION_GROUNDED,
  type AuthenticityVerdict,
} from "./ai-authenticity.ts";
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

// ── US-2130: the gate, and making an ungated prompt visible ─────────────────
//
// Authenticity prompts are CODE CONSTANTS (AUTHENTICITY_PROMPT_VERSION), not
// ai_prompt_versions rows, so there is no runtime activation call to intercept
// the way activatePromptVersion gates grading. Building that table + admin flow
// needs a migration (held). What ships here is the half that needs no schema
// change and closes the dangerous half of the gap:
//
//   1. authenticityGateStatus() — does the version actually serving traffic have
//      a PASSING eval run, on the model that will serve it?
//   2. assertAuthenticityPromptActivatable() — the fail-closed guard any future
//      activation path must call. It exists now so that path cannot be built
//      without it, which is exactly how US-1770 shipped ungated.
//   3. warnAuthenticityGate() — boot-time visibility, so "no gate" stops being
//      silent.
//
// Everything here FAILS CLOSED: a query error, a missing run, or a model
// mismatch all report ungated. Never infer "gated" from an absence.

export interface AuthenticityGateStatus {
  prompt_version: string;
  model: string;
  /** True only when a passing run exists for THIS version on THIS model. */
  gated: boolean;
  last_passing_run_at: string | null;
  agreement_rate: number | null;
  /** Why the gate is not satisfied. Null when gated. */
  reason: string | null;
}

/**
 * Does `promptVersion` have a passing authenticity eval run on `model`?
 *
 * Model is part of the key for the same reason as US-2036 on the grading side:
 * qualifying a prompt on model A and then switching DEFAULT_AI_MODEL to model B
 * via env is a no-deploy, no-eval, no-audit behavior change. A pass earned on a
 * model that is no longer serving is not a pass.
 */
export async function authenticityGateStatus(
  promptVersion: string,
  model: string = getDefaultModel(),
): Promise<AuthenticityGateStatus> {
  const { data, error } = await supabaseAdmin
    .from("authenticity_eval_runs")
    .select("agreement_rate, created_at")
    .eq("prompt_version", promptVersion)
    .eq("model", model)
    .eq("passed", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return gateStatusFromRun(
    promptVersion,
    model,
    data as PassingRunRow | null,
    error ? error.message : null,
  );
}

export interface PassingRunRow {
  agreement_rate: number;
  created_at: string;
}

/**
 * The gate decision, separated from the query so the fail-closed paths are
 * directly testable. Pure + exported for tests, mirroring aggregateAuthenticityEval.
 *
 * Both "no row" and "query failed" resolve to NOT gated. That asymmetry is the
 * whole point: a pass must be positively evidenced, never inferred from silence.
 */
export function gateStatusFromRun(
  promptVersion: string,
  model: string,
  row: PassingRunRow | null,
  queryError: string | null,
): AuthenticityGateStatus {
  const base: Omit<AuthenticityGateStatus, "gated" | "reason"> = {
    prompt_version: promptVersion,
    model,
    last_passing_run_at: null,
    agreement_rate: null,
  };

  if (queryError) {
    // An unreadable ledger is not evidence of a pass.
    return { ...base, gated: false, reason: `Could not read eval runs: ${queryError}` };
  }
  if (!row) {
    return {
      ...base,
      gated: false,
      reason:
        `No passing authenticity eval run for "${promptVersion}" on model "${model}". ` +
        `Run the gate against a labeled golden set before this version serves users.`,
    };
  }

  return {
    ...base,
    gated: true,
    last_passing_run_at: row.created_at,
    agreement_rate: Number(row.agreement_rate),
    reason: null,
  };
}

/**
 * Fail-closed guard for any authenticity prompt-activation path.
 *
 * Mirrors activatePromptVersion's eval_passed check. Call this BEFORE promoting
 * an authenticity prompt version — it refuses by default, so a future activation
 * route cannot ship ungated by omission.
 */
export async function assertAuthenticityPromptActivatable(
  promptVersion: string,
  model: string = getDefaultModel(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const status = await authenticityGateStatus(promptVersion, model);
  return status.gated
    ? { ok: true }
    : { ok: false, reason: status.reason ?? "Authenticity eval gate not satisfied." };
}

/**
 * Boot-time visibility for an ungated live authenticity prompt.
 *
 * Deliberately best-effort and non-throwing: a boot guard that can fail is how
 * the schema-version check once crash-looped the whole edge service (US-778).
 * This warns and returns; it never blocks startup and never rejects.
 */
export async function warnAuthenticityGate(
  versions: string[] = [AUTHENTICITY_PROMPT_VERSION, AUTHENTICITY_PROMPT_VERSION_GROUNDED],
): Promise<void> {
  try {
    const model = getDefaultModel();
    for (const v of versions) {
      const status = await authenticityGateStatus(v, model);
      if (!status.gated) {
        console.warn(
          `[BOOT] authenticity: prompt "${v}" is serving UNGATED — ${status.reason}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[BOOT] authenticity: could not check the eval gate: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ── US-2131: golden-set curation helpers (pure, exported for tests) ─────────

export const EXPECTED_LABELS: ReadonlySet<string> = new Set([
  "authentic",
  "counterfeit",
  "inconclusive",
]);

export interface AuthenticityCaseRow {
  brand_key: string;
  expected_label: string;
  is_active: boolean;
}

export interface BrandCoverage {
  total: number;
  authentic: number;
  counterfeit: number;
  inconclusive: number;
  /** A brand the gate cannot meaningfully certify — see usable below. */
  usable: boolean;
}

/**
 * Per-brand coverage of the ACTIVE golden set.
 *
 * `usable` requires at least one authentic AND one counterfeit case for the
 * brand. A brand with only genuine examples cannot demonstrate the one error
 * the gate exists to catch — calling a known fake authentic — so a perfect
 * agreement rate over authentic-only cases is not evidence of anything.
 */
export function summarizeCaseCoverage(
  rows: readonly AuthenticityCaseRow[],
): { brands: Record<string, BrandCoverage>; usable_brands: number; total_active: number } {
  const brands: Record<string, BrandCoverage> = {};
  let totalActive = 0;

  for (const r of rows) {
    if (!r.is_active) continue;
    totalActive += 1;
    const b = (brands[r.brand_key] ??= {
      total: 0,
      authentic: 0,
      counterfeit: 0,
      inconclusive: 0,
      usable: false,
    });
    b.total += 1;
    if (r.expected_label === "authentic") b.authentic += 1;
    else if (r.expected_label === "counterfeit") b.counterfeit += 1;
    else b.inconclusive += 1;
  }
  for (const b of Object.values(brands)) {
    b.usable = b.authentic > 0 && b.counterfeit > 0;
  }

  return {
    brands,
    usable_brands: Object.values(brands).filter((b) => b.usable).length,
    total_active: totalActive,
  };
}

/**
 * Validate an incoming golden-set case. Returns an error string, or null when
 * the case is acceptable. Pure + exported.
 *
 * Strict about images because runAuthenticityEval throws on a case with none —
 * better to reject at write time than to discover it mid-eval, after the run has
 * already spent vision calls on the cases before it.
 */
export function validateAuthenticityCase(body: Record<string, unknown>): string | null {
  if (typeof body.label !== "string" || !body.label.trim()) {
    return "label is required.";
  }
  if (typeof body.brand_key !== "string" || !body.brand_key.trim()) {
    return "brand_key is required (it joins brand_knowledge.brand_key).";
  }
  if (typeof body.expected_label !== "string" || !EXPECTED_LABELS.has(body.expected_label)) {
    return `expected_label must be one of: ${[...EXPECTED_LABELS].join(", ")}.`;
  }
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return "images must be a non-empty array of {image_type, storage_path}.";
  }
  for (const img of body.images) {
    const i = img as Record<string, unknown> | null;
    if (!i || typeof i.image_type !== "string" || typeof i.storage_path !== "string") {
      return "each image needs an image_type and a storage_path.";
    }
  }
  return null;
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

// Shadow / A-B grading of candidate prompts on live traffic (US-330).
//
// After a real submission's LIVE grade is produced, the pipeline (fire-and-
// forget) calls runShadowGrades(): it re-runs ONLY the composite stage with any
// shadow candidate prompt, REUSING the already-computed per-image analyses — so
// a shadow grade costs one extra composite call, not a full re-grade. Results
// are written to grading_shadow_results and NEVER touch grade_reports, the
// customer, or the certificate. Sampling + a daily cap bound the cost; every
// query is tenant-aware (the row is stamped with the submission owner's
// user_id). Promotion is unchanged: activation still requires the golden-set
// eval gate — shadow is advisory evidence only.
//
// The decision math (sampling, agreement, delta, tags, summary) is pure and
// unit-tested in grading-shadow_test.ts; the orchestrator below is thin and
// defensive (it must never throw into the pipeline).

import { supabaseAdmin } from "./supabase.ts";
import {
  type CompositeGradeResult,
  compositeGrade,
  type FactorScores,
  type GarmentInfo,
  type PerImageAnalysis,
} from "./ai-grading.ts";

// ── Pure helpers ────────────────────────────────────────────────────

/** Round to one decimal place (the precision of numeric(_,1) score columns). */
export function roundTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Active and shadow scores agree when they're within the half-point band. */
export function agreementWithin(a: number, b: number, band = 0.5): boolean {
  // +1e-9 so a delta that is exactly the band (float-noisy) still counts.
  return Math.abs(a - b) <= band + 1e-9;
}

/** Sample gate: true on a `rate` fraction of calls. rate is clamped to 0..1. */
export function shouldSample(rate: number, rng: () => number = Math.random): boolean {
  const r = Math.min(Math.max(Number.isFinite(rate) ? rate : 0, 0), 1);
  if (r <= 0) return false;
  if (r >= 1) return true;
  return rng() < r;
}

// Garment slugs / style hints that mark the canonical hard case: factory-
// distressed denim, where the active prompt has historically over-penalized
// intentional design as damage.
const DENIM_HINTS = ["denim", "jean"];
const DISTRESS_HINTS = [
  "distress",
  "rip",
  "raw-hem",
  "raw hem",
  "rawhem",
  "acid-wash",
  "acid wash",
  "destroyed",
  "frayed",
  "whisker",
];

/**
 * Slice tags for divergence analysis. Includes the garment category, each
 * declared style attribute (normalized), and a composite `distressed_denim`
 * tag for the flagged hard case (AC: "divergence on flagged categories").
 */
export function deriveDivergenceTags(
  category: string | null,
  styleAttributes: string[],
): string[] {
  const tags = new Set<string>();
  const cat = (category ?? "").trim().toLowerCase();
  if (cat) tags.add(`category:${cat}`);
  const styles = styleAttributes
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  for (const s of styles) tags.add(s.replace(/\s+/g, "_"));

  const isDenim = DENIM_HINTS.some((d) => cat.includes(d)) ||
    styles.some((s) => DENIM_HINTS.some((d) => s.includes(d)));
  const distressed = styles.some((s) =>
    DISTRESS_HINTS.some((h) => s.includes(h.replace(/\s+/g, "")) || s.includes(h))
  );
  if (isDenim && distressed) tags.add("distressed_denim");
  return [...tags];
}

export interface ShadowRow {
  score_delta: number | null;
  agreement: boolean | null;
  tags: string[];
  shadow_overall_score: number | null;
  error: string | null;
}

export interface ShadowTagStat {
  count: number;
  agreement_rate: number | null;
  mean_abs_delta: number | null;
}

export interface ShadowSummary {
  total: number;
  errored: number;
  scored: number;
  agreement_rate: number | null;
  mean_abs_delta: number | null;
  mean_delta: number | null;
  delta_histogram: Record<string, number>;
  per_tag: Record<string, ShadowTagStat>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Histogram bucket for a signed delta: nearest 0.5, clamped with overflow ends.
export function deltaBucket(d: number): string {
  const r = Math.round(d * 2) / 2;
  if (r <= -3) return "<=-3.0";
  if (r >= 3) return ">=+3.0";
  return (r > 0 ? "+" : "") + r.toFixed(1);
}

/**
 * Aggregate shadow rows for the admin comparison view: score-delta
 * distribution, agreement rate, and per-tag divergence. Pure — errored rows
 * (no shadow score) are counted but excluded from the score statistics.
 */
export function summarizeComparisons(rows: ShadowRow[]): ShadowSummary {
  const total = rows.length;
  const errored = rows.filter((r) => r.error).length;
  const scored = rows.filter(
    (r) => r.score_delta !== null && r.shadow_overall_score !== null,
  );
  const n = scored.length;
  const agree = scored.filter((r) => r.agreement === true).length;
  let sumAbs = 0;
  let sumSigned = 0;
  const histogram: Record<string, number> = {};
  const tagAgg = new Map<
    string,
    { count: number; agree: number; absSum: number }
  >();
  for (const r of scored) {
    const d = r.score_delta as number;
    sumAbs += Math.abs(d);
    sumSigned += d;
    const b = deltaBucket(d);
    histogram[b] = (histogram[b] ?? 0) + 1;
    for (const t of r.tags) {
      const e = tagAgg.get(t) ?? { count: 0, agree: 0, absSum: 0 };
      e.count++;
      if (r.agreement === true) e.agree++;
      e.absSum += Math.abs(d);
      tagAgg.set(t, e);
    }
  }
  const per_tag: Record<string, ShadowTagStat> = {};
  for (const [t, e] of tagAgg) {
    per_tag[t] = {
      count: e.count,
      agreement_rate: e.count ? round4(e.agree / e.count) : null,
      mean_abs_delta: e.count ? round2(e.absSum / e.count) : null,
    };
  }
  return {
    total,
    errored,
    scored: n,
    agreement_rate: n ? round4(agree / n) : null,
    mean_abs_delta: n ? round2(sumAbs / n) : null,
    mean_delta: n ? round2(sumSigned / n) : null,
    delta_histogram: histogram,
    per_tag,
  };
}

// ── Orchestrator (DB + composite re-run) ────────────────────────────

interface ShadowCandidate {
  id: string;
  version_name: string;
  prompt_text: string | null;
  garment_scope: string | null;
  shadow_sample_rate: number;
  shadow_daily_cap: number;
}

export interface ShadowGradeContext {
  submissionId: string;
  userId: string;
  gradeReportId: string;
  activePromptVersion: string;
  activeOverallScore: number;
  activeGradeTier: string;
  activeFactorScores: FactorScores;
  perImageResults: PerImageAnalysis[];
  garmentInfo: GarmentInfo;
  // Injectable for tests.
  rng?: () => number;
}

// Count today's (UTC) shadow runs for a version — the daily cost cap.
async function countTodayShadow(versionName: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabaseAdmin
    .from("grading_shadow_results")
    .select("id", { count: "exact", head: true })
    .eq("shadow_prompt_version_name", versionName)
    .gte("created_at", startOfDay.toISOString());
  if (error) {
    // Fail CLOSED on the cost guardrail: if we can't count, don't spend.
    console.warn(
      `[shadow] daily-cap count failed for ${versionName}; skipping:`,
      error.message,
    );
    return Number.MAX_SAFE_INTEGER;
  }
  return count ?? 0;
}

/**
 * Run every applicable shadow candidate against this just-graded submission.
 * Fire-and-forget from the pipeline — must never throw (errors are logged /
 * recorded). Reuses the per-image analyses, so each candidate is one composite
 * API call gated by sample rate + daily cap.
 */
export async function runShadowGrades(ctx: ShadowGradeContext): Promise<void> {
  let candidates: ShadowCandidate[];
  try {
    const { data, error } = await supabaseAdmin
      .from("ai_prompt_versions")
      .select(
        "id, version_name, prompt_text, garment_scope, shadow_sample_rate, shadow_daily_cap",
      )
      .eq("is_shadow", true)
      .eq("stage", "composite");
    if (error) {
      console.warn("[shadow] candidate lookup failed:", error.message);
      return;
    }
    candidates = (data ?? []) as ShadowCandidate[];
  } catch (err) {
    console.warn(
      "[shadow] candidate lookup threw:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (candidates.length === 0) return;

  const category = ctx.garmentInfo.garment_category || null;
  const rng = ctx.rng ?? Math.random;

  for (const cand of candidates) {
    // Scope: a scoped candidate only shadows its garment_category; null = all.
    if (cand.garment_scope && cand.garment_scope !== category) continue;
    // Shadowing the code default (empty prompt_text) is a no-op — skip.
    const text = (cand.prompt_text ?? "").trim();
    if (!text) continue;
    // Cost guardrails: sample gate, then daily cap (cap <= 0 disables).
    if (!shouldSample(cand.shadow_sample_rate, rng)) continue;
    if (cand.shadow_daily_cap <= 0) continue;
    if ((await countTodayShadow(cand.version_name)) >= cand.shadow_daily_cap) continue;

    const tags = deriveDivergenceTags(category, ctx.garmentInfo.style_attributes ?? []);
    let shadow: CompositeGradeResult | null = null;
    let errMsg: string | null = null;
    try {
      shadow = await compositeGrade(ctx.perImageResults, ctx.garmentInfo, {
        text,
        versionName: cand.version_name,
      });
    } catch (err) {
      errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[shadow] composite re-grade failed for ${ctx.submissionId} / ${cand.version_name}:`,
        errMsg,
      );
    }

    const delta = shadow
      ? roundTenth(shadow.overall_score - ctx.activeOverallScore)
      : null;

    const { error: insErr } = await supabaseAdmin
      .from("grading_shadow_results")
      .insert({
        submission_id: ctx.submissionId,
        user_id: ctx.userId,
        grade_report_id: ctx.gradeReportId,
        shadow_prompt_version_id: cand.id,
        shadow_prompt_version_name: cand.version_name,
        active_prompt_version_name: ctx.activePromptVersion,
        model: shadow?.model ?? "(error)",
        active_overall_score: ctx.activeOverallScore,
        active_grade_tier: ctx.activeGradeTier,
        active_factor_scores: ctx.activeFactorScores,
        shadow_overall_score: shadow?.overall_score ?? null,
        shadow_grade_tier: shadow?.grade_tier ?? null,
        shadow_factor_scores: shadow?.factor_scores ?? null,
        score_delta: delta,
        agreement: shadow
          ? agreementWithin(shadow.overall_score, ctx.activeOverallScore)
          : null,
        tags,
        error: errMsg,
      });
    if (insErr) {
      console.warn(
        `[shadow] result insert failed for ${ctx.submissionId} / ${cand.version_name}:`,
        insErr.message,
      );
    }
  }
}

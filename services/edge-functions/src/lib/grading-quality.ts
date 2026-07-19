// US-1594 / AGENTIC-OS Phase 1 (Module G — Grading Quality): the weekly memo.
//
// Reads the grading telemetry we already collect (accuracy tracking, calibration
// state, review-queue depth, exemplar coverage) and folds it into a structured
// weekly memo — what regressed / improved per category + prompt version,
// calibration gaps, exemplar coverage holes (vault/70-agent/agentic-os-map.md §3.G).
//
// SAFETY (grading-engine contract, AGENTIC_OS §5): this agent NEVER executes a
// grading-config change. classifyGradingIntent maps every prompt-version /
// threshold / calibration / exemplar change to a file_task pointing at the
// existing shadow → eval gate → canary lifecycle — the agent only REQUESTS,
// never mutates. (The review-queue reorder write tool is US-1658.)
//
// assembleGradingMemo + classifyGradingIntent are PURE (fixture-tested);
// gatherGradingTelemetry is the impure gather over the existing read libs.

import { computeWeeklyAccuracySummary } from "./accuracy-tracking.ts";
import { CALIBRATION_SETTING_KEY, EMPTY_CALIBRATION, type CalibrationSetting } from "./confidence-calibration.ts";
import { getSetting } from "./system-settings.ts";
import { supabaseAdmin } from "./supabase.ts";

// Thresholds for the memo heuristics (deliberately conservative + explicit).
const MIN_CATEGORY_COUNT = 5; // ignore thin categories (noise)
const REGRESSION_MAE = 0.75; // MAE above this in a well-sampled category regressed
const IMPROVEMENT_MAE = 0.45; // MAE at/below this is doing well
const MIN_EXEMPLARS = 3; // fewer active exemplars than this = a coverage hole

export interface GradingCategory {
  category: string;
  mae: number;
  agreement: number;
  count: number;
}
export interface GradingVersion {
  name: string;
  mae: number;
  agreement: number;
}
export interface GradingCalibrationCat {
  category: string;
  threshold: number;
  shippedErrorRate: number;
  sampleSize: number;
}
export interface GradingTelemetryInput {
  global: { mae: number; agreement: number };
  categories: GradingCategory[];
  versions: GradingVersion[];
  calibration: { enabled: boolean; targetErrorRate: number; categories: GradingCalibrationCat[] };
  reviewQueueOpen: number;
  exemplarCoverage: Array<{ category: string; count: number }>;
}

export interface GradingMemo {
  headline: string;
  global: { mae: number; agreement: number };
  regressions: Array<{ category: string; mae: number; count: number }>;
  improvements: Array<{ category: string; mae: number; count: number }>;
  calibrationGaps: Array<{ category: string; reason: string }>;
  exemplarHoles: string[];
  reviewQueueOpen: number;
  versions: GradingVersion[];
}

// Assemble the weekly grading-quality memo from telemetry (pure).
export function assembleGradingMemo(t: GradingTelemetryInput): GradingMemo {
  const sampled = t.categories.filter((c) => c.count >= MIN_CATEGORY_COUNT);

  const regressions = sampled
    .filter((c) => c.mae > REGRESSION_MAE)
    .sort((a, b) => b.mae - a.mae)
    .map((c) => ({ category: c.category, mae: c.mae, count: c.count }));

  const improvements = sampled
    .filter((c) => c.mae <= IMPROVEMENT_MAE)
    .sort((a, b) => a.mae - b.mae)
    .map((c) => ({ category: c.category, mae: c.mae, count: c.count }));

  const calibByCat = new Map(t.calibration.categories.map((c) => [c.category, c]));
  const calibrationGaps: Array<{ category: string; reason: string }> = [];
  for (const c of sampled) {
    if (!t.calibration.enabled) {
      calibrationGaps.push({ category: c.category, reason: "calibration disabled — using the flat threshold" });
      continue;
    }
    const cal = calibByCat.get(c.category);
    if (!cal) {
      calibrationGaps.push({ category: c.category, reason: "no calibration curve for this category" });
    } else if (cal.shippedErrorRate > t.calibration.targetErrorRate) {
      calibrationGaps.push({
        category: c.category,
        reason: `shipped error ${cal.shippedErrorRate.toFixed(2)} > target ${t.calibration.targetErrorRate.toFixed(2)}`,
      });
    }
  }
  // A single "disabled" gap is enough — don't repeat it per category.
  const dedupedGaps = t.calibration.enabled
    ? calibrationGaps
    : [{ category: "*", reason: "calibration disabled — using the flat threshold" }];

  const coverageByCat = new Map(t.exemplarCoverage.map((e) => [e.category, e.count]));
  const exemplarHoles = sampled
    .filter((c) => (coverageByCat.get(c.category) ?? 0) < MIN_EXEMPLARS)
    .map((c) => c.category);

  const headline = buildHeadline(t, regressions.length, improvements.length, dedupedGaps.length, exemplarHoles.length);

  return {
    headline,
    global: t.global,
    regressions,
    improvements,
    calibrationGaps: dedupedGaps,
    exemplarHoles,
    reviewQueueOpen: t.reviewQueueOpen,
    versions: t.versions,
  };
}

function buildHeadline(
  t: GradingTelemetryInput,
  regressions: number,
  improvements: number,
  gaps: number,
  holes: number,
): string {
  const base = `Grading: MAE ${t.global.mae.toFixed(3)}, agreement ${(t.global.agreement * 100).toFixed(0)}%` +
    ` · ${t.reviewQueueOpen} reviews open.`;
  if (regressions === 0 && gaps === 0 && holes === 0) {
    return `${base} No regressions, calibration healthy.`;
  }
  const parts: string[] = [];
  if (regressions > 0) parts.push(`${regressions} regressed categor${regressions === 1 ? "y" : "ies"}`);
  if (improvements > 0) parts.push(`${improvements} improved`);
  if (gaps > 0) parts.push(`${gaps} calibration gap${gaps === 1 ? "" : "s"}`);
  if (holes > 0) parts.push(`${holes} exemplar hole${holes === 1 ? "" : "s"}`);
  return `${base} ${parts.join(", ")}.`;
}

// ── Lifecycle safety (grading contract) ──────────────────────────────────────

export type GradingChangeKind =
  | "prompt_version"
  | "threshold"
  | "calibration"
  | "exemplar"
  | "reorder_review_queue"
  | string;

// Map a grading-change intent to the ONLY dispositions this agent may take.
// The one executable class is reorder_review_queue → adjust_queue (US-1658): a
// grade-safe, approval-gated reorder of the human-review queue by information
// value. EVERYTHING else is a file_task — the agent has no grading write tools,
// and any prompt/threshold/calibration/exemplar change MUST travel the
// shadow→eval→canary lifecycle a human drives.
export function classifyGradingIntent(kind: GradingChangeKind): "adjust_queue" | "file_task" {
  return kind === "reorder_review_queue" ? "adjust_queue" : "file_task";
}

// ── Impure gather (over the existing read libs) ──────────────────────────────

// Best-effort per source: a failed read degrades that section to empty rather
// than failing the whole memo.
export async function gatherGradingTelemetry(): Promise<GradingTelemetryInput> {
  const out: GradingTelemetryInput = {
    global: { mae: 0, agreement: 0 },
    categories: [],
    versions: [],
    calibration: { enabled: false, targetErrorRate: 0, categories: [] },
    reviewQueueOpen: 0,
    exemplarCoverage: [],
  };

  try {
    const s = await computeWeeklyAccuracySummary();
    out.global = { mae: s.global_mean_absolute_error, agreement: s.global_agreement_rate };
    out.categories = (s.category_accuracies ?? []).map((c) => ({
      category: c.garment_category,
      mae: c.mean_absolute_error,
      agreement: c.agreement_rate,
      count: c.count,
    }));
    out.versions = (s.versions ?? []).map((v) => {
      const r = v as unknown as Record<string, unknown>;
      return {
        name: String(r.prompt_version_name ?? r.version_name ?? r.version ?? "unknown"),
        mae: Number(r.overall_mean_absolute_error ?? 0),
        agreement: Number(r.overall_agreement_rate ?? 0),
      };
    });
  } catch {
    // accuracy telemetry unavailable this run
  }

  try {
    const cal = await getSetting<CalibrationSetting>(CALIBRATION_SETTING_KEY, EMPTY_CALIBRATION);
    out.calibration = {
      enabled: !!cal.enabled,
      targetErrorRate: typeof cal.target_error_rate === "number" ? cal.target_error_rate : 0.1,
      categories: Object.entries(cal.categories ?? {}).map(([category, v]) => ({
        category,
        threshold: Number((v as { threshold?: number }).threshold ?? 0),
        shippedErrorRate: Number((v as { shipped_error_rate?: number }).shipped_error_rate ?? 0),
        sampleSize: Number((v as { sample_size?: number }).sample_size ?? 0),
      })),
    };
  } catch {
    // calibration state unavailable
  }

  try {
    const { data } = await supabaseAdmin.rpc("system_health");
    const q = (data as { queues?: { reviewsOpen?: number } } | null)?.queues;
    out.reviewQueueOpen = typeof q?.reviewsOpen === "number" ? q.reviewsOpen : 0;
  } catch {
    // health unavailable
  }

  try {
    // Exemplar coverage: count active exemplars per garment_category.
    const { data } = await supabaseAdmin
      .from("grading_exemplar_sets")
      .select("exemplars")
      .eq("status", "active");
    const counts = new Map<string, number>();
    for (const row of (data ?? []) as Array<{ exemplars?: unknown }>) {
      const arr = Array.isArray(row.exemplars) ? row.exemplars : [];
      for (const ex of arr as Array<{ garment_category?: string }>) {
        const cat = typeof ex.garment_category === "string" ? ex.garment_category : "unknown";
        counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
    }
    out.exemplarCoverage = [...counts.entries()].map(([category, count]) => ({ category, count }));
  } catch {
    // exemplar coverage unavailable
  }

  return out;
}

// US-1658 / AGENTIC-OS Phase 1 (Module G): the review-queue reorder WRITE half.
//
// The Grading Quality agent may recommend surfacing high-information-value
// human reviews first (US-1558 active-learning routing). This module turns that
// recommendation into an APPROVAL-GATED, grade-safe artifact:
//
//   • computeReviewQueueOrder  — PURE. Scores each pending review with the
//     existing informationValue + rankReviews machinery and emits a ranked,
//     persistable order + a plain-language rationale. NEVER touches a grade,
//     prompt, threshold, or calibration — only an ordering hint.
//   • buildReviewInfoContext   — the golden/exemplar/combo/calibration coverage
//     read the /review-queue route already assembles, extracted so the route
//     and this tool share ONE source of truth.
//   • reorderReviewQueue       — the impure orchestration the reorder_review_queue
//     write tool runs on the approved-proposal path: gather → compute → persist
//     the artifact into system_settings (migration-free — see AC option A).
//
// SAFETY: the persisted artifact is advisory ordering evidence. It is written
// ONLY from the approved-proposal (executeWrite) path and records who authorized
// it; nothing here can change a grade. The live queue keeps its SLA guard (see
// rankReviews) so no review can be starved by a low information value.

import { supabaseAdmin } from "./supabase.ts";
import {
  defectComboKey,
  informationValue,
  rankReviews,
  type ReviewInfoContext,
} from "./review-info-value.ts";
import {
  CALIBRATION_SETTING_KEY,
  type CalibrationSetting,
  EMPTY_CALIBRATION,
  thresholdForCategory,
} from "./confidence-calibration.ts";
import { getSetting } from "./system-settings.ts";
import { reviewConfidenceThreshold } from "./ai-config.ts";

// The system_settings key the recommended order is persisted under. Read-through
// via getSetting; the /review-queue UI can surface it as an advisory hint.
export const REVIEW_QUEUE_ORDER_KEY = "grading.review_queue_order";

// Starvation floor for the SLA guard (rankReviews): a review waiting longer than
// this ALWAYS floats to the top regardless of information value, so a low-signal
// item can never starve. Defaults to the standard grade-speed tier SLA (48h).
// (The live route additionally honors each item's per-tier review_due_at; the
// artifact uses this uniform age floor since it is an advisory ordering hint.)
export const DEFAULT_SLA_AGE_MS = 48 * 3600_000;

// One pending human-review item, reduced to exactly what the ranking needs.
export interface PendingReviewRow {
  report_id: string;
  submission_id: string;
  garment_category: string | null;
  confidence: number;
  defect_types: readonly string[];
  waiting_ms: number;
  overdue: boolean;
}

export interface RankedReviewEntry {
  rank: number; // 1-based recommended position
  report_id: string;
  submission_id: string;
  info_value: number;
  reasons: string[];
  waiting_ms: number;
  overdue: boolean;
  // True when the SLA guard (not information value) floated this item up.
  sla_floated: boolean;
}

export interface ReviewQueueOrder {
  order: RankedReviewEntry[];
  rationale: string;
  sla_age_ms: number;
}

// The persisted artifact shape (system_settings value under REVIEW_QUEUE_ORDER_KEY).
export interface ReviewQueueOrderArtifact extends ReviewQueueOrder {
  computed_at: string;
  computed_by: string;
  proposal_id: string | null;
  count: number;
}

// ── Pure: ranking → persistable order ────────────────────────────────────────

// Score every pending review by information value, then order with the SLA
// guard (rankReviews): overdue-by-age items first (oldest first), the rest by
// information value descending. Pure + deterministic — the unit-tested core.
export function computeReviewQueueOrder(
  rows: readonly PendingReviewRow[],
  ctx: ReviewInfoContext,
  opts: { slaAgeMs?: number } = {},
): ReviewQueueOrder {
  const slaAgeMs = typeof opts.slaAgeMs === "number" && opts.slaAgeMs > 0
    ? opts.slaAgeMs
    : DEFAULT_SLA_AGE_MS;

  const scored = rows.map((r) => {
    const iv = informationValue({
      garmentCategory: r.garment_category,
      confidence: r.confidence,
      defectTypes: r.defect_types,
    }, ctx);
    return { row: r, iv };
  });

  const orderIdx = rankReviews(
    scored.map((s) => ({ waitingMs: s.row.waiting_ms, infoScore: s.iv.score })),
    slaAgeMs,
  );

  const order: RankedReviewEntry[] = orderIdx.map((srcIndex, position) => {
    const { row, iv } = scored[srcIndex];
    return {
      rank: position + 1,
      report_id: row.report_id,
      submission_id: row.submission_id,
      info_value: iv.score,
      reasons: iv.reasons,
      waiting_ms: row.waiting_ms,
      overdue: row.overdue,
      sla_floated: row.waiting_ms >= slaAgeMs,
    };
  });

  return { order, rationale: rationaleFor(order), sla_age_ms: slaAgeMs };
}

function rationaleFor(order: readonly RankedReviewEntry[]): string {
  if (order.length === 0) return "No pending reviews to reorder.";
  const floated = order.filter((e) => e.sla_floated).length;
  // Count reason-chip frequency across the ranking to name the dominant driver.
  const reasonCounts: Record<string, number> = {};
  for (const e of order) {
    for (const reason of e.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];
  const parts = [
    `Reordered ${order.length} pending review${order.length === 1 ? "" : "s"} by information value`,
  ];
  if (floated > 0) {
    parts.push(`${floated} SLA-floated to the top so nothing starves`);
  }
  if (topReason) {
    parts.push(`top driver: ${topReason[0]} (${topReason[1]} item${topReason[1] === 1 ? "" : "s"})`);
  }
  return parts.join("; ") + ".";
}

// ── Pure: assemble the persistable artifact ──────────────────────────────────

export function assembleReviewQueueArtifact(
  computed: ReviewQueueOrder,
  meta: { computedAtIso: string; computedBy: string; proposalId: string | null },
): ReviewQueueOrderArtifact {
  return {
    ...computed,
    computed_at: meta.computedAtIso,
    computed_by: meta.computedBy,
    proposal_id: meta.proposalId,
    count: computed.order.length,
  };
}

// ── Impure: the ReviewInfoContext build (shared with the /review-queue route) ─

// Golden-set + exemplar coverage per category, recent defect-combo frequencies,
// and the US-1557 calibrated thresholds — the three bounded, best-effort reads
// the ranking needs. A miss just flattens that factor (never throws). Extracted
// from admin-grading's /review-queue so both callers share one implementation.
export async function buildReviewInfoContext(): Promise<ReviewInfoContext> {
  const goldenByCategory: Record<string, number> = {};
  const exemplarsByCategory: Record<string, number> = {};
  const comboCounts: Record<string, number> = {};
  let calibration: CalibrationSetting = EMPTY_CALIBRATION;
  try {
    const [{ data: goldenRows }, { data: exemplarRows }, { data: recentReports }] = await Promise.all([
      supabaseAdmin.from("grading_eval_cases").select("garment_category")
        .eq("is_active", true).limit(2000),
      supabaseAdmin.from("grading_exemplar_sets").select("exemplars")
        .eq("is_active", true).limit(10),
      supabaseAdmin.from("grade_reports").select("defects_found")
        .order("created_at", { ascending: false }).limit(300),
    ]);
    for (const row of (goldenRows ?? []) as Array<{ garment_category: string }>) {
      const cat = (row.garment_category ?? "").toLowerCase();
      goldenByCategory[cat] = (goldenByCategory[cat] ?? 0) + 1;
    }
    for (const row of (exemplarRows ?? []) as Array<{ exemplars: unknown }>) {
      if (!Array.isArray(row.exemplars)) continue;
      for (const ex of row.exemplars as Array<{ garment_category?: string }>) {
        const cat = (ex.garment_category ?? "").toLowerCase();
        if (!cat) continue;
        exemplarsByCategory[cat] = (exemplarsByCategory[cat] ?? 0) + 1;
      }
    }
    for (const row of (recentReports ?? []) as Array<{ defects_found: unknown }>) {
      const types = Array.isArray(row.defects_found)
        ? (row.defects_found as Array<{ defect_type?: string }>)
          .map((d) => d?.defect_type ?? "").filter(Boolean)
        : [];
      comboCounts[defectComboKey(types)] = (comboCounts[defectComboKey(types)] ?? 0) + 1;
    }
    calibration = await getSetting<CalibrationSetting>(CALIBRATION_SETTING_KEY, EMPTY_CALIBRATION);
  } catch (err) {
    console.warn(
      "[review-queue-order] info-value context failed (scores flatten):",
      err instanceof Error ? err.message : String(err),
    );
  }
  const flatThreshold = reviewConfidenceThreshold();
  return {
    goldenByCategory,
    exemplarsByCategory,
    comboCounts,
    thresholdForCategory: (category) =>
      thresholdForCategory(calibration, category, flatThreshold).threshold,
  };
}

// ── Impure: gather the pending reviews to rank ───────────────────────────────

interface QueueReportRow {
  id: string;
  submission_id: string;
  confidence_score: number;
  review_due_at: string | null;
  created_at: string;
  defects_found: unknown;
}

// The same population the /review-queue route ranks: every preliminary grade
// awaiting human finalization, joined to its submission's garment_category.
export async function fetchPendingReviewRows(
  limit: number,
  nowMs: number,
): Promise<PendingReviewRow[]> {
  const { data: reportsRaw } = await supabaseAdmin
    .from("grade_reports")
    .select("id, submission_id, confidence_score, review_due_at, created_at, defects_found")
    .eq("review_status", "pending")
    .eq("human_reviewed", false)
    .is("superseded_at", null)
    .order("review_due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(limit);

  const reports = (reportsRaw ?? []) as unknown as QueueReportRow[];
  if (reports.length === 0) return [];

  const submissionIds = [...new Set(reports.map((r) => r.submission_id))];
  const catBySub = new Map<string, string | null>();
  const { data: subs } = await supabaseAdmin
    .from("submissions")
    .select("id, garment_category")
    .in("id", submissionIds);
  for (const s of (subs ?? []) as Array<{ id: string; garment_category: string | null }>) {
    catBySub.set(s.id, s.garment_category ?? null);
  }

  return reports.map((r) => {
    const types = Array.isArray(r.defects_found)
      ? (r.defects_found as Array<{ defect_type?: string }>).map((d) => d?.defect_type ?? "").filter(Boolean)
      : [];
    return {
      report_id: r.id,
      submission_id: r.submission_id,
      garment_category: catBySub.get(r.submission_id) ?? null,
      confidence: Number(r.confidence_score),
      defect_types: types,
      waiting_ms: nowMs - new Date(r.created_at).getTime(),
      overdue: r.review_due_at ? new Date(r.review_due_at).getTime() < nowMs : false,
    };
  });
}

// ── Impure: the orchestration the write tool runs (approved-proposal path) ────

export interface ReorderReviewQueueResult {
  persisted: boolean;
  count: number;
  setting_key: string;
  rationale: string;
  top: Array<{ rank: number; report_id: string; info_value: number; sla_floated: boolean }>;
  error?: string;
}

// Gather → compute → persist. Returns a compact summary for the proposal result
// (no PII: report ids + scores only). Called ONLY from executeWrite on an
// approved proposal, so `computedBy`/`proposalId` attribute the write.
export async function reorderReviewQueue(
  opts: { limit: number; nowMs: number; computedBy: string; proposalId: string | null },
): Promise<ReorderReviewQueueResult> {
  const rows = await fetchPendingReviewRows(opts.limit, opts.nowMs);
  const ctx = await buildReviewInfoContext();
  const computed = computeReviewQueueOrder(rows, ctx);
  const artifact = assembleReviewQueueArtifact(computed, {
    computedAtIso: new Date(opts.nowMs).toISOString(),
    computedBy: opts.computedBy,
    proposalId: opts.proposalId,
  });

  // Include the typed-registry columns (value_type + category are NOT NULL with
  // no default) so the FIRST write inserts cleanly — no seed migration needed.
  const { error } = await supabaseAdmin
    .from("system_settings")
    .upsert(
      {
        key: REVIEW_QUEUE_ORDER_KEY,
        value: artifact,
        value_type: "json",
        default_value: { order: [], rationale: "", count: 0 },
        description:
          "US-1658 advisory human-review queue order by information value (agent-computed via approved proposal; unset = default review_due_at ordering)",
        category: "grading",
        updated_by: opts.computedBy,
      },
      { onConflict: "key" },
    );
  if (error) {
    return {
      persisted: false,
      count: artifact.count,
      setting_key: REVIEW_QUEUE_ORDER_KEY,
      rationale: computed.rationale,
      top: [],
      error: error.message,
    };
  }

  return {
    persisted: true,
    count: artifact.count,
    setting_key: REVIEW_QUEUE_ORDER_KEY,
    rationale: computed.rationale,
    top: computed.order.slice(0, 10).map((e) => ({
      rank: e.rank,
      report_id: e.report_id,
      info_value: e.info_value,
      sla_floated: e.sla_floated,
    })),
  };
}

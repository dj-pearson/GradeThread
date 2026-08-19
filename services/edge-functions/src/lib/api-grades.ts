// US-9108: the public read surface for grades.
//
// Extracted from the /api/v1/grades handlers so the connector's
// gradethread_get_grade / gradethread_list_grades tools run the SAME query the
// public API does. The alternative — tools that re-query submissions and
// grade_reports themselves — is a second place for a tenant scope to be
// forgotten and a second definition of what a grade looks like.
//
// TENANCY (US-268): every read scopes on `.eq("user_id", tenantId)`, and the
// by-id read applies it in the same query as the id, so there is no window in
// which a row is fetched before it is authorized.
//
// PENDING REVIEW is read from `grade_reports.needs_human_review`, NOT by
// re-deriving "confidence < 0.75" at the read site. The threshold is calibrated
// per garment category at grading time (ai-grading.ts resolves an
// effectiveThreshold), so a hardcoded comparison here would disagree with the
// pipeline's own decision for exactly the categories where calibration matters.
// The stored boolean is what the pipeline decided; a resolved human review then
// clears it.

import { supabaseAdmin } from "./supabase.ts";

// deno-lint-ignore no-explicit-any
export type GradesDb = any;

/** Statuses for which a grade report may exist. */
const GRADED_STATUSES = ["completed", "disputed"];

export interface GradeReportView {
  id: string;
  overall_score: number;
  grade_tier: string;
  fabric_condition_score: number | null;
  structural_integrity_score: number | null;
  cosmetic_appearance_score: number | null;
  functional_elements_score: number | null;
  odor_cleanliness_score: number | null;
  confidence_score: number | null;
  ai_summary: string | null;
  detailed_notes: string | null;
  model_version: string | null;
  certificate_id: string | null;
  created_at: string;
  /** What the pipeline decided, using its calibrated threshold. */
  needs_human_review: boolean;
  /**
   * Flagged for review AND not yet reviewed. A caller must not present a
   * pending grade as final — that is the whole reason this field exists.
   */
  pending_review: boolean;
}

export interface GradeDetail {
  id: string;
  status: string;
  garment_type: string | null;
  garment_category: string | null;
  title: string | null;
  brand: string | null;
  description: string | null;
  grade_report: GradeReportView | null;
  created_at: string;
  updated_at: string;
}

export interface GradeSummary {
  id: string;
  status: string;
  garment_type: string | null;
  garment_category: string | null;
  title: string | null;
  brand: string | null;
  grade:
    | {
      overall_score: number;
      grade_tier: string;
      confidence_score: number | null;
      certificate_id: string | null;
      needs_human_review: boolean;
      pending_review: boolean;
    }
    | null;
  created_at: string;
  updated_at: string;
}

export interface GradesPage {
  items: GradeSummary[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export const GRADES_PAGE_DEFAULT = 20;
export const GRADES_PAGE_MAX = 100;

const REPORT_COLUMNS =
  "id, submission_id, overall_score, grade_tier, fabric_condition_score, structural_integrity_score, " +
  "cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, confidence_score, " +
  "ai_summary, detailed_notes, model_version, certificate_id, needs_human_review, created_at";

/**
 * Which of these reports already have a human review recorded.
 *
 * A report flagged needs_human_review that a reviewer has since handled is no
 * longer pending — reporting it as pending forever would train a caller to
 * ignore the flag, which is worse than not having it.
 */
async function reviewedReportIds(
  reportIds: string[],
  db: GradesDb,
): Promise<Set<string>> {
  if (reportIds.length === 0) return new Set();
  const { data, error } = await db
    .from("human_reviews")
    .select("grade_report_id")
    .in("grade_report_id", reportIds);
  if (error) return new Set();
  return new Set(
    ((data ?? []) as Array<{ grade_report_id: string }>).map((r) => r.grade_report_id),
  );
}

function pendingReview(needsReview: boolean, reportId: string, reviewed: Set<string>): boolean {
  return needsReview && !reviewed.has(reportId);
}

/**
 * One submission with its active grade report, or null when it does not exist
 * OR belongs to another tenant. The two are indistinguishable on purpose.
 */
export async function getGrade(
  tenantId: string,
  submissionId: string,
  db: GradesDb = supabaseAdmin,
): Promise<GradeDetail | null> {
  const { data: submission, error } = await db
    .from("submissions")
    .select(
      "id, status, garment_type, garment_category, title, brand, description, created_at, updated_at",
    )
    .eq("id", submissionId)
    .eq("user_id", tenantId)
    .maybeSingle();

  if (error || !submission) return null;
  const row = submission as Record<string, unknown>;

  let report: GradeReportView | null = null;
  if (GRADED_STATUSES.includes(String(row.status))) {
    const { data } = await db
      .from("grade_reports")
      .select(REPORT_COLUMNS)
      .eq("submission_id", submissionId)
      // US-479: a regraded submission keeps superseded history — return only
      // the active report.
      .is("superseded_at", null)
      .maybeSingle();

    if (data) {
      const r = data as Record<string, unknown>;
      const reviewed = await reviewedReportIds([String(r.id)], db);
      const needs = r.needs_human_review === true;
      report = {
        id: String(r.id),
        overall_score: Number(r.overall_score),
        grade_tier: String(r.grade_tier),
        fabric_condition_score: (r.fabric_condition_score as number | null) ?? null,
        structural_integrity_score: (r.structural_integrity_score as number | null) ?? null,
        cosmetic_appearance_score: (r.cosmetic_appearance_score as number | null) ?? null,
        functional_elements_score: (r.functional_elements_score as number | null) ?? null,
        odor_cleanliness_score: (r.odor_cleanliness_score as number | null) ?? null,
        confidence_score: (r.confidence_score as number | null) ?? null,
        ai_summary: (r.ai_summary as string | null) ?? null,
        detailed_notes: (r.detailed_notes as string | null) ?? null,
        model_version: (r.model_version as string | null) ?? null,
        certificate_id: (r.certificate_id as string | null) ?? null,
        created_at: String(r.created_at ?? ""),
        needs_human_review: needs,
        pending_review: pendingReview(needs, String(r.id), reviewed),
      };
    }
  }

  return {
    id: String(row.id),
    status: String(row.status),
    garment_type: (row.garment_type as string | null) ?? null,
    garment_category: (row.garment_category as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    brand: (row.brand as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    grade_report: report,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export function clampGradesLimit(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return GRADES_PAGE_DEFAULT;
  return Math.min(Math.max(Math.trunc(requested), 1), GRADES_PAGE_MAX);
}

export async function listGrades(
  tenantId: string,
  opts: { status?: string; page?: number; limit?: number } = {},
  db: GradesDb = supabaseAdmin,
): Promise<GradesPage> {
  const limit = clampGradesLimit(opts.limit);
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const offset = (page - 1) * limit;

  let query = db
    .from("submissions")
    .select(
      "id, status, garment_type, garment_category, title, brand, created_at, updated_at",
      { count: "exact" },
    )
    .eq("user_id", tenantId);

  if (opts.status) query = query.eq("status", opts.status);

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);

  const submissions = (data ?? []) as Array<Record<string, unknown>>;
  const gradedIds = submissions
    .filter((s) => GRADED_STATUSES.includes(String(s.status)))
    .map((s) => String(s.id));

  const reports: Record<string, Record<string, unknown>> = {};
  if (gradedIds.length > 0) {
    const { data: reportRows } = await db
      .from("grade_reports")
      .select(
        "id, submission_id, overall_score, grade_tier, confidence_score, certificate_id, needs_human_review",
      )
      .in("submission_id", gradedIds);
    for (const row of (reportRows ?? []) as Array<Record<string, unknown>>) {
      reports[String(row.submission_id)] = row;
    }
  }

  const reviewed = await reviewedReportIds(
    Object.values(reports).map((r) => String(r.id)),
    db,
  );

  const total = count ?? submissions.length;
  return {
    items: submissions.map((s) => {
      const report = reports[String(s.id)];
      const needs = report?.needs_human_review === true;
      return {
        id: String(s.id),
        status: String(s.status),
        garment_type: (s.garment_type as string | null) ?? null,
        garment_category: (s.garment_category as string | null) ?? null,
        title: (s.title as string | null) ?? null,
        brand: (s.brand as string | null) ?? null,
        grade: report
          ? {
            overall_score: Number(report.overall_score),
            grade_tier: String(report.grade_tier),
            confidence_score: (report.confidence_score as number | null) ?? null,
            certificate_id: (report.certificate_id as string | null) ?? null,
            needs_human_review: needs,
            pending_review: pendingReview(needs, String(report.id), reviewed),
          }
          : null,
        created_at: String(s.created_at ?? ""),
        updated_at: String(s.updated_at ?? ""),
      };
    }),
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
  };
}

export interface BatchJobResult {
  id: string;
  status: string;
  grade_id: string | null;
  error: string | null;
}

export interface BatchStatusView {
  id: string;
  status: string;
  item_count: number;
  succeeded_count: number;
  failed_count: number;
  error: string | null;
  results: BatchJobResult[];
}

/**
 * A batch's status and per-garment outcomes, or null when the id is unknown or
 * belongs to another tenant.
 *
 * BOTH queries carry the tenant scope, not only the parent. Scoping the parent
 * alone would be enough today, but a job-row read filtered only by batch_id is
 * one refactor away from being reachable with a foreign batch id.
 */
export async function getBatch(
  tenantId: string,
  batchId: string,
  db: GradesDb = supabaseAdmin,
): Promise<BatchStatusView | null> {
  const { data: batch } = await db
    .from("grading_batches")
    .select("id, status, item_count, succeeded_count, failed_count, error, created_at, updated_at")
    .eq("id", batchId)
    .eq("user_id", tenantId)
    .maybeSingle();
  if (!batch) return null;
  const b = batch as Record<string, unknown>;

  const { data: jobRows } = await db
    .from("grading_batch_jobs")
    .select("id, status, submission_id, error")
    .eq("batch_id", batchId)
    .eq("user_id", tenantId)
    .order("created_at", { ascending: true });

  const results = ((jobRows ?? []) as Array<Record<string, unknown>>).map((j) => ({
    id: String(j.id),
    status: String(j.status),
    grade_id: (j.submission_id as string | null) ?? null,
    error: (j.error as string | null) ?? null,
  }));

  return {
    id: String(b.id),
    status: String(b.status),
    item_count: Number(b.item_count ?? 0),
    succeeded_count: Number(b.succeeded_count ?? 0),
    failed_count: Number(b.failed_count ?? 0),
    error: (b.error as string | null) ?? null,
    results,
  };
}

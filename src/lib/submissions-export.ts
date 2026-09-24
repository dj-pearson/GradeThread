import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { csvBlob, downloadBlob } from "@/lib/download";
import { escapeCsvCell } from "@/lib/items-csv";
import { todayLocalDate, toLocalDate } from "@/lib/local-date";
import { fetchInChunks } from "@/lib/supabase-batch";
import { fetchAllPages } from "@/lib/paged-read";
import { formatLabel } from "@/lib/format-label";
import {
  applySubmissionFilters,
  NO_SUBMISSION_FILTERS,
  type SubmissionListFilters,
} from "@/lib/submission-list-query";
import type { GradeReportRow, SubmissionRow } from "@/types/database";

// The Submissions CSV export (US-2544 AC4, SUB-07).
//
// SUB-07: the whole-account export was one unranged select, so it silently
// stopped at the PostgREST row cap (US-2169). It also wrote superseded retakes
// as duplicate rows, ignored the filters on screen, and sorted each chunk of
// selected ids on its own. Now it pages with a stable order, drops superseded
// rows, applies the list's own filters, and sorts once at the end.

// US-2204: the export's row width scales with the whole account. It writes
// seven columns out of the row, so project them and type the read as the
// projection: a new CSV column reaching for a field the query stopped
// fetching is then a tsc error, not a runtime blank cell.
type ExportSubmission = Pick<
  SubmissionRow,
  | "id"
  | "created_at"
  | "title"
  | "brand"
  | "garment_type"
  | "garment_category"
  | "status"
>;

const EXPORT_COLUMNS =
  "id, created_at, title, brand, garment_type, garment_category, status";

type ExportGradeReport = Pick<
  GradeReportRow,
  | "overall_score"
  | "grade_tier"
  | "fabric_condition_score"
  | "structural_integrity_score"
  | "cosmetic_appearance_score"
  | "functional_elements_score"
  | "odor_cleanliness_score"
  | "certificate_id"
> & { submission_id: string };

/** Newest first, id as the tiebreak, so pages and chunks agree on one order. */
function byNewest(a: ExportSubmission, b: ExportSubmission): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export interface ExportOptions {
  /** Export just these ids (the checked rows). Omit for every matching row. */
  ids?: string[];
  /** The filters on screen. Ignored when `ids` is given. */
  filters?: SubmissionListFilters;
}

/**
 * Build and download the CSV. Returns the number of rows written (0 when
 * there was nothing to export).
 */
export async function exportSubmissionsCsv(
  ownerId: string,
  { ids, filters = NO_SUBMISSION_FILTERS }: ExportOptions = {},
): Promise<number> {
  let allSubmissions: ExportSubmission[];
  if (ids) {
    // Chunked: a selection can span hundreds of rows and would overflow the
    // request URL as one .in() call.
    allSubmissions = await fetchInChunks<ExportSubmission>(ids, async (chunk) => {
      const { data, error } = await supabase
        .from("submissions")
        .select(EXPORT_COLUMNS)
        .eq("user_id", ownerId)
        .is("superseded_at", null)
        .in("id", chunk);
      return { data, error };
    });
  } else {
    allSubmissions = await fetchAllPages<ExportSubmission>(async (from, to) => {
      const base = supabase
        .from("submissions")
        .select(EXPORT_COLUMNS)
        .eq("user_id", ownerId)
        .is("superseded_at", null);
      const { data, error } = await applySubmissionFilters(base, filters)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      if (error) throw error;
      return (data ?? []) as ExportSubmission[];
    });
  }
  // Once, over the joined result, rather than per chunk.
  allSubmissions.sort(byNewest);

  if (allSubmissions.length === 0) {
    toast.info("No submissions to export.");
    return 0;
  }

  // Batch the id list: a full export can span hundreds of submissions, which
  // would overflow the request URL as a single .in() call.
  const reportRows = await fetchInChunks<ExportGradeReport>(
    allSubmissions.map((s) => s.id),
    async (chunk) => {
      const { data, error } = await supabase
        .from("grade_reports")
        .select(
          "submission_id, overall_score, grade_tier, fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, certificate_id",
        )
        .in("submission_id", chunk)
        .is("superseded_at", null); // US-479: active report per submission
      return { data, error };
    },
  );
  const gradeMap = new Map(reportRows.map((r) => [r.submission_id, r]));

  const headers = [
    "Submission Date",
    "Title",
    "Brand",
    "Garment Type",
    "Category",
    "Status",
    "Overall Grade",
    "Grade Tier",
    "Fabric Condition",
    "Structural Integrity",
    "Cosmetic Appearance",
    "Functional Elements",
    "Cleanliness",
    "Certificate URL",
  ];

  const rows = allSubmissions.map((sub) => {
    const grade = gradeMap.get(sub.id);
    const certUrl = grade?.certificate_id
      ? `${window.location.origin}/cert/${grade.certificate_id}`
      : "";
    const fields: string[] = [
      toLocalDate(sub.created_at),
      sub.title,
      sub.brand ?? "",
      formatLabel(sub.garment_type),
      formatLabel(sub.garment_category),
      formatLabel(sub.status),
      grade ? grade.overall_score.toFixed(1) : "",
      grade?.grade_tier ?? "",
      grade ? grade.fabric_condition_score.toFixed(1) : "",
      grade ? grade.structural_integrity_score.toFixed(1) : "",
      grade ? grade.cosmetic_appearance_score.toFixed(1) : "",
      grade ? grade.functional_elements_score.toFixed(1) : "",
      grade ? grade.odor_cleanliness_score.toFixed(1) : "",
      certUrl,
    ];
    return fields.map(escapeCsvCell);
  });

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

  const dateStr = todayLocalDate();
  downloadBlob(
    csvBlob(csvContent),
    ids
      ? `gradethread_export_${allSubmissions.length}_selected_${dateStr}.csv`
      : `gradethread_export_${dateStr}.csv`,
  );
  return allSubmissions.length;
}

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FileText,
  Plus,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Search,
  Download,
  Flag,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScoreBandIcon } from "@/components/grade/score-indicator";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { ErrorState } from "@/components/ui/error-state";
import { Badge } from "@/components/ui/badge";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { csvBlob, downloadBlob } from "@/lib/download";
import { supabase } from "@/lib/supabase";
import { fetchInChunks } from "@/lib/supabase-batch";
import {
  GARMENT_TYPES,
  SUBMISSION_STATUSES,
  getStatusBadgeClasses,
  getScoreColor,
} from "@/lib/constants";
import type { SubmissionRow, GradeReportRow, DisputeRow } from "@/types/database";

const PAGE_SIZE = 20;

type SortField = "created_at" | "overall_score";
type SortDirection = "asc" | "desc";

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

interface SubmissionWithGrade extends SubmissionRow {
  grade_report?: Pick<GradeReportRow, "overall_score" | "grade_tier"> | null;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-10 flex-1" />
        </div>
      ))}
    </div>
  );
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function exportSubmissionsCsv() {
  // Fetch ALL submissions (no pagination)
  const { data: submissions, error: subError } = await supabase
    .from("submissions")
    .select("*")
    .order("created_at", { ascending: false });

  if (subError) throw subError;

  const allSubmissions = (submissions ?? []) as SubmissionRow[];

  if (allSubmissions.length === 0) {
    toast.info("No submissions to export.");
    return;
  }

  // Fetch all grade reports for these submissions
  const submissionIds = allSubmissions.map((s) => s.id);

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

  // Batch the id list — a full export can span hundreds of submissions, which
  // would overflow the request URL as a single .in() call.
  const reportRows = await fetchInChunks<ExportGradeReport>(
    submissionIds,
    async (chunk) => {
      const { data, error } = await supabase
        .from("grade_reports")
        .select(
          "submission_id, overall_score, grade_tier, fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, certificate_id"
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
    "Odor & Cleanliness",
    "Certificate URL",
  ];

  const rows = allSubmissions.map((sub) => {
    const grade = gradeMap.get(sub.id);
    const certUrl = grade?.certificate_id
      ? `${window.location.origin}/cert/${grade.certificate_id}`
      : "";

    const dateStr = new Date(sub.created_at).toISOString().slice(0, 10);
    const fields: string[] = [
      dateStr,
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
    return fields.map(escapeCsvField);
  });

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join(
    "\n"
  );

  const dateStr = new Date().toISOString().split("T")[0];
  downloadBlob(csvBlob(csvContent), `gradethread_export_${dateStr}.csv`);
}

function getDisputeStatusBadgeClasses(status: string): string {
  switch (status) {
    case "open":
      return "border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300";
    case "under_review":
      return "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300";
    case "resolved":
      return "border-green-200 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300";
    case "rejected":
      return "border-red-200 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300";
    default:
      return "";
  }
}

interface DisputeWithSubmission extends DisputeRow {
  submission_title?: string;
  submission_id?: string;
}

export function SubmissionsPage() {
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Press "n" to start a new submission.
  useKeyboardShortcuts([
    { key: "n", handler: () => navigate("/dashboard/submissions/new") },
  ]);
  const [garmentTypeFilter, setGarmentTypeFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const {
    data,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: [
      "submissions",
      page,
      statusFilter,
      garmentTypeFilter,
      sortField,
      sortDirection,
    ],
    queryFn: async () => {
      let query = supabase
        .from("submissions")
        .select("*", { count: "exact" });

      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }
      if (garmentTypeFilter !== "all") {
        query = query.eq("garment_type", garmentTypeFilter);
      }

      query = query
        .order("created_at", { ascending: sortDirection === "asc" })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      const { data: submissions, error, count } = await query;

      if (error) throw error;

      const submissionRows = (submissions ?? []) as SubmissionRow[];

      // Fetch grade reports for completed submissions
      const completedIds = submissionRows
        .filter((s) => s.status === "completed")
        .map((s) => s.id);

      let gradeMap: Record<
        string,
        Pick<GradeReportRow, "overall_score" | "grade_tier">
      > = {};

      if (completedIds.length > 0) {
        const { data: reports } = await supabase
          .from("grade_reports")
          .select("submission_id, overall_score, grade_tier")
          .in("submission_id", completedIds)
          .is("superseded_at", null); // US-479: active report per submission

        const reportRows = (reports ?? []) as Array<
          Pick<GradeReportRow, "overall_score" | "grade_tier"> & {
            submission_id: string;
          }
        >;

        gradeMap = Object.fromEntries(
          reportRows.map((r) => [
            r.submission_id,
            { overall_score: r.overall_score, grade_tier: r.grade_tier },
          ])
        );
      }

      const merged: SubmissionWithGrade[] = submissionRows.map((s) => ({
        ...s,
        grade_report: gradeMap[s.id] ?? null,
      }));

      // Sort by grade if requested
      if (sortField === "overall_score") {
        merged.sort((a, b) => {
          const aScore = a.grade_report?.overall_score ?? -1;
          const bScore = b.grade_report?.overall_score ?? -1;
          return sortDirection === "asc"
            ? aScore - bScore
            : bScore - aScore;
        });
      }

      return { submissions: merged, totalCount: count ?? 0 };
    },
    staleTime: 5 * 60 * 1000,
  });

  const {
    data: disputesData,
    isLoading: disputesLoading,
    isError: disputesError,
    isFetching: disputesFetching,
    refetch: refetchDisputes,
  } = useQuery({
    queryKey: ["my-disputes"],
    queryFn: async () => {
      // Fetch all user disputes
      const { data: disputes, error: disputeError } = await supabase
        .from("disputes")
        .select("*")
        .order("created_at", { ascending: false });

      if (disputeError) throw disputeError;

      const disputeRows = (disputes ?? []) as DisputeRow[];

      if (disputeRows.length === 0) return [];

      // Fetch grade reports to get submission IDs
      const gradeReportIds = disputeRows.map((d) => d.grade_report_id);
      const { data: gradeReports } = await supabase
        .from("grade_reports")
        .select("id, submission_id")
        .in("id", gradeReportIds);

      const gradeReportRows = (gradeReports ?? []) as Array<{
        id: string;
        submission_id: string;
      }>;
      const gradeReportMap = new Map(
        gradeReportRows.map((gr) => [gr.id, gr.submission_id])
      );

      // Fetch submission titles
      const submissionIds = gradeReportRows.map((gr) => gr.submission_id);
      const { data: subs } = await supabase
        .from("submissions")
        .select("id, title")
        .in("id", submissionIds);

      const subRows = (subs ?? []) as Array<{ id: string; title: string }>;
      const subMap = new Map(subRows.map((s) => [s.id, s.title]));

      const result: DisputeWithSubmission[] = disputeRows.map((d) => {
        const subId = gradeReportMap.get(d.grade_report_id);
        return {
          ...d,
          submission_id: subId,
          submission_title: subId ? subMap.get(subId) : undefined,
        };
      });

      return result;
    },
    staleTime: 5 * 60 * 1000,
  });

  const myDisputes = disputesData ?? [];

  const submissions = data?.submissions ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
    setPage(0);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Submissions"
        subtitle="View and manage your grading submissions."
        actions={
          <>
            <Button
              variant="outline"
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  await exportSubmissionsCsv();
                } catch {
                  toast.error("Failed to export submissions.");
                } finally {
                  setExporting(false);
                }
              }}
            >
              <Download className="mr-1 h-4 w-4" />
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate("/dashboard/submissions/bulk")}
            >
              <Layers className="mr-1 h-4 w-4" />
              Bulk Upload
            </Button>
            <Button onClick={() => navigate("/dashboard/submissions/new")}>
              <Plus className="mr-1 h-4 w-4" />
              New Submission
            </Button>
          </>
        }
      />

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            <Search className="mr-1.5 inline-block h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <div className="w-44">
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(0);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {SUBMISSION_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {formatLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-44">
              <Select
                value={garmentTypeFilter}
                onValueChange={(v) => {
                  setGarmentTypeFilter(v);
                  setPage(0);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Garment Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {GARMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {formatLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">All Submissions</CardTitle>
            {totalCount > 0 && (
              <CardDescription>
                {totalCount} submission{totalCount !== 1 ? "s" : ""}
              </CardDescription>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <QueryBoundary
            isLoading={isLoading}
            isError={isError}
            isEmpty={submissions.length === 0}
            onRetry={() => refetch()}
            isRetrying={isFetching}
            loading={<LoadingSkeleton />}
            errorProps={{
              title: "Couldn't load submissions",
              description:
                "Something went wrong while loading your submissions. This is usually temporary.",
            }}
            empty={
              statusFilter !== "all" || garmentTypeFilter !== "all" ? (
                <EmptyState
                  icon={FileText}
                  title="No matching submissions"
                  description="No submissions match the current filters."
                  secondaryAction={{
                    label: "Clear filters",
                    onClick: () => {
                      setStatusFilter("all");
                      setGarmentTypeFilter("all");
                    },
                  }}
                />
              ) : (
                <EmptyState
                  icon={FileText}
                  title="No submissions yet"
                  description="Submit your first garment for grading to get started."
                  action={{
                    label: "Submit your first garment",
                    to: "/dashboard/submissions/new",
                    icon: Plus,
                  }}
                />
              )
            }
          >
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Brand</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort("overall_score")}
                        >
                          Grade
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        </button>
                      </TableHead>
                      <TableHead>
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort("created_at")}
                        >
                          Date Submitted
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        </button>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {submissions.map((sub) => (
                      <TableRow
                        key={sub.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() =>
                          navigate(`/dashboard/submissions/${sub.id}`)
                        }
                      >
                        <TableCell className="font-medium">
                          {sub.title}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {sub.brand ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(getStatusBadgeClasses(sub.status))}
                          >
                            {formatLabel(sub.status)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {sub.grade_report ? (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1.5 font-semibold",
                                getScoreColor(sub.grade_report.overall_score)
                              )}
                            >
                              <ScoreBandIcon
                                score={sub.grade_report.overall_score}
                                withLabel={false}
                              />
                              {sub.grade_report.overall_score.toFixed(1)}
                              <span className="text-xs font-medium text-muted-foreground">
                                {sub.grade_report.grade_tier}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(sub.created_at).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-4">
                  <p className="text-sm text-muted-foreground">
                    Page {page + 1} of {totalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 0}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages - 1}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          </QueryBoundary>
        </CardContent>
      </Card>

      {/* My Disputes */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Flag className="h-4 w-4" />
              My Disputes
            </CardTitle>
            {myDisputes.length > 0 && (
              <CardDescription>
                {myDisputes.length} dispute{myDisputes.length !== 1 ? "s" : ""}
              </CardDescription>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {disputesError ? (
            <ErrorState
              title="Couldn't load disputes"
              description="Something went wrong while loading your disputes. This is usually temporary."
              onRetry={() => refetchDisputes()}
              retrying={disputesFetching}
            />
          ) : disputesLoading ? (
            <LoadingSkeleton />
          ) : myDisputes.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No disputes filed. If you disagree with a grade, you can dispute it
              from the submission detail page within 7 days.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Submission</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Filed</TableHead>
                    <TableHead>Resolution</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {myDisputes.map((d) => (
                    <TableRow
                      key={d.id}
                      className={
                        d.submission_id ? "cursor-pointer hover:bg-muted/50" : ""
                      }
                      onClick={() => {
                        if (d.submission_id) {
                          navigate(`/dashboard/submissions/${d.submission_id}`);
                        }
                      }}
                    >
                      <TableCell className="font-medium">
                        {d.submission_title ?? "Unknown"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            getDisputeStatusBadgeClasses(d.status)
                          )}
                        >
                          {formatLabel(d.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">
                        {d.reason}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(d.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">
                        {d.resolution_notes ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

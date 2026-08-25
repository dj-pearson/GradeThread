import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FileText,
  Plus,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  X,
  Download,
  Flag,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/search-input";
import { ScoreBandIcon } from "@/components/grade/score-indicator";
import { EmptyState } from "@/components/ui/empty-state";
import { showExampleAction } from "@/lib/show-example";
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
import { ClickableRow } from "@/components/clickable-row";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { csvBlob, downloadBlob } from "@/lib/download";
import { escapeCsvCell } from "@/lib/items-csv";
import { todayLocalDate, toLocalDate } from "@/lib/local-date";
import { sanitizeSearch, endOfDayIso } from "@/lib/search-filter";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
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

// US-2204: the table renders five submission columns, so the list query fetches
// exactly those. Typing the rows as the projection (rather than SubmissionRow)
// is what makes it safe: a cell that later reaches for a column the select
// stopped fetching is a tsc error, not a blank cell at runtime.
type SubmissionListRow = Pick<
  SubmissionRow,
  "id" | "title" | "brand" | "status" | "created_at"
>;
const SUBMISSION_LIST_COLUMNS = "id, title, brand, status, created_at";

interface SubmissionWithGrade extends SubmissionListRow {
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

// US-2544 AC4: pass `ids` to export just the checked rows. Omit it for the
// whole account, which is what the toolbar button has always done.
async function exportSubmissionsCsv(ids?: string[]) {
  // US-2204: the export is unpaginated by design, so it is the one submissions
  // read whose row width scales with the whole account. It writes seven columns
  // out of the row, and the grade_reports side is already projected — so project
  // this side too and type it as the projection, which makes tsc (not a runtime
  // blank cell) the thing that catches a new CSV column reaching for a field the
  // query stopped fetching.
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

  // Fetch ALL submissions (no pagination), or just the selected ids. The id
  // list is chunked for the same reason the grade-report join below is: a
  // selection can span hundreds of rows and would overflow the request URL.
  const EXPORT_COLUMNS =
    "id, created_at, title, brand, garment_type, garment_category, status";
  let allSubmissions: ExportSubmission[];
  if (ids) {
    allSubmissions = await fetchInChunks<ExportSubmission>(ids, async (chunk) => {
      const { data, error } = await supabase
        .from("submissions")
        .select(EXPORT_COLUMNS)
        .in("id", chunk)
        .order("created_at", { ascending: false });
      return { data, error };
    });
  } else {
    const { data: submissions, error: subError } = await supabase
      .from("submissions")
      .select(EXPORT_COLUMNS)
      .order("created_at", { ascending: false });
    if (subError) throw subError;
    allSubmissions = (submissions ?? []) as ExportSubmission[];
  }

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

    const dateStr = toLocalDate(sub.created_at);
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
    return fields.map(escapeCsvCell);
  });

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join(
    "\n"
  );

  const dateStr = todayLocalDate();
  downloadBlob(
    csvBlob(csvContent),
    ids
      ? `gradethread_export_${allSubmissions.length}_selected_${dateStr}.csv`
      : `gradethread_export_${dateStr}.csv`,
  );
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
  const { user } = useAuth();
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
  // US-2544 AC2: free-text search over title + brand, plus a date range. The
  // draft is what the field shows; `search` is what the query runs on, 300ms
  // behind it, so typing a nine-character brand does not fire nine queries.
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // US-2544 AC4: ids picked for a partial export.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchDraft);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchDraft]);

  const filtersActive =
    statusFilter !== "all" ||
    garmentTypeFilter !== "all" ||
    searchDraft.trim() !== "" ||
    dateFrom !== "" ||
    dateTo !== "";

  function clearFilters() {
    setStatusFilter("all");
    setGarmentTypeFilter("all");
    setSearchDraft("");
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setPage(0);
  }

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
      search,
      dateFrom,
      dateTo,
      sortField,
      sortDirection,
    ],
    queryFn: async () => {
      // US-2544 AC2: the search and date filters must reach BOTH sort branches.
      // Defining them once is the only thing stopping the score branch from
      // quietly ignoring a filter the date branch honours.
      //
      // `.or()` on a SELECT is fine on prod PostgREST — it is only rejected on
      // UPDATE/DELETE (US-1552). sanitizeSearch strips the characters `.or()`
      // parses as syntax.
      const withSearchAndDates = <
        T extends {
          or: (filter: string) => T;
          gte: (column: string, value: string) => T;
          lte: (column: string, value: string) => T;
        },
      >(
        q: T,
      ): T => {
        let next = q;
        const term = sanitizeSearch(search);
        if (term) next = next.or(`title.ilike.%${term}%,brand.ilike.%${term}%`);
        if (dateFrom) next = next.gte("created_at", dateFrom);
        if (dateTo) next = next.lte("created_at", endOfDayIso(dateTo));
        return next;
      };

      // Fetch the active grade report (overall_score + grade_tier) for a set of
      // submission ids, keyed by submission_id. US-479: only the non-superseded
      // report per submission.
      const fetchGradeMap = async (
        ids: string[]
      ): Promise<Record<string, Pick<GradeReportRow, "overall_score" | "grade_tier">>> => {
        if (ids.length === 0) return {};
        const { data: reports } = await supabase
          .from("grade_reports")
          .select("submission_id, overall_score, grade_tier")
          .in("submission_id", ids)
          .is("superseded_at", null);
        const rows = (reports ?? []) as Array<
          Pick<GradeReportRow, "overall_score" | "grade_tier"> & { submission_id: string }
        >;
        return Object.fromEntries(
          rows.map((r) => [
            r.submission_id,
            { overall_score: r.overall_score, grade_tier: r.grade_tier },
          ])
        );
      };

      // ── Grade sort (US-2196): overall_score is denormalized onto submissions
      // (migration 00494) and kept current by a trigger from the ACTIVE
      // grade_report (superseded_at IS NULL), so we order + paginate
      // SERVER-SIDE instead of loading every id and sorting in JS. A
      // direct-column `.order()` (NOT an embedded foreign-table order) is
      // prod-PostgREST-safe. Ungraded rows sort last in both directions.
      if (sortField === "overall_score") {
        let scoreQuery = supabase
          .from("submissions")
          .select(SUBMISSION_LIST_COLUMNS, { count: "exact" })
          .is("superseded_at", null);
        if (statusFilter !== "all")
          scoreQuery = scoreQuery.eq("status", statusFilter);
        if (garmentTypeFilter !== "all")
          scoreQuery = scoreQuery.eq("garment_type", garmentTypeFilter);
        scoreQuery = withSearchAndDates(scoreQuery);
        scoreQuery = scoreQuery
          .order("overall_score", {
            ascending: sortDirection === "asc",
            nullsFirst: false,
          })
          .order("created_at", { ascending: false })
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        const { data: pageRows, error, count } = await scoreQuery;
        if (error) throw error;
        const rows = (pageRows ?? []) as SubmissionListRow[];
        // Grade tier/score for display on the page's rows only.
        const scoreMap = await fetchGradeMap(rows.map((s) => s.id));
        const merged: SubmissionWithGrade[] = rows.map((s) => ({
          ...s,
          grade_report: scoreMap[s.id] ?? null,
        }));
        return { submissions: merged, totalCount: count ?? 0 };
      }

      // ── Default sort (created_at): a single paged, server-ordered query. ──
      let query = supabase
        .from("submissions")
        .select(SUBMISSION_LIST_COLUMNS, { count: "exact" })
        // US-949: superseded (retaken) submissions are history — exclude them
        // from the active list + count so a retake doesn't leave a dead row.
        .is("superseded_at", null);

      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }
      if (garmentTypeFilter !== "all") {
        query = query.eq("garment_type", garmentTypeFilter);
      }
      query = withSearchAndDates(query);

      query = query
        .order("created_at", { ascending: sortDirection === "asc" })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      const { data: submissions, error, count } = await query;

      if (error) throw error;

      const submissionRows = (submissions ?? []) as SubmissionListRow[];

      const gradeMap = await fetchGradeMap(
        submissionRows.filter((s) => s.status === "completed").map((s) => s.id)
      );

      const merged: SubmissionWithGrade[] = submissionRows.map((s) => ({
        ...s,
        grade_report: gradeMap[s.id] ?? null,
      }));

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
    queryKey: ["my-disputes", user?.id],
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
      const { data: gradeReports, error: grError } = await supabase
        .from("grade_reports")
        .select("id, submission_id")
        .in("id", gradeReportIds);
      // US-1636: surface a join failure instead of silently dropping every
      // dispute's item title (which read as "unknown item").
      if (grError) throw grError;

      const gradeReportRows = (gradeReports ?? []) as Array<{
        id: string;
        submission_id: string;
      }>;
      const gradeReportMap = new Map(
        gradeReportRows.map((gr) => [gr.id, gr.submission_id])
      );

      // Fetch submission titles
      const submissionIds = gradeReportRows.map((gr) => gr.submission_id);
      const { data: subs, error: subsError } = await supabase
        .from("submissions")
        .select("id, title")
        .in("id", submissionIds);
      if (subsError) throw subsError;

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

  // US-2544 AC2: both headers used to render the same static ArrowUpDown, so
  // the table told you it was sortable and never which way it was sorted.
  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) {
      return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />;
    }
    return sortDirection === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    );
  }

  function ariaSortFor(field: SortField): "ascending" | "descending" | "none" {
    if (sortField !== field) return "none";
    return sortDirection === "asc" ? "ascending" : "descending";
  }

  // US-2544 AC4. Selection is per-page and deliberately NOT cleared when the
  // page changes: picking three rows on page 1 and two on page 2 then exporting
  // all five is the point.
  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allOnPageSelected =
    submissions.length > 0 && submissions.every((s) => selected.has(s.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) submissions.forEach((s) => next.delete(s.id));
      else submissions.forEach((s) => next.add(s.id));
      return next;
    });
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
        <CardContent className="space-y-3">
          {/* US-2544 AC1/AC2: the card has always worn a magnifying glass. Now
              it has the search to go with it. Title and brand are the two
              columns the table shows that a seller would recognise an item by. */}
          <SearchInput
            label="Search submissions by title or brand"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title or brand…"
            className="w-full"
          />
          <div className="flex flex-wrap gap-3">
            <div className="w-44">
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(0);
                }}
              >
                <SelectTrigger aria-label="Filter submissions by status">
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
                <SelectTrigger aria-label="Filter submissions by garment type">
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

            {/* US-2544 AC2: date range. Both bounds are inclusive — see
                endOfDayIso for why the end needs saying out loud. */}
            <div className="flex items-center gap-2">
              <Label htmlFor="date-from" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input
                id="date-from"
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                className="w-40"
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPage(0);
                }}
              />
              <Label htmlFor="date-to" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input
                id="date-to"
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                className="w-40"
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPage(0);
                }}
              />
            </div>

            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="mr-1 h-4 w-4" />
                Clear filters
              </Button>
            )}
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
              filtersActive ? (
                <EmptyState
                  icon={FileText}
                  title="No matching submissions"
                  description="No submissions match the current search and filters."
                  secondaryAction={{
                    label: "Clear filters",
                    onClick: clearFilters,
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
                  // US-2865. Zero-data only: the filtered-empty branch above already
                  // offers Clear filters, and a user with rows needs no example.
                  secondaryAction={showExampleAction}
                />
              )
            }
          >
            <>
              {/* US-2544 AC4: what the checkboxes are for. Only appears once
                  something is checked, so the toolbar stays quiet otherwise. */}
              {selected.size > 0 && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                  <span className="font-medium">
                    {selected.size} selected
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={exporting}
                      onClick={async () => {
                        setExporting(true);
                        try {
                          await exportSubmissionsCsv([...selected]);
                        } catch {
                          toast.error("Failed to export the selected submissions.");
                        } finally {
                          setExporting(false);
                        }
                      }}
                    >
                      <Download className="mr-1 h-4 w-4" />
                      {exporting ? "Exporting…" : "Export selected"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(new Set())}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
              )}

              {/* US-2544 AC5: five columns do not fit a phone, and the old
                  horizontal scroll hid the grade — the one column a seller
                  opens this page for. Cards under md, table from md up. */}
              <ul className="space-y-2 md:hidden">
                {submissions.map((sub) => (
                  <li key={sub.id}>
                    <div className="flex items-start gap-3 rounded-lg border p-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 flex-shrink-0 cursor-pointer"
                        checked={selected.has(sub.id)}
                        onChange={() => toggleSelected(sub.id)}
                        aria-label={`Select ${sub.title}`}
                      />
                      <button
                        className="min-w-0 flex-1 space-y-1 text-left"
                        onClick={() =>
                          navigate(`/dashboard/submissions/${sub.id}`)
                        }
                      >
                        <p className="truncate font-medium">{sub.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {sub.brand ?? "No brand"} ·{" "}
                          {new Date(sub.created_at).toLocaleDateString()}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <Badge
                            variant="outline"
                            className={cn(getStatusBadgeClasses(sub.status))}
                          >
                            {formatLabel(sub.status)}
                          </Badge>
                          {sub.grade_report && (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1.5 text-sm font-semibold",
                                getScoreColor(sub.grade_report.overall_score),
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
                          )}
                        </div>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer"
                          checked={allOnPageSelected}
                          onChange={toggleSelectAll}
                          aria-label="Select all on this page"
                        />
                      </TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Brand</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead aria-sort={ariaSortFor("overall_score")}>
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort("overall_score")}
                        >
                          Grade
                          <SortIcon field="overall_score" />
                        </button>
                      </TableHead>
                      <TableHead aria-sort={ariaSortFor("created_at")}>
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort("created_at")}
                        >
                          Date Submitted
                          <SortIcon field="created_at" />
                        </button>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {submissions.map((sub) => (
                      <ClickableRow
                        key={sub.id}
                        className="hover:bg-muted/50"
                        onActivate={() =>
                          navigate(`/dashboard/submissions/${sub.id}`)
                        }
                        activateLabel={`View submission ${sub.title}`}
                      >
                        <TableCell>
                          {/* ClickableRow already ignores clicks that start
                              inside a nested input, so this does not navigate. */}
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer"
                            checked={selected.has(sub.id)}
                            onChange={() => toggleSelected(sub.id)}
                            aria-label={`Select ${sub.title}`}
                          />
                        </TableCell>
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
                      </ClickableRow>
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

      {/* US-2544 AC3: most sellers never file a dispute, and a full empty state
          with an icon and a paragraph gave every one of them a permanent
          card-sized reminder of a thing they had not done. When there is
          nothing to show, this is one muted line. The error and loading states
          are unchanged: a dispute that failed to LOAD still has to say so. */}
      {!disputesError && !disputesLoading && myDisputes.length === 0 ? (
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Flag className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          No disputes filed. You can dispute a grade from its submission within
          7 days.
        </p>
      ) : (
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
                  {myDisputes.map((d) => {
                    const cells = (
                      <>
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
                      </>
                    );
                    return d.submission_id ? (
                      <ClickableRow
                        key={d.id}
                        className="hover:bg-muted/50"
                        onActivate={() =>
                          navigate(
                            `/dashboard/submissions/${d.submission_id}`
                          )
                        }
                        activateLabel={`View submission ${
                          d.submission_title ?? "dispute"
                        }`}
                      >
                        {cells}
                      </ClickableRow>
                    ) : (
                      <TableRow key={d.id}>{cells}</TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}

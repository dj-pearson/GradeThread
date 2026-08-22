import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import type {
  SubmissionRow,
  GradeReportRow,
  UserRow,
} from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  FileText,
  Search,
  ArrowUpDown,
  RefreshCw,
  XCircle,
  Eye,
  Clock,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { SearchInput } from "@/components/search-input";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { toast } from "sonner";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
  processing: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  completed: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  disputed: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-green-600 dark:text-green-400",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-red-600 dark:text-red-400",
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getProcessingTime(submission: SubmissionRow, report: GradeReportRow | undefined): string {
  if (submission.status === "pending") return "—";
  const start = new Date(submission.created_at).getTime();
  const end = report
    ? new Date(report.created_at).getTime()
    : submission.status === "processing"
      ? Date.now()
      : new Date(submission.updated_at).getTime();
  const diffMs = end - start;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ${diffSec % 60}s`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ${diffMin % 60}m`;
}

function getConfidenceLevel(score: number): "high" | "medium" | "low" {
  if (score >= 0.85) return "high";
  if (score >= 0.75) return "medium";
  return "low";
}

// SLA: grading should complete within 5 minutes
const SLA_MS = 5 * 60 * 1000;
// US-2025: how many of the most recent submissions this console loads. Bounds
// three platform-wide append-only tables that were previously read in full. The
// filters run client-side over this window, so the header flags when it is full.
const SUBMISSION_LIMIT = 2000;

function isOverdueSLA(submission: SubmissionRow): boolean {
  if (submission.status !== "processing") return false;
  const elapsed = Date.now() - new Date(submission.created_at).getTime();
  return elapsed > SLA_MS;
}

interface EnrichedSubmission {
  submission: SubmissionRow;
  report: GradeReportRow | undefined;
  userEmail: string;
  userName: string | null;
}

type SortField = "date" | "confidence" | "processing_time";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 25;

export function AdminSubmissionsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Filters
  const [statusFilter, setStatusFilter] = useState("all");
  const [confidenceFilter, setConfidenceFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");

  // Sort
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Pagination
  const [page, setPage] = useState(1);

  // Dialogs
  const [viewingRawAnalysis, setViewingRawAnalysis] = useState<GradeReportRow | null>(null);
  const [retriggerTarget, setRetriggerTarget] = useState<SubmissionRow | null>(null);
  const [markFailedTarget, setMarkFailedTarget] = useState<SubmissionRow | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["admin-submissions"],
    queryFn: async () => {
      // US-2025: bound the anchor and derive the rest, instead of three
      // unbounded reads of platform-wide append-only tables.
      //
      // ⚠ The filters below (status, confidence, search) run CLIENT-SIDE over
      // whatever this returns, so the window is not merely a perf knob — it
      // changes what a filter can find. That is disclosed in the header rather
      // than left implicit; an admin filtering for "pending" and seeing none
      // must not conclude there are none.
      const subsRes = await supabase
        .from("submissions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(SUBMISSION_LIMIT);
      if (subsRes.error) throw subsRes.error;
      const submissions = (subsRes.data ?? []) as SubmissionRow[];

      const submissionIds = submissions.map((sub) => sub.id);
      const userIds = [...new Set(submissions.map((sub) => sub.user_id))];
      const [reportsRes, usersRes] = submissionIds.length > 0
        ? await Promise.all([
          // US-479: only the ACTIVE report per submission — a regraded
          // submission keeps its superseded history, which must not win the
          // reportMap.
          supabase
            .from("grade_reports")
            .select("*")
            .is("superseded_at", null)
            .in("submission_id", submissionIds),
          supabase.from("users").select("id, email, full_name").in("id", userIds),
        ])
        : [{ data: [], error: null }, { data: [], error: null }];
      if (reportsRes.error) throw reportsRes.error;
      if (usersRes.error) throw usersRes.error;

      const reports = (reportsRes.data ?? []) as GradeReportRow[];
      const users = (usersRes.data ?? []) as Pick<UserRow, "id" | "email" | "full_name">[];

      const reportMap = new Map<string, GradeReportRow>();
      for (const r of reports) {
        reportMap.set(r.submission_id, r);
      }

      const userMap = new Map<string, Pick<UserRow, "id" | "email" | "full_name">>();
      for (const u of users) {
        userMap.set(u.id, u);
      }

      return submissions.map((s): EnrichedSubmission => {
        const user = userMap.get(s.user_id);
        return {
          submission: s,
          report: reportMap.get(s.id),
          userEmail: user?.email ?? "Unknown",
          userName: user?.full_name ?? null,
        };
      });
    },
    staleTime: 30 * 1000,
  });

  const items = data ?? [];

  // Filter
  const filtered = items.filter((item) => {
    const s = item.submission;

    if (statusFilter !== "all" && s.status !== statusFilter) return false;

    if (confidenceFilter !== "all" && item.report) {
      const level = getConfidenceLevel(item.report.confidence_score);
      if (confidenceFilter !== level) return false;
    } else if (confidenceFilter !== "all" && !item.report) {
      return false;
    }

    if (dateFrom && s.created_at.slice(0, 10) < dateFrom) return false;
    if (dateTo && s.created_at.slice(0, 10) > dateTo) return false;

    if (search) {
      const q = search.toLowerCase();
      const titleMatch = s.title.toLowerCase().includes(q);
      const emailMatch = item.userEmail.toLowerCase().includes(q);
      const nameMatch = item.userName?.toLowerCase().includes(q);
      if (!titleMatch && !emailMatch && !nameMatch) return false;
    }

    return true;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;

    if (sortField === "date") {
      return (new Date(a.submission.created_at).getTime() - new Date(b.submission.created_at).getTime()) * dir;
    }

    if (sortField === "confidence") {
      const confA = a.report?.confidence_score ?? -1;
      const confB = b.report?.confidence_score ?? -1;
      return (confA - confB) * dir;
    }

    if (sortField === "processing_time") {
      const timeA = a.report
        ? new Date(a.report.created_at).getTime() - new Date(a.submission.created_at).getTime()
        : a.submission.status === "processing"
          ? Date.now() - new Date(a.submission.created_at).getTime()
          : 0;
      const timeB = b.report
        ? new Date(b.report.created_at).getTime() - new Date(b.submission.created_at).getTime()
        : b.submission.status === "processing"
          ? Date.now() - new Date(b.submission.created_at).getTime()
          : 0;
      return (timeA - timeB) * dir;
    }

    return 0;
  });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Failed submissions
  const failedSubmissions = items.filter((item) => item.submission.status === "failed");

  // Overdue (processing > SLA)
  const overdueSubmissions = items.filter((item) => isOverdueSLA(item.submission));

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "date" ? "desc" : "asc");
    }
    setPage(1);
  }

  // US-2376: the client-side logAuditAction helper is gone. Both admin actions
  // on this page now run through edge routes, which write the audit row
  // server-side with the actor's role, IP and user-agent — attestable, and not
  // forgeable from a devtools console.

  async function handleRetriggerGrading() {
    if (!retriggerTarget) return;
    setActionLoading(true);
    try {
      // US-479: re-run grading through the server endpoint, which actually
      // re-invokes the pipeline (supersedes the prior report, resets the row,
      // and kicks processSubmission) and writes the audit log. The old direct
      // browser write only set status='processing' and re-ran nothing, leaving
      // the submission stuck in 'processing' forever with no worker.
      const res = await edgeFetch(
        `/api/admin/grading/submissions/${retriggerTarget.id}/regrade`,
        { method: "POST", json: {} },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to re-trigger grading.");

      toast.success("Grading re-triggered", {
        description: `Submission "${retriggerTarget.title}" is being re-graded.`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-submissions"] });
    } catch (err) {
      toast.error("Failed to re-trigger grading", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
      setRetriggerTarget(null);
    }
  }

  // US-2376: marking a stuck grade failed runs through the server endpoint,
  // which does the whole operation — flips the status, REVERSES THE CHARGE for
  // the grade the customer never got, and clears the FlipDesk bridge link so it
  // stops showing "processing" — and writes the audit row. The old browser write
  // set the status column and nothing else, so the customer stayed charged; and
  // because there is no admin UPDATE policy on submissions, RLS matched zero
  // rows and it never even did that, while this page reported success.
  async function handleMarkAsFailed() {
    if (!markFailedTarget) return;
    setActionLoading(true);
    try {
      const res = await edgeFetch(
        `/api/admin/grading/submissions/${markFailedTarget.id}/mark-failed`,
        { method: "POST", json: {} },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to mark the submission failed.");

      toast.success("Submission marked as failed", {
        description: `"${markFailedTarget.title}" was marked failed and the charge reversed.`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-submissions"] });
    } catch (err) {
      toast.error("Failed to update submission", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
      setMarkFailedTarget(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        icon={FileText}
        title={
          <span className="flex flex-wrap items-center gap-2">
            All Submissions
            <Badge variant="secondary">
              {filtered.length} submission{filtered.length !== 1 ? "s" : ""}
            </Badge>
            {items.length >= SUBMISSION_LIMIT && (
              /* US-2025: the filters run client-side over the loaded window, so
                 say when the window is full. Otherwise "0 pending" is
                 indistinguishable from "0 pending in the newest 2,000". */
              <Badge
                variant="outline"
                className="border-amber-300 text-amber-700 dark:border-amber-900/50 dark:text-amber-400"
                title={`Showing the ${SUBMISSION_LIMIT.toLocaleString()} most recent submissions. Filters apply to this window only — older submissions exist and are not searched.`}
              >
                Newest {SUBMISSION_LIMIT.toLocaleString()}
              </Badge>
            )}
          </span>
        }
        actions={
          overdueSubmissions.length > 0 ? (
            <Badge variant="destructive" className="flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {overdueSubmissions.length} overdue
            </Badge>
          ) : undefined
        }
      />

      {/* Search and Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Search & Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {/* Search */}
            <SearchInput
              label="Search submissions"
              placeholder="Search title, email..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              containerClassName="sm:col-span-2 lg:col-span-1"
            />

            {/* Status filter */}
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Filter by status">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="disputed">Disputed</SelectItem>
              </SelectContent>
            </Select>

            {/* Confidence filter */}
            <Select
              value={confidenceFilter}
              onValueChange={(v) => {
                setConfidenceFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Filter by confidence">
                <SelectValue placeholder="All Confidence" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Confidence</SelectItem>
                <SelectItem value="high">High (&ge; 0.85)</SelectItem>
                <SelectItem value="medium">Medium (0.75–0.84)</SelectItem>
                <SelectItem value="low">Low (&lt; 0.75)</SelectItem>
              </SelectContent>
            </Select>

            {/* Date from */}
            <Input
              type="date"
              aria-label="Submitted from"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              placeholder="From date"
            />

            {/* Date to */}
            <Input
              type="date"
              aria-label="Submitted until"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              placeholder="To date"
            />
          </div>
        </CardContent>
      </Card>

      {/* SLA Warning Banner */}
      {overdueSubmissions.length > 0 && (
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40">
          <CardContent className="flex items-center gap-3 py-3">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
            <div>
              <p className="text-sm font-medium text-red-800 dark:text-red-300">
                {overdueSubmissions.length} submission{overdueSubmissions.length !== 1 ? "s" : ""} exceeded SLA (5 min)
              </p>
              <p className="text-xs text-red-600 dark:text-red-400">
                These submissions have been processing longer than the expected timeframe.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Submissions Table */}
      {isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("date")}
                    >
                      Date
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("processing_time")}
                    >
                      Processing
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isError ? (
                  /* US-2507: BEFORE the empty branch — "No submissions found"
                     on a failed load reads as a filter result, so an operator
                     widens the range and still sees nothing. */
                  <TableRow>
                    <TableCell colSpan={8} className="p-0">
                      <ErrorState
                        className="py-10"
                        title="Couldn't load submissions"
                        description="They're still there — we just couldn't fetch them right now."
                        onRetry={() => void refetch()}
                        retrying={isFetching}
                      />
                    </TableCell>
                  </TableRow>
                ) : paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="p-0">
                      <EmptyState
                        icon={Search}
                        title="No submissions found"
                        description="No submissions match the current filters. Try widening the date range or clearing the search."
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((item) => {
                    const s = item.submission;
                    const r = item.report;
                    const overdue = isOverdueSLA(s);

                    return (
                      <ClickableRow
                        key={s.id}
                        className={`hover:bg-muted/50 ${overdue ? "bg-red-50/50 dark:bg-red-950/50" : ""}`}
                        onActivate={() => navigate(`/dashboard/submissions/${s.id}`)}
                        activateLabel={`View submission ${s.title}`}
                      >
                        <TableCell className="font-medium max-w-[200px] truncate">
                          {s.title}
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-[180px] truncate">
                          {item.userEmail}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={`${STATUS_COLORS[s.status] ?? ""} ${overdue ? "ring-2 ring-red-400" : ""}`}
                          >
                            {overdue && <Clock className="mr-1 h-3 w-3" />}
                            {s.status.charAt(0).toUpperCase() + s.status.slice(1)}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {r ? (
                            <span
                              className={
                                r.overall_score >= 7
                                  ? "text-green-600 font-medium dark:text-green-400"
                                  : r.overall_score >= 5
                                    ? "text-yellow-600 font-medium dark:text-yellow-400"
                                    : "text-red-600 font-medium dark:text-red-400"
                              }
                            >
                              {r.overall_score.toFixed(1)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {r ? (
                            <span className={CONFIDENCE_COLORS[getConfidenceLevel(r.confidence_score)]}>
                              {(r.confidence_score * 100).toFixed(0)}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(s.created_at)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          <span className={overdue ? "text-red-600 font-medium dark:text-red-400" : ""}>
                            {getProcessingTime(s, r)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div
                            className="flex items-center justify-end gap-1"
                            role="presentation"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            {r && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                aria-label={`View the AI raw analysis for ${s.title}`}
                                title="View AI raw analysis"
                                onClick={() => setViewingRawAnalysis(r)}
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {(s.status === "failed" || s.status === "completed") && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                aria-label={`Re-trigger grading for ${s.title}`}
                                title="Re-trigger grading"
                                onClick={() => setRetriggerTarget(s)}
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {s.status === "processing" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-red-600 dark:text-red-400"
                                aria-label={`Mark ${s.title} as failed`}
                                title="Mark as failed"
                                onClick={() => setMarkFailedTarget(s)}
                              >
                                <XCircle className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </ClickableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, sorted.length)} of{" "}
                {sorted.length}
              </p>
              <div className="flex gap-2">
                <button
                  className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                  disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)}
                >
                  Previous
                </button>
                <button
                  className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage(safePage + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Failed Submissions Section */}
      {failedSubmissions.length > 0 && (
        <Card className="border-red-200 dark:border-red-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-red-700 dark:text-red-300">
              <XCircle className="h-4 w-4" />
              Failed Submissions ({failedSubmissions.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Failed At</TableHead>
                  <TableHead>Time Elapsed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failedSubmissions.map((item) => (
                  <ClickableRow
                    key={item.submission.id}
                    className="hover:bg-muted/50"
                    onActivate={() => navigate(`/dashboard/submissions/${item.submission.id}`)}
                    activateLabel={`View submission ${item.submission.title}`}
                  >
                    <TableCell className="font-medium">
                      {item.submission.title}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.userEmail}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(item.submission.updated_at)}
                    </TableCell>
                    <TableCell className="tabular-nums text-red-600 dark:text-red-400">
                      {getProcessingTime(item.submission, item.report)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div
                        className="flex items-center justify-end gap-1"
                        role="presentation"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          title="Re-trigger grading"
                          aria-label={`Re-trigger grading for ${item.submission.title}`}
                          onClick={() => setRetriggerTarget(item.submission)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </ClickableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* View AI Raw Analysis Dialog */}
      <Dialog open={!!viewingRawAnalysis} onOpenChange={() => setViewingRawAnalysis(null)}>
        <DialogContent className="max-w-2xl max-h-[80dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>AI Raw Analysis</DialogTitle>
            <DialogDescription>
              Full grade report data from the AI grading engine.
            </DialogDescription>
          </DialogHeader>
          {viewingRawAnalysis && (
            <div className="space-y-4">
              {/* Scores Overview */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Overall Score</p>
                  <p className="text-2xl font-bold">{viewingRawAnalysis.overall_score.toFixed(1)}</p>
                  <Badge variant="secondary" className="mt-1">{viewingRawAnalysis.grade_tier}</Badge>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Confidence</p>
                  <p className={`text-2xl font-bold ${CONFIDENCE_COLORS[getConfidenceLevel(viewingRawAnalysis.confidence_score)]}`}>
                    {(viewingRawAnalysis.confidence_score * 100).toFixed(1)}%
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {getConfidenceLevel(viewingRawAnalysis.confidence_score)}
                  </p>
                </div>
              </div>

              {/* Factor Scores */}
              <div>
                <h4 className="text-sm font-medium mb-2">Factor Scores</h4>
                <div className="space-y-2">
                  {[
                    { label: "Fabric Condition (30%)", score: viewingRawAnalysis.fabric_condition_score },
                    { label: "Structural Integrity (25%)", score: viewingRawAnalysis.structural_integrity_score },
                    { label: "Cosmetic Appearance (20%)", score: viewingRawAnalysis.cosmetic_appearance_score },
                    { label: "Functional Elements (15%)", score: viewingRawAnalysis.functional_elements_score },
                    { label: "Odor & Cleanliness (10%)", score: viewingRawAnalysis.odor_cleanliness_score },
                  ].map((factor) => (
                    <div key={factor.label} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{factor.label}</span>
                      <span className="font-mono font-medium">{factor.score.toFixed(1)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* AI Summary */}
              <div>
                <h4 className="text-sm font-medium mb-2">AI Summary</h4>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap rounded-lg border bg-muted/30 p-3">
                  {viewingRawAnalysis.ai_summary}
                </p>
              </div>

              {/* Detailed Notes */}
              {viewingRawAnalysis.detailed_notes && Object.keys(viewingRawAnalysis.detailed_notes).length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Detailed Notes</h4>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <pre className="text-xs whitespace-pre-wrap font-mono">
                      {JSON.stringify(viewingRawAnalysis.detailed_notes, null, 2)}
                    </pre>
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div>
                <h4 className="text-sm font-medium mb-2">Metadata</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Report ID:</span>
                    <p className="font-mono text-xs">{viewingRawAnalysis.id}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Model Version:</span>
                    <p className="font-mono text-xs">{viewingRawAnalysis.model_version}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Certificate ID:</span>
                    <p className="font-mono text-xs">{viewingRawAnalysis.certificate_id ?? "None"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Created:</span>
                    <p className="text-xs">{formatDateTime(viewingRawAnalysis.created_at)}</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Re-trigger Grading Confirmation */}
      <AlertDialog open={!!retriggerTarget} onOpenChange={() => setRetriggerTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-trigger grading</AlertDialogTitle>
            <AlertDialogDescription>
              This re-runs the AI grading pipeline. The current grade report (if any) is superseded
              and its certificate withheld; a fresh report and certificate are generated once
              grading completes.
              <br /><br />
              <strong>Submission:</strong> {retriggerTarget?.title}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRetriggerGrading}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Re-trigger grading
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mark as Failed Confirmation */}
      <AlertDialog open={!!markFailedTarget} onOpenChange={() => setMarkFailedTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as failed</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the submission as failed. The user will see the submission in a failed
              state. You can re-trigger grading later if needed.
              <br /><br />
              <strong>Submission:</strong> {markFailedTarget?.title}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleMarkAsFailed}
              disabled={actionLoading}
              className="bg-red-600 hover:bg-red-700"
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Mark as failed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

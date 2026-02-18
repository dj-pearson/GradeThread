import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import type {
  SubmissionRow,
  GradeReportRow,
  UserRow,
  AdminAuditLogInsert,
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
import { Badge } from "@/components/ui/badge";
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
import { toast } from "sonner";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  processing: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  disputed: "bg-purple-100 text-purple-700",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-green-600",
  medium: "text-yellow-600",
  low: "text-red-600",
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
  const { profile } = useAuth();

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

  const { data, isLoading } = useQuery({
    queryKey: ["admin-submissions"],
    queryFn: async () => {
      const [subsRes, reportsRes, usersRes] = await Promise.all([
        supabase.from("submissions").select("*"),
        supabase.from("grade_reports").select("*"),
        supabase.from("users").select("id, email, full_name"),
      ]);
      if (subsRes.error) throw subsRes.error;
      if (reportsRes.error) throw reportsRes.error;
      if (usersRes.error) throw usersRes.error;

      const submissions = (subsRes.data ?? []) as SubmissionRow[];
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

  async function logAuditAction(action: string, targetId: string, details: Record<string, unknown>) {
    if (!profile) return;
    const entry: AdminAuditLogInsert = {
      admin_user_id: profile.id,
      action,
      target_type: "submission",
      target_id: targetId,
      details,
    };
    await supabase.from("admin_audit_log").insert(entry as never);
  }

  async function handleRetriggerGrading() {
    if (!retriggerTarget) return;
    setActionLoading(true);
    try {
      // Reset submission status to 'processing'
      const { error } = await supabase
        .from("submissions")
        .update({ status: "processing" } as never)
        .eq("id", retriggerTarget.id);

      if (error) throw error;

      await logAuditAction("retrigger_grading", retriggerTarget.id, {
        previous_status: retriggerTarget.status,
        title: retriggerTarget.title,
      });

      toast.success("Grading re-triggered", {
        description: `Submission "${retriggerTarget.title}" has been queued for re-grading.`,
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

  async function handleMarkAsFailed() {
    if (!markFailedTarget) return;
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from("submissions")
        .update({ status: "failed" } as never)
        .eq("id", markFailedTarget.id);

      if (error) throw error;

      await logAuditAction("mark_failed", markFailedTarget.id, {
        previous_status: markFailedTarget.status,
        title: markFailedTarget.title,
      });

      toast.success("Submission marked as failed", {
        description: `"${markFailedTarget.title}" has been marked as failed.`,
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="h-6 w-6 text-brand-red" />
          <h1 className="text-2xl font-bold">All Submissions</h1>
          <Badge variant="secondary" className="ml-2">
            {filtered.length} submission{filtered.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        {overdueSubmissions.length > 0 && (
          <Badge variant="destructive" className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {overdueSubmissions.length} overdue
          </Badge>
        )}
      </div>

      {/* Search and Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Search & Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {/* Search */}
            <div className="relative sm:col-span-2 lg:col-span-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search title, email..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-9"
              />
            </div>

            {/* Status filter */}
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger>
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
              <SelectTrigger>
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
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-3 py-3">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <div>
              <p className="text-sm font-medium text-red-800">
                {overdueSubmissions.length} submission{overdueSubmissions.length !== 1 ? "s" : ""} exceeded SLA (5 min)
              </p>
              <p className="text-xs text-red-600">
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
                {paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                      No submissions found matching your filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((item) => {
                    const s = item.submission;
                    const r = item.report;
                    const overdue = isOverdueSLA(s);

                    return (
                      <TableRow
                        key={s.id}
                        className={`cursor-pointer hover:bg-muted/50 ${overdue ? "bg-red-50/50" : ""}`}
                        onClick={() => navigate(`/dashboard/submissions/${s.id}`)}
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
                                  ? "text-green-600 font-medium"
                                  : r.overall_score >= 5
                                    ? "text-yellow-600 font-medium"
                                    : "text-red-600 font-medium"
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
                          <span className={overdue ? "text-red-600 font-medium" : ""}>
                            {getProcessingTime(s, r)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div
                            className="flex items-center justify-end gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
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
                                className="h-7 w-7 p-0 text-red-600"
                                title="Mark as failed"
                                onClick={() => setMarkFailedTarget(s)}
                              >
                                <XCircle className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
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
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-red-700">
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
                  <TableRow
                    key={item.submission.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/dashboard/submissions/${item.submission.id}`)}
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
                    <TableCell className="tabular-nums text-red-600">
                      {getProcessingTime(item.submission, item.report)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div
                        className="flex items-center justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          title="Re-trigger grading"
                          onClick={() => setRetriggerTarget(item.submission)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* View AI Raw Analysis Dialog */}
      <Dialog open={!!viewingRawAnalysis} onOpenChange={() => setViewingRawAnalysis(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
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
            <AlertDialogTitle>Re-trigger Grading</AlertDialogTitle>
            <AlertDialogDescription>
              This will reset the submission status to &ldquo;processing&rdquo; and queue it for
              re-grading. The existing grade report (if any) will remain until a new one is generated.
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
              Re-trigger
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mark as Failed Confirmation */}
      <AlertDialog open={!!markFailedTarget} onOpenChange={() => setMarkFailedTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as Failed</AlertDialogTitle>
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
              Mark as Failed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

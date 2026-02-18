import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { getImageUrl } from "@/lib/storage";
import { GRADE_FACTORS } from "@/lib/constants";
import type {
  DisputeRow,
  DisputeStatus,
  SubmissionRow,
  GradeReportRow,
  SubmissionImageRow,
  HumanReviewInsert,
  AdminAuditLogInsert,
  UserRow,
} from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  Scale,
  Search,
  ArrowUpDown,
  Eye,
  Check,
  Pencil,
  X,
  Clock,
  Loader2,
  ImageIcon,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

const EDGE_URL = import.meta.env.VITE_SUPABASE_URL
  ? `${import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, "")}`
  : "";

async function sendDisputeNotification(disputeId: string): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token || !EDGE_URL) return;

    await fetch(`${EDGE_URL}/api/notifications/dispute-resolved`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ disputeId }),
    });
  } catch (err) {
    console.error("[Disputes] Failed to send notification email:", err);
  }
}

// ─── Types ──────────────────────────────────────────────────────────

interface EnrichedDispute {
  dispute: DisputeRow;
  submission: SubmissionRow;
  report: GradeReportRow;
  images: SubmissionImageRow[];
  userEmail: string;
  userName: string | null;
  waitingTime: number; // ms since dispute created
}

type SortField = "date" | "waiting_time";
type SortDir = "asc" | "desc";
type StatusFilter = "all" | DisputeStatus;

interface FactorScores {
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
}

const FACTOR_KEYS: (keyof FactorScores)[] = [
  "fabric_condition_score",
  "structural_integrity_score",
  "cosmetic_appearance_score",
  "functional_elements_score",
  "odor_cleanliness_score",
];

const FACTOR_META: Record<keyof FactorScores, { label: string; weight: number }> = {
  fabric_condition_score: GRADE_FACTORS.fabric_condition,
  structural_integrity_score: GRADE_FACTORS.structural_integrity,
  cosmetic_appearance_score: GRADE_FACTORS.cosmetic_appearance,
  functional_elements_score: GRADE_FACTORS.functional_elements,
  odor_cleanliness_score: GRADE_FACTORS.odor_cleanliness,
};

// ─── Helpers ────────────────────────────────────────────────────────

const STATUS_COLORS: Record<DisputeStatus, string> = {
  open: "bg-yellow-100 text-yellow-700",
  under_review: "bg-blue-100 text-blue-700",
  resolved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

const STATUS_LABELS: Record<DisputeStatus, string> = {
  open: "Open",
  under_review: "Under Review",
  resolved: "Resolved",
  rejected: "Rejected",
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatWaitingTime(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

function computeWeightedScore(factors: FactorScores): number {
  let total = 0;
  for (const key of FACTOR_KEYS) {
    total += factors[key] * FACTOR_META[key].weight;
  }
  return Math.round(total * 2) / 2;
}

const PAGE_SIZE = 20;

// ─── Main Component ─────────────────────────────────────────────────

export function AdminDisputesPage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  // Sort
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Pagination
  const [page, setPage] = useState(1);

  // Detail dialog
  const [selectedDispute, setSelectedDispute] = useState<EnrichedDispute | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [loadingPhotos, setLoadingPhotos] = useState(false);

  // Action state
  const [actionLoading, setActionLoading] = useState(false);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [adjustGrade, setAdjustGrade] = useState(false);
  const [adjustedScores, setAdjustedScores] = useState<FactorScores>({
    fabric_condition_score: 5,
    structural_integrity_score: 5,
    cosmetic_appearance_score: 5,
    functional_elements_score: 5,
    odor_cleanliness_score: 5,
  });

  // Reject confirmation
  const [rejectTarget, setRejectTarget] = useState<EnrichedDispute | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // ─── Data Fetching ────────────────────────────────────────────────

  const { data, isLoading } = useQuery({
    queryKey: ["admin-disputes"],
    queryFn: async () => {
      const [disputesRes, subsRes, reportsRes, imagesRes, usersRes] = await Promise.all([
        supabase.from("disputes").select("*"),
        supabase.from("submissions").select("*"),
        supabase.from("grade_reports").select("*"),
        supabase.from("submission_images").select("*"),
        supabase.from("users").select("id, email, full_name"),
      ]);
      if (disputesRes.error) throw disputesRes.error;
      if (subsRes.error) throw subsRes.error;
      if (reportsRes.error) throw reportsRes.error;
      if (imagesRes.error) throw imagesRes.error;
      if (usersRes.error) throw usersRes.error;

      const disputes = (disputesRes.data ?? []) as DisputeRow[];
      const submissions = (subsRes.data ?? []) as SubmissionRow[];
      const reports = (reportsRes.data ?? []) as GradeReportRow[];
      const images = (imagesRes.data ?? []) as SubmissionImageRow[];
      const users = (usersRes.data ?? []) as Pick<UserRow, "id" | "email" | "full_name">[];

      // Build lookup maps
      const reportById = new Map<string, GradeReportRow>();
      const reportBySubmission = new Map<string, GradeReportRow>();
      for (const r of reports) {
        reportById.set(r.id, r);
        reportBySubmission.set(r.submission_id, r);
      }

      const submissionMap = new Map<string, SubmissionRow>();
      for (const s of submissions) submissionMap.set(s.id, s);

      const imagesBySubmission = new Map<string, SubmissionImageRow[]>();
      for (const img of images) {
        const list = imagesBySubmission.get(img.submission_id) ?? [];
        list.push(img);
        imagesBySubmission.set(img.submission_id, list);
      }

      const userMap = new Map<string, Pick<UserRow, "id" | "email" | "full_name">>();
      for (const u of users) userMap.set(u.id, u);

      const now = Date.now();

      return disputes
        .map((d): EnrichedDispute | null => {
          const report = reportById.get(d.grade_report_id);
          if (!report) return null;
          const submission = submissionMap.get(report.submission_id);
          if (!submission) return null;
          const user = userMap.get(d.user_id);

          return {
            dispute: d,
            submission,
            report,
            images: (imagesBySubmission.get(submission.id) ?? []).sort(
              (a, b) => a.display_order - b.display_order
            ),
            userEmail: user?.email ?? "Unknown",
            userName: user?.full_name ?? null,
            waitingTime: now - new Date(d.created_at).getTime(),
          };
        })
        .filter((d): d is EnrichedDispute => d !== null);
    },
    staleTime: 30 * 1000,
  });

  const items = data ?? [];

  // ─── Filtering ────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (statusFilter !== "all" && item.dispute.status !== statusFilter) return false;

      if (search) {
        const q = search.toLowerCase();
        const titleMatch = item.submission.title.toLowerCase().includes(q);
        const emailMatch = item.userEmail.toLowerCase().includes(q);
        const nameMatch = item.userName?.toLowerCase().includes(q);
        const reasonMatch = item.dispute.reason.toLowerCase().includes(q);
        if (!titleMatch && !emailMatch && !nameMatch && !reasonMatch) return false;
      }

      return true;
    });
  }, [items, statusFilter, search]);

  // ─── Sorting ──────────────────────────────────────────────────────

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortField === "date") {
        return (new Date(a.dispute.created_at).getTime() - new Date(b.dispute.created_at).getTime()) * dir;
      }
      if (sortField === "waiting_time") {
        return (a.waitingTime - b.waitingTime) * dir;
      }
      return 0;
    });
  }, [filtered, sortField, sortDir]);

  // ─── Pagination ───────────────────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
    setPage(1);
  }

  // ─── Open Detail Dialog ───────────────────────────────────────────

  function openDetail(item: EnrichedDispute) {
    setSelectedDispute(item);
    setResolutionNotes("");
    setAdjustGrade(false);
    setAdjustedScores({
      fabric_condition_score: item.report.fabric_condition_score,
      structural_integrity_score: item.report.structural_integrity_score,
      cosmetic_appearance_score: item.report.cosmetic_appearance_score,
      functional_elements_score: item.report.functional_elements_score,
      odor_cleanliness_score: item.report.odor_cleanliness_score,
    });
    setPhotoUrls({});
  }

  // Load signed URLs for photos when detail dialog opens
  useEffect(() => {
    if (!selectedDispute || selectedDispute.images.length === 0) return;
    let cancelled = false;
    setLoadingPhotos(true);

    async function loadUrls() {
      const urls: Record<string, string> = {};
      for (const img of selectedDispute!.images) {
        try {
          urls[img.id] = await getImageUrl(img.storage_path);
        } catch {
          // Skip failed URLs
        }
      }
      if (!cancelled) {
        setPhotoUrls(urls);
        setLoadingPhotos(false);
      }
    }

    loadUrls();
    return () => { cancelled = true; };
  }, [selectedDispute]);

  // ─── Computed values ──────────────────────────────────────────────

  const computedOverallScore = useMemo(
    () => computeWeightedScore(adjustedScores),
    [adjustedScores]
  );

  // ─── Audit Logging ────────────────────────────────────────────────

  async function logAuditAction(
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown>
  ) {
    if (!profile) return;
    const entry: AdminAuditLogInsert = {
      admin_user_id: profile.id,
      action,
      target_type: targetType,
      target_id: targetId,
      details,
    };
    await supabase.from("admin_audit_log").insert(entry as never);
  }

  // ─── Actions ──────────────────────────────────────────────────────

  async function handleMarkUnderReview(item: EnrichedDispute) {
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from("disputes")
        .update({ status: "under_review" } as never)
        .eq("id", item.dispute.id);
      if (error) throw error;

      await logAuditAction("dispute_under_review", "dispute", item.dispute.id, {
        submission_id: item.submission.id,
        grade_report_id: item.report.id,
      });

      toast.success("Dispute marked as under review");
      queryClient.invalidateQueries({ queryKey: ["admin-disputes"] });
      setSelectedDispute(null);
    } catch (err) {
      toast.error("Failed to update dispute", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleResolve() {
    if (!selectedDispute || !profile) return;

    if (!resolutionNotes.trim()) {
      toast.error("Notes required", {
        description: "Please provide resolution notes explaining the decision.",
      });
      return;
    }

    setActionLoading(true);
    try {
      // If adjusting grade, create a human_review record and update the grade report
      if (adjustGrade) {
        const reviewInsert: HumanReviewInsert = {
          grade_report_id: selectedDispute.report.id,
          reviewer_id: profile.id,
          original_score: selectedDispute.report.overall_score,
          adjusted_score: computedOverallScore,
          review_notes: `Dispute resolution: ${resolutionNotes}`,
        };

        const { error: reviewError } = await supabase
          .from("human_reviews")
          .insert(reviewInsert as never);
        if (reviewError) throw reviewError;

        // Update grade report with adjusted scores
        const { error: updateError } = await supabase
          .from("grade_reports")
          .update({
            overall_score: computedOverallScore,
            fabric_condition_score: adjustedScores.fabric_condition_score,
            structural_integrity_score: adjustedScores.structural_integrity_score,
            cosmetic_appearance_score: adjustedScores.cosmetic_appearance_score,
            functional_elements_score: adjustedScores.functional_elements_score,
            odor_cleanliness_score: adjustedScores.odor_cleanliness_score,
          } as never)
          .eq("id", selectedDispute.report.id);
        if (updateError) throw updateError;
      }

      // Update dispute status to resolved
      const { error: disputeError } = await supabase
        .from("disputes")
        .update({
          status: "resolved",
          resolution_notes: resolutionNotes,
        } as never)
        .eq("id", selectedDispute.dispute.id);
      if (disputeError) throw disputeError;

      // Update submission status to completed
      const { error: subError } = await supabase
        .from("submissions")
        .update({ status: "completed" } as never)
        .eq("id", selectedDispute.submission.id);
      if (subError) throw subError;

      await logAuditAction("dispute_resolved", "dispute", selectedDispute.dispute.id, {
        submission_id: selectedDispute.submission.id,
        grade_report_id: selectedDispute.report.id,
        grade_adjusted: adjustGrade,
        original_score: selectedDispute.report.overall_score,
        new_score: adjustGrade ? computedOverallScore : selectedDispute.report.overall_score,
        resolution_notes: resolutionNotes,
      });

      // Send dispute resolved email notification (fire-and-forget)
      sendDisputeNotification(selectedDispute.dispute.id);

      toast.success("Dispute resolved", {
        description: adjustGrade
          ? `Grade adjusted from ${selectedDispute.report.overall_score.toFixed(1)} to ${computedOverallScore.toFixed(1)}.`
          : "Dispute resolved with original grade maintained.",
      });

      queryClient.invalidateQueries({ queryKey: ["admin-disputes"] });
      setSelectedDispute(null);
    } catch (err) {
      toast.error("Failed to resolve dispute", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReject() {
    if (!rejectTarget || !profile) return;

    if (!rejectReason.trim()) {
      toast.error("Reason required", {
        description: "Please provide a reason for rejecting the dispute.",
      });
      return;
    }

    setActionLoading(true);
    try {
      const { error: disputeError } = await supabase
        .from("disputes")
        .update({
          status: "rejected",
          resolution_notes: rejectReason,
        } as never)
        .eq("id", rejectTarget.dispute.id);
      if (disputeError) throw disputeError;

      // Update submission status back to completed
      const { error: subError } = await supabase
        .from("submissions")
        .update({ status: "completed" } as never)
        .eq("id", rejectTarget.submission.id);
      if (subError) throw subError;

      await logAuditAction("dispute_rejected", "dispute", rejectTarget.dispute.id, {
        submission_id: rejectTarget.submission.id,
        grade_report_id: rejectTarget.report.id,
        rejection_reason: rejectReason,
      });

      // Send dispute rejected email notification (fire-and-forget)
      sendDisputeNotification(rejectTarget.dispute.id);

      toast.success("Dispute rejected", {
        description: `Dispute for "${rejectTarget.submission.title}" has been rejected.`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-disputes"] });
      setSelectedDispute(null);
      setRejectTarget(null);
      setRejectReason("");
    } catch (err) {
      toast.error("Failed to reject dispute", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  function updateFactorScore(key: keyof FactorScores, value: string) {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    const clamped = Math.round(Math.min(10, Math.max(1, num)) * 2) / 2;
    setAdjustedScores((prev) => ({ ...prev, [key]: clamped }));
  }

  // ─── Stats ────────────────────────────────────────────────────────

  const openCount = items.filter((i) => i.dispute.status === "open").length;
  const underReviewCount = items.filter((i) => i.dispute.status === "under_review").length;
  const resolvedCount = items.filter((i) => i.dispute.status === "resolved").length;
  const rejectedCount = items.filter((i) => i.dispute.status === "rejected").length;

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Scale className="h-6 w-6 text-brand-red" />
          <h1 className="text-2xl font-bold">Disputes</h1>
          {openCount > 0 && (
            <Badge variant="destructive" className="ml-2">
              {openCount} open
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{underReviewCount} reviewing</Badge>
          <Badge variant="outline">{resolvedCount} resolved</Badge>
          <Badge variant="outline">{rejectedCount} rejected</Badge>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground">Open</p>
            <p className="text-2xl font-bold text-yellow-600">{openCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground">Under Review</p>
            <p className="text-2xl font-bold text-blue-600">{underReviewCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground">Resolved</p>
            <p className="text-2xl font-bold text-green-600">{resolvedCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground">Rejected</p>
            <p className="text-2xl font-bold text-red-600">{rejectedCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search title, email, reason..."
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
                setStatusFilter(v as StatusFilter);
                setPage(1);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="under_review">Under Review</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Dispute Queue Table */}
      {isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
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
                  <TableHead>User</TableHead>
                  <TableHead>Submission</TableHead>
                  <TableHead>Dispute Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("date")}
                    >
                      Created
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("waiting_time")}
                    >
                      Waiting
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      {statusFilter === "all"
                        ? "No disputes found."
                        : "No disputes match your filters."}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((item) => (
                    <TableRow
                      key={item.dispute.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => openDetail(item)}
                    >
                      <TableCell className="max-w-[150px] truncate">
                        <div>
                          <p className="font-medium text-sm truncate">
                            {item.userName ?? item.userEmail}
                          </p>
                          {item.userName && (
                            <p className="text-xs text-muted-foreground truncate">
                              {item.userEmail}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium max-w-[180px] truncate">
                        {item.submission.title}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">
                        {item.dispute.reason}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={STATUS_COLORS[item.dispute.status]}
                        >
                          {STATUS_LABELS[item.dispute.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(item.dispute.created_at)}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatWaitingTime(item.waitingTime)}
                        </span>
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
                            title="View details"
                            onClick={() => openDetail(item)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, sorted.length)} of {sorted.length}
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

      {/* ─── Dispute Detail Dialog ──────────────────────────────────── */}
      <Dialog
        open={!!selectedDispute}
        onOpenChange={(open) => {
          if (!open) setSelectedDispute(null);
        }}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-brand-red" />
              Dispute: {selectedDispute?.submission.title}
            </DialogTitle>
            <DialogDescription>
              {selectedDispute?.submission.garment_type} &middot;{" "}
              {selectedDispute?.userEmail} &middot; Disputed{" "}
              {selectedDispute ? formatDate(selectedDispute.dispute.created_at) : ""}
            </DialogDescription>
          </DialogHeader>

          {selectedDispute && (
            <div className="space-y-6">
              {/* Dispute Status Banner */}
              <div className="flex items-center gap-2">
                <Badge
                  variant="secondary"
                  className={`${STATUS_COLORS[selectedDispute.dispute.status]} text-sm px-3 py-1`}
                >
                  {STATUS_LABELS[selectedDispute.dispute.status]}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  Opened {formatDate(selectedDispute.dispute.created_at)} &middot;{" "}
                  Waiting {formatWaitingTime(selectedDispute.waitingTime)}
                </span>
              </div>

              {/* User's Dispute Reason */}
              <Card className="border-amber-200 bg-amber-50/50">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    User&apos;s Dispute Reason
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm whitespace-pre-wrap">
                    {selectedDispute.dispute.reason}
                  </p>
                </CardContent>
              </Card>

              {/* Original Grade Report */}
              <div className="grid grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Original Grade</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-bold">
                        {selectedDispute.report.overall_score.toFixed(1)}
                      </span>
                      <Badge variant="secondary">{selectedDispute.report.grade_tier}</Badge>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Confidence</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span className="text-3xl font-bold">
                      {(selectedDispute.report.confidence_score * 100).toFixed(1)}%
                    </span>
                  </CardContent>
                </Card>
              </div>

              {/* AI Summary */}
              <div>
                <h4 className="text-sm font-medium mb-2">AI Summary</h4>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap rounded-lg border bg-muted/30 p-3">
                  {selectedDispute.report.ai_summary}
                </p>
              </div>

              {/* Submission Photos */}
              <div>
                <h4 className="text-sm font-medium mb-3">Submission Photos</h4>
                {selectedDispute.images.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No photos available.</p>
                ) : loadingPhotos ? (
                  <div className="grid grid-cols-3 gap-3">
                    {selectedDispute.images.map((img) => (
                      <Skeleton key={img.id} className="aspect-square rounded-lg" />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    {selectedDispute.images.map((img) => (
                      <div key={img.id} className="relative">
                        {photoUrls[img.id] ? (
                          <img
                            src={photoUrls[img.id]}
                            alt={img.image_type}
                            className="aspect-square rounded-lg border object-cover"
                          />
                        ) : (
                          <div className="aspect-square rounded-lg border bg-muted flex items-center justify-center">
                            <ImageIcon className="h-8 w-8 text-muted-foreground" />
                          </div>
                        )}
                        <Badge
                          variant="secondary"
                          className="absolute bottom-2 left-2 text-xs capitalize"
                        >
                          {img.image_type}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Resolution Section — only for open/under_review disputes */}
              {(selectedDispute.dispute.status === "open" || selectedDispute.dispute.status === "under_review") && (
                <div className="space-y-4 border-t pt-4">
                  <h4 className="text-sm font-medium">Resolution</h4>

                  {/* Mark as under review button for open disputes */}
                  {selectedDispute.dispute.status === "open" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleMarkUnderReview(selectedDispute)}
                      disabled={actionLoading}
                    >
                      {actionLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Eye className="mr-2 h-4 w-4" />
                      )}
                      Mark as Under Review
                    </Button>
                  )}

                  {/* Grade adjustment toggle */}
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="adjust-grade"
                      checked={adjustGrade}
                      onChange={(e) => setAdjustGrade(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor="adjust-grade" className="text-sm">
                      Adjust grade as part of resolution
                    </Label>
                  </div>

                  {/* Factor score adjustment — only visible when adjusting */}
                  {adjustGrade && (
                    <div className="rounded-lg border p-4 space-y-3">
                      <h5 className="text-sm font-medium">Adjust Factor Scores</h5>
                      {FACTOR_KEYS.map((key) => {
                        const meta = FACTOR_META[key];
                        const aiScore = selectedDispute.report[key];
                        const adjustedScore = adjustedScores[key];
                        const diff = Math.abs(adjustedScore - aiScore);

                        return (
                          <div key={key} className="grid grid-cols-12 items-center gap-3">
                            <div className="col-span-5">
                              <Label className="text-sm">
                                {meta.label} ({(meta.weight * 100).toFixed(0)}%)
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Current: {aiScore.toFixed(1)}
                              </p>
                            </div>
                            <div className="col-span-4">
                              <Input
                                type="number"
                                min={1}
                                max={10}
                                step={0.5}
                                value={adjustedScore}
                                onChange={(e) => updateFactorScore(key, e.target.value)}
                                className="tabular-nums"
                              />
                            </div>
                            <div className="col-span-3 text-right">
                              {diff > 0 ? (
                                <span className={`text-sm font-medium ${diff > 1 ? "text-amber-600" : "text-blue-600"}`}>
                                  {adjustedScore > aiScore ? "+" : ""}
                                  {(adjustedScore - aiScore).toFixed(1)}
                                </span>
                              ) : (
                                <span className="text-sm text-muted-foreground">—</span>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {/* Computed overall */}
                      <div className="grid grid-cols-12 items-center gap-3 border-t pt-3">
                        <div className="col-span-5">
                          <Label className="text-sm font-medium">Weighted Overall</Label>
                          <p className="text-xs text-muted-foreground">
                            Current: {selectedDispute.report.overall_score.toFixed(1)}
                          </p>
                        </div>
                        <div className="col-span-4">
                          <span className="text-lg font-bold tabular-nums">
                            {computedOverallScore.toFixed(1)}
                          </span>
                        </div>
                        <div className="col-span-3 text-right">
                          {Math.abs(computedOverallScore - selectedDispute.report.overall_score) > 0 ? (
                            <span className="text-sm font-medium text-blue-600">
                              {computedOverallScore > selectedDispute.report.overall_score ? "+" : ""}
                              {(computedOverallScore - selectedDispute.report.overall_score).toFixed(1)}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">No change</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Resolution notes */}
                  <div>
                    <Label htmlFor="resolution-notes" className="text-sm font-medium">
                      Resolution Notes
                    </Label>
                    <Textarea
                      id="resolution-notes"
                      placeholder="Explain the resolution decision..."
                      value={resolutionNotes}
                      onChange={(e) => setResolutionNotes(e.target.value)}
                      rows={3}
                      className="mt-1"
                    />
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-3">
                    <Button
                      onClick={handleResolve}
                      disabled={actionLoading}
                      className="flex-1"
                    >
                      {actionLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : adjustGrade ? (
                        <Pencil className="mr-2 h-4 w-4" />
                      ) : (
                        <Check className="mr-2 h-4 w-4" />
                      )}
                      {adjustGrade ? "Resolve with Grade Adjustment" : "Resolve (Keep Original Grade)"}
                    </Button>

                    <Button
                      variant="destructive"
                      onClick={() => {
                        setRejectTarget(selectedDispute);
                        setRejectReason("");
                      }}
                      disabled={actionLoading}
                    >
                      <X className="mr-2 h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                </div>
              )}

              {/* Already resolved/rejected display */}
              {(selectedDispute.dispute.status === "resolved" || selectedDispute.dispute.status === "rejected") && (
                <div className={`rounded-lg border p-4 ${
                  selectedDispute.dispute.status === "resolved"
                    ? "border-green-200 bg-green-50"
                    : "border-red-200 bg-red-50"
                }`}>
                  <p className={`text-sm font-medium ${
                    selectedDispute.dispute.status === "resolved" ? "text-green-800" : "text-red-800"
                  }`}>
                    This dispute has been {selectedDispute.dispute.status}.
                  </p>
                  {selectedDispute.dispute.resolution_notes && (
                    <p className={`text-sm mt-2 ${
                      selectedDispute.dispute.status === "resolved" ? "text-green-700" : "text-red-700"
                    }`}>
                      <strong>Notes:</strong> {selectedDispute.dispute.resolution_notes}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Reject Confirmation Dialog ────────────────────────────── */}
      <AlertDialog
        open={!!rejectTarget}
        onOpenChange={() => {
          setRejectTarget(null);
          setRejectReason("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Dispute</AlertDialogTitle>
            <AlertDialogDescription>
              This will reject the user&apos;s dispute and keep the original grade. The
              submission status will return to &ldquo;completed&rdquo;.
              <br /><br />
              <strong>Submission:</strong> {rejectTarget?.submission.title}
              <br />
              <strong>Current Score:</strong> {rejectTarget?.report.overall_score.toFixed(1)}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="px-6 pb-2">
            <Label htmlFor="reject-reason" className="text-sm font-medium">
              Rejection Reason
            </Label>
            <Textarea
              id="reject-reason"
              placeholder="Explain why this dispute is being rejected..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              className="mt-1"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReject}
              disabled={actionLoading || !rejectReason.trim()}
              className="bg-red-600 hover:bg-red-700"
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reject Dispute
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

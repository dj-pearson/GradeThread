import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { getImageUrl } from "@/lib/storage";
import { GRADE_FACTORS } from "@/lib/constants";
import type {
  SubmissionRow,
  GradeReportRow,
  SubmissionImageRow,
  HumanReviewRow,
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
  MessageSquare,
  Search,
  ArrowUpDown,
  Eye,
  Check,
  Pencil,
  RotateCcw,
  Clock,
  AlertTriangle,
  Loader2,
  ImageIcon,
} from "lucide-react";
import { toast } from "sonner";

// ─── Types ──────────────────────────────────────────────────────────

interface EnrichedReviewItem {
  submission: SubmissionRow;
  report: GradeReportRow;
  images: SubmissionImageRow[];
  existingReview: HumanReviewRow | null;
  userEmail: string;
  userName: string | null;
  waitingTime: number; // ms since report created
}

type SortField = "waiting_time" | "confidence";
type SortDir = "asc" | "desc";
type ConfidenceFilter = "all" | "high" | "medium" | "low";
type ReviewFilter = "unreviewed" | "all";

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

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-green-600",
  medium: "text-yellow-600",
  low: "text-red-600",
};

function getConfidenceLevel(score: number): "high" | "medium" | "low" {
  if (score >= 0.85) return "high";
  if (score >= 0.75) return "medium";
  return "low";
}

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
  // Round to nearest 0.5
  return Math.round(total * 2) / 2;
}

const PAGE_SIZE = 20;

// ─── Main Component ─────────────────────────────────────────────────

export function AdminReviewsPage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  // Filters
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("unreviewed");
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [search, setSearch] = useState("");

  // Sort
  const [sortField, setSortField] = useState<SortField>("waiting_time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Pagination
  const [page, setPage] = useState(1);

  // Review dialog
  const [reviewingItem, setReviewingItem] = useState<EnrichedReviewItem | null>(null);
  const [reviewPhotoUrls, setReviewPhotoUrls] = useState<Record<string, string>>({});
  const [loadingPhotos, setLoadingPhotos] = useState(false);

  // Review form state
  const [adjustedScores, setAdjustedScores] = useState<FactorScores>({
    fabric_condition_score: 5,
    structural_integrity_score: 5,
    cosmetic_appearance_score: 5,
    functional_elements_score: 5,
    odor_cleanliness_score: 5,
  });
  const [reviewNotes, setReviewNotes] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // Reject confirmation
  const [rejectTarget, setRejectTarget] = useState<EnrichedReviewItem | null>(null);

  // ─── Data Fetching ────────────────────────────────────────────────

  const { data, isLoading } = useQuery({
    queryKey: ["admin-reviews"],
    queryFn: async () => {
      const [subsRes, reportsRes, imagesRes, reviewsRes, usersRes] = await Promise.all([
        supabase.from("submissions").select("*"),
        supabase.from("grade_reports").select("*"),
        supabase.from("submission_images").select("*"),
        supabase.from("human_reviews").select("*"),
        supabase.from("users").select("id, email, full_name"),
      ]);
      if (subsRes.error) throw subsRes.error;
      if (reportsRes.error) throw reportsRes.error;
      if (imagesRes.error) throw imagesRes.error;
      if (reviewsRes.error) throw reviewsRes.error;
      if (usersRes.error) throw usersRes.error;

      const submissions = (subsRes.data ?? []) as SubmissionRow[];
      const reports = (reportsRes.data ?? []) as GradeReportRow[];
      const images = (imagesRes.data ?? []) as SubmissionImageRow[];
      const reviews = (reviewsRes.data ?? []) as HumanReviewRow[];
      const users = (usersRes.data ?? []) as Pick<UserRow, "id" | "email" | "full_name">[];

      // Build lookup maps
      const reportMap = new Map<string, GradeReportRow>();
      for (const r of reports) reportMap.set(r.submission_id, r);

      const reviewByReport = new Map<string, HumanReviewRow>();
      for (const rv of reviews) reviewByReport.set(rv.grade_report_id, rv);

      const imagesBySubmission = new Map<string, SubmissionImageRow[]>();
      for (const img of images) {
        const list = imagesBySubmission.get(img.submission_id) ?? [];
        list.push(img);
        imagesBySubmission.set(img.submission_id, list);
      }

      const userMap = new Map<string, Pick<UserRow, "id" | "email" | "full_name">>();
      for (const u of users) userMap.set(u.id, u);

      const now = Date.now();

      // Only include completed submissions that have a grade report
      // and either have low confidence (<0.75) or are premium/express tier candidates
      return submissions
        .filter((s) => {
          const report = reportMap.get(s.id);
          if (!report) return false;
          // Include if low confidence (< 0.75) — the main review trigger
          if (report.confidence_score < 0.75) return true;
          // Also include already-reviewed items so they show in "all" filter
          if (reviewByReport.has(report.id)) return true;
          return false;
        })
        .map((s): EnrichedReviewItem => {
          const report = reportMap.get(s.id)!;
          const user = userMap.get(s.user_id);
          return {
            submission: s,
            report,
            images: (imagesBySubmission.get(s.id) ?? []).sort(
              (a, b) => a.display_order - b.display_order
            ),
            existingReview: reviewByReport.get(report.id) ?? null,
            userEmail: user?.email ?? "Unknown",
            userName: user?.full_name ?? null,
            waitingTime: now - new Date(report.created_at).getTime(),
          };
        });
    },
    staleTime: 30 * 1000,
  });

  const items = data ?? [];

  // ─── Filtering ────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return items.filter((item) => {
      // Reviewed filter
      if (reviewFilter === "unreviewed" && item.existingReview) return false;

      // Confidence filter
      if (confidenceFilter !== "all") {
        const level = getConfidenceLevel(item.report.confidence_score);
        if (confidenceFilter !== level) return false;
      }

      // Search
      if (search) {
        const q = search.toLowerCase();
        const titleMatch = item.submission.title.toLowerCase().includes(q);
        const emailMatch = item.userEmail.toLowerCase().includes(q);
        const nameMatch = item.userName?.toLowerCase().includes(q);
        if (!titleMatch && !emailMatch && !nameMatch) return false;
      }

      return true;
    });
  }, [items, reviewFilter, confidenceFilter, search]);

  // ─── Sorting ──────────────────────────────────────────────────────

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortField === "waiting_time") {
        return (a.waitingTime - b.waitingTime) * dir;
      }
      if (sortField === "confidence") {
        return (a.report.confidence_score - b.report.confidence_score) * dir;
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
      setSortDir(field === "waiting_time" ? "desc" : "asc");
    }
    setPage(1);
  }

  // ─── Open Review Dialog ───────────────────────────────────────────

  function openReview(item: EnrichedReviewItem) {
    setReviewingItem(item);
    // Initialize form with current AI scores
    setAdjustedScores({
      fabric_condition_score: item.report.fabric_condition_score,
      structural_integrity_score: item.report.structural_integrity_score,
      cosmetic_appearance_score: item.report.cosmetic_appearance_score,
      functional_elements_score: item.report.functional_elements_score,
      odor_cleanliness_score: item.report.odor_cleanliness_score,
    });
    setReviewNotes("");
    setReviewPhotoUrls({});
  }

  // Load signed URLs for photos when review dialog opens
  useEffect(() => {
    if (!reviewingItem || reviewingItem.images.length === 0) return;
    let cancelled = false;
    setLoadingPhotos(true);

    async function loadUrls() {
      const urls: Record<string, string> = {};
      for (const img of reviewingItem!.images) {
        try {
          urls[img.id] = await getImageUrl(img.storage_path);
        } catch {
          // Skip failed URLs
        }
      }
      if (!cancelled) {
        setReviewPhotoUrls(urls);
        setLoadingPhotos(false);
      }
    }

    loadUrls();
    return () => { cancelled = true; };
  }, [reviewingItem]);

  // ─── Computed review values ───────────────────────────────────────

  const computedOverallScore = useMemo(
    () => computeWeightedScore(adjustedScores),
    [adjustedScores]
  );

  const scoreDifference = reviewingItem
    ? Math.abs(computedOverallScore - reviewingItem.report.overall_score)
    : 0;

  const requiresSuperAdmin = scoreDifference > 1.5;
  const isSuperAdmin = profile?.role === "super_admin";

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

  async function handleApproveAsIs() {
    if (!reviewingItem || !profile) return;
    setActionLoading(true);
    try {
      // Create human_reviews record with original score (no adjustment)
      const reviewInsert: HumanReviewInsert = {
        grade_report_id: reviewingItem.report.id,
        reviewer_id: profile.id,
        original_score: reviewingItem.report.overall_score,
        adjusted_score: null,
        review_notes: reviewNotes || "Approved AI grade as-is.",
      };

      const { error } = await supabase
        .from("human_reviews")
        .insert(reviewInsert as never);
      if (error) throw error;

      await logAuditAction("approve_grade", "grade_report", reviewingItem.report.id, {
        submission_id: reviewingItem.submission.id,
        original_score: reviewingItem.report.overall_score,
        action: "approved_as_is",
      });

      toast.success("Grade approved", {
        description: `Grade ${reviewingItem.report.overall_score.toFixed(1)} approved for "${reviewingItem.submission.title}".`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-reviews"] });
      setReviewingItem(null);
    } catch (err) {
      toast.error("Failed to approve grade", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleAdjustAndApprove() {
    if (!reviewingItem || !profile) return;

    // Block if adjustment > 1.5 and not super_admin
    if (requiresSuperAdmin && !isSuperAdmin) {
      toast.error("Super admin approval required", {
        description: "Score adjustments greater than 1.5 points require super_admin approval.",
      });
      return;
    }

    if (!reviewNotes.trim()) {
      toast.error("Notes required", {
        description: "Please provide review notes explaining the score adjustment.",
      });
      return;
    }

    setActionLoading(true);
    try {
      // Create human_reviews record
      const reviewInsert: HumanReviewInsert = {
        grade_report_id: reviewingItem.report.id,
        reviewer_id: profile.id,
        original_score: reviewingItem.report.overall_score,
        adjusted_score: computedOverallScore,
        review_notes: reviewNotes,
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
        .eq("id", reviewingItem.report.id);
      if (updateError) throw updateError;

      await logAuditAction("adjust_grade", "grade_report", reviewingItem.report.id, {
        submission_id: reviewingItem.submission.id,
        original_score: reviewingItem.report.overall_score,
        adjusted_score: computedOverallScore,
        score_difference: scoreDifference,
        adjusted_factors: adjustedScores,
        notes: reviewNotes,
      });

      toast.success("Grade adjusted and approved", {
        description: `Grade updated from ${reviewingItem.report.overall_score.toFixed(1)} to ${computedOverallScore.toFixed(1)} for "${reviewingItem.submission.title}".`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-reviews"] });
      setReviewingItem(null);
    } catch (err) {
      toast.error("Failed to adjust grade", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRejectAndRegrade() {
    if (!rejectTarget || !profile) return;
    setActionLoading(true);
    try {
      // Create human_reviews record marking rejection
      const reviewInsert: HumanReviewInsert = {
        grade_report_id: rejectTarget.report.id,
        reviewer_id: profile.id,
        original_score: rejectTarget.report.overall_score,
        adjusted_score: null,
        review_notes: reviewNotes || "Rejected — sent for re-grading.",
      };

      const { error: reviewError } = await supabase
        .from("human_reviews")
        .insert(reviewInsert as never);
      if (reviewError) throw reviewError;

      // Reset submission to processing for re-grading
      const { error: updateError } = await supabase
        .from("submissions")
        .update({ status: "processing" } as never)
        .eq("id", rejectTarget.submission.id);
      if (updateError) throw updateError;

      await logAuditAction("reject_regrade", "grade_report", rejectTarget.report.id, {
        submission_id: rejectTarget.submission.id,
        original_score: rejectTarget.report.overall_score,
        confidence: rejectTarget.report.confidence_score,
        notes: reviewNotes,
      });

      toast.success("Submission sent for re-grading", {
        description: `"${rejectTarget.submission.title}" has been queued for re-grading.`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-reviews"] });
      setReviewingItem(null);
      setRejectTarget(null);
    } catch (err) {
      toast.error("Failed to reject grade", {
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

  const unreviewedCount = items.filter((i) => !i.existingReview).length;
  const reviewedCount = items.filter((i) => i.existingReview).length;

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-6 w-6 text-brand-red" />
          <h1 className="text-2xl font-bold">Human Reviews</h1>
          <Badge variant="secondary" className="ml-2">
            {unreviewedCount} pending
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{reviewedCount} reviewed</Badge>
          <Badge variant="outline">{items.length} total</Badge>
        </div>
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
                placeholder="Search title, email..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-9"
              />
            </div>

            {/* Review status */}
            <Select
              value={reviewFilter}
              onValueChange={(v) => {
                setReviewFilter(v as ReviewFilter);
                setPage(1);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Review Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unreviewed">Unreviewed Only</SelectItem>
                <SelectItem value="all">All (Including Reviewed)</SelectItem>
              </SelectContent>
            </Select>

            {/* Confidence */}
            <Select
              value={confidenceFilter}
              onValueChange={(v) => {
                setConfidenceFilter(v as ConfidenceFilter);
                setPage(1);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Confidence" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Confidence</SelectItem>
                <SelectItem value="high">High (&ge; 0.85)</SelectItem>
                <SelectItem value="medium">Medium (0.75–0.84)</SelectItem>
                <SelectItem value="low">Low (&lt; 0.75)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Queue Table */}
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
                  <TableHead>Title</TableHead>
                  <TableHead>Garment Type</TableHead>
                  <TableHead>AI Score</TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("confidence")}
                    >
                      Confidence
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("waiting_time")}
                    >
                      Waiting
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                      {reviewFilter === "unreviewed"
                        ? "No submissions pending human review."
                        : "No items match your filters."}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((item) => (
                    <TableRow
                      key={item.submission.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => openReview(item)}
                    >
                      <TableCell className="font-medium max-w-[200px] truncate">
                        {item.submission.title}
                      </TableCell>
                      <TableCell className="capitalize text-muted-foreground">
                        {item.submission.garment_type}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span
                          className={
                            item.report.overall_score >= 7
                              ? "text-green-600 font-medium"
                              : item.report.overall_score >= 5
                                ? "text-yellow-600 font-medium"
                                : "text-red-600 font-medium"
                          }
                        >
                          {item.report.overall_score.toFixed(1)}
                        </span>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span className={CONFIDENCE_COLORS[getConfidenceLevel(item.report.confidence_score)]}>
                          {(item.report.confidence_score * 100).toFixed(0)}%
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{item.report.grade_tier}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatWaitingTime(item.waitingTime)}
                        </span>
                      </TableCell>
                      <TableCell>
                        {item.existingReview ? (
                          <Badge className="bg-green-100 text-green-700">Reviewed</Badge>
                        ) : (
                          <Badge className="bg-yellow-100 text-yellow-700">Pending</Badge>
                        )}
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
                            title="Review"
                            onClick={() => openReview(item)}
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

      {/* ─── Review Detail Dialog ──────────────────────────────────── */}
      <Dialog
        open={!!reviewingItem}
        onOpenChange={(open) => {
          if (!open) setReviewingItem(null);
        }}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-brand-red" />
              Review: {reviewingItem?.submission.title}
            </DialogTitle>
            <DialogDescription>
              {reviewingItem?.submission.garment_type} &middot;{" "}
              {reviewingItem?.userEmail} &middot; Submitted{" "}
              {reviewingItem ? formatDate(reviewingItem.submission.created_at) : ""}
            </DialogDescription>
          </DialogHeader>

          {reviewingItem && (
            <div className="space-y-6">
              {/* Submitted Photos */}
              <div>
                <h4 className="text-sm font-medium mb-3">Submitted Photos</h4>
                {reviewingItem.images.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No photos available.</p>
                ) : loadingPhotos ? (
                  <div className="grid grid-cols-3 gap-3">
                    {reviewingItem.images.map((img) => (
                      <Skeleton key={img.id} className="aspect-square rounded-lg" />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    {reviewingItem.images.map((img) => (
                      <div key={img.id} className="relative">
                        {reviewPhotoUrls[img.id] ? (
                          <img
                            src={reviewPhotoUrls[img.id]}
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

              {/* AI Analysis Summary */}
              <div className="grid grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">AI Grade</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-bold">
                        {reviewingItem.report.overall_score.toFixed(1)}
                      </span>
                      <Badge variant="secondary">{reviewingItem.report.grade_tier}</Badge>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Confidence</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span
                      className={`text-3xl font-bold ${CONFIDENCE_COLORS[getConfidenceLevel(reviewingItem.report.confidence_score)]}`}
                    >
                      {(reviewingItem.report.confidence_score * 100).toFixed(1)}%
                    </span>
                    <p className="text-xs text-muted-foreground mt-1 capitalize">
                      {getConfidenceLevel(reviewingItem.report.confidence_score)} confidence
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* AI Summary Text */}
              <div>
                <h4 className="text-sm font-medium mb-2">AI Summary</h4>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap rounded-lg border bg-muted/30 p-3">
                  {reviewingItem.report.ai_summary}
                </p>
              </div>

              {/* AI Factor Scores vs Adjusted */}
              <div>
                <h4 className="text-sm font-medium mb-3">Factor Scores — Review & Adjust</h4>

                {/* Super admin warning */}
                {requiresSuperAdmin && (
                  <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                    <p className="text-sm text-amber-800">
                      Score adjustment &gt; 1.5 points ({scoreDifference.toFixed(1)} pts).
                      {isSuperAdmin
                        ? " You have super_admin permissions to approve this."
                        : " Requires super_admin approval."}
                    </p>
                  </div>
                )}

                <div className="space-y-3">
                  {FACTOR_KEYS.map((key) => {
                    const meta = FACTOR_META[key];
                    const aiScore = reviewingItem.report[key];
                    const adjustedScore = adjustedScores[key];
                    const diff = Math.abs(adjustedScore - aiScore);

                    return (
                      <div key={key} className="grid grid-cols-12 items-center gap-3">
                        <div className="col-span-5">
                          <Label className="text-sm">
                            {meta.label} ({(meta.weight * 100).toFixed(0)}%)
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            AI: {aiScore.toFixed(1)}
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
                        AI: {reviewingItem.report.overall_score.toFixed(1)}
                      </p>
                    </div>
                    <div className="col-span-4">
                      <span className="text-lg font-bold tabular-nums">
                        {computedOverallScore.toFixed(1)}
                      </span>
                    </div>
                    <div className="col-span-3 text-right">
                      {scoreDifference > 0 ? (
                        <span
                          className={`text-sm font-medium ${scoreDifference > 1.5 ? "text-red-600" : scoreDifference > 0.5 ? "text-amber-600" : "text-blue-600"}`}
                        >
                          {computedOverallScore > reviewingItem.report.overall_score ? "+" : ""}
                          {(computedOverallScore - reviewingItem.report.overall_score).toFixed(1)}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">No change</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Review Notes */}
              <div>
                <Label htmlFor="review-notes" className="text-sm font-medium">
                  Review Notes
                </Label>
                <Textarea
                  id="review-notes"
                  placeholder="Add notes about your review decision..."
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  rows={3}
                  className="mt-1"
                />
              </div>

              {/* Action Buttons */}
              {reviewingItem.existingReview ? (
                <div className="rounded-lg border bg-green-50 p-3">
                  <p className="text-sm text-green-800 font-medium">
                    This grade has already been reviewed.
                  </p>
                  {reviewingItem.existingReview.adjusted_score !== null && (
                    <p className="text-xs text-green-600 mt-1">
                      Score adjusted from {reviewingItem.existingReview.original_score.toFixed(1)} to{" "}
                      {reviewingItem.existingReview.adjusted_score.toFixed(1)}
                    </p>
                  )}
                  {reviewingItem.existingReview.review_notes && (
                    <p className="text-xs text-green-600 mt-1">
                      Notes: {reviewingItem.existingReview.review_notes}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3 border-t pt-4">
                  <Button
                    onClick={handleApproveAsIs}
                    disabled={actionLoading}
                    className="flex-1"
                  >
                    {actionLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-2 h-4 w-4" />
                    )}
                    Approve As-Is
                  </Button>

                  <Button
                    variant="secondary"
                    onClick={handleAdjustAndApprove}
                    disabled={actionLoading || scoreDifference === 0 || (requiresSuperAdmin && !isSuperAdmin)}
                    className="flex-1"
                  >
                    {actionLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Pencil className="mr-2 h-4 w-4" />
                    )}
                    Adjust & Approve
                  </Button>

                  <Button
                    variant="destructive"
                    onClick={() => setRejectTarget(reviewingItem)}
                    disabled={actionLoading}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Reject & Re-grade
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Reject Confirmation Dialog ────────────────────────────── */}
      <AlertDialog open={!!rejectTarget} onOpenChange={() => setRejectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject & Re-grade</AlertDialogTitle>
            <AlertDialogDescription>
              This will reset the submission to &ldquo;processing&rdquo; and queue it for
              re-grading by the AI. The current grade report will remain until a new one
              is generated.
              <br /><br />
              <strong>Submission:</strong> {rejectTarget?.submission.title}
              <br />
              <strong>Current Score:</strong> {rejectTarget?.report.overall_score.toFixed(1)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRejectAndRegrade}
              disabled={actionLoading}
              className="bg-red-600 hover:bg-red-700"
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reject & Re-grade
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

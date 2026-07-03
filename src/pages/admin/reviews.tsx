import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import { GRADE_FACTORS } from "@/lib/constants";
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
  CheckCircle2,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { toast } from "sonner";

// US-775: low-confidence human-review queue. All reads + mutations go through the
// admin-MFA-gated edge endpoints (/api/admin/grading/review*). The server records
// the original AI grade for the self-improvement dataset and — critically —
// reseals the certificate integrity hash on an adjustment (the browser can't, so
// the old client-side path left adjusted certificates verifying as tampered).

// ─── Types ──────────────────────────────────────────────────────────

interface FactorScores {
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
}

interface QueueItem {
  report_id: string;
  submission_id: string;
  title: string | null;
  garment_type: string | null;
  garment_category: string | null;
  user_email: string | null;
  user_name: string | null;
  overall_score: number;
  grade_tier: string;
  confidence_score: number;
  confidence_label: string | null;
  factor_scores: FactorScores;
  ai_summary: string;
  // US-1536: peer-norm outlier context when this grade was flagged
  // ("similar items: median 6.5, n=23") — why it landed in review.
  peer_norm?: string | null;
  created_at: string;
  waiting_ms: number;
}

interface QueueResponse {
  data: QueueItem[];
  count: number;
  queue_age_seconds: number;
}

interface ReviewImage {
  id: string;
  image_type: string;
  storage_path: string;
  display_order: number;
  signed_url: string | null;
}

type SortField = "waiting_time" | "confidence";
type SortDir = "asc" | "desc";
type ConfidenceFilter = "all" | "high" | "medium" | "low";

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
  high: "text-green-600 dark:text-green-400",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-red-600 dark:text-red-400",
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

// The 5 factors are graded in 0.5 steps, but the OVERALL is rounded to 0.1 so a
// single-factor adjustment moves it (mirrors the edge: ai-grading.roundToTenth +
// human-review.computeWeightedOverall — keep all three in lockstep).
function computeWeightedScore(factors: FactorScores): number {
  let total = 0;
  for (const key of FACTOR_KEYS) {
    total += factors[key] * FACTOR_META[key].weight;
  }
  return Math.round(total * 10) / 10;
}

const PAGE_SIZE = 20;

// ─── Main Component ─────────────────────────────────────────────────

export function AdminReviewsPage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  // Filters
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [search, setSearch] = useState("");

  // Sort
  const [sortField, setSortField] = useState<SortField>("waiting_time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Pagination
  const [page, setPage] = useState(1);

  // Review dialog
  const [reviewingItem, setReviewingItem] = useState<QueueItem | null>(null);
  const [reviewImages, setReviewImages] = useState<ReviewImage[]>([]);
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
  const [intentionalMisread, setIntentionalMisread] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Review/send-back dialog VISIBILITY is decoupled from their data
  // (reviewingItem / rejectTarget) so we can hide a dialog without discarding
  // the in-progress review. This matters for step-up MFA: stacking the
  // MfaStepUpDialog on top of an open review modal leaves the review dialog
  // aria-hidden with a stuck pointer-events lock (Radix), which silently kills
  // its buttons ("Adjust & Approve" appears unclickable). We instead keep only
  // ONE modal open at a time — hide the parent, show step-up, then restore.
  const [reviewOpen, setReviewOpen] = useState(false);

  // Send-back confirmation
  const [rejectTarget, setRejectTarget] = useState<QueueItem | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);

  function closeReview() {
    setReviewOpen(false);
    setReviewingItem(null);
  }
  function closeReject() {
    setRejectOpen(false);
    setRejectTarget(null);
  }

  // Step-up MFA: the approve/adjust/send-back endpoints require a *fresh* (≤5 min)
  // second-factor verification. On a 403 STEP_UP_REQUIRED we stash the action and
  // open MfaStepUpDialog, which re-verifies TOTP (re-stamping the session's amr
  // timestamp) and then re-runs the stashed action — no logout/login needed.
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  function handleStepUp(retryFn: () => void) {
    // Hide the parent modal(s) so the step-up dialog is the ONLY open modal —
    // their data is preserved (reviewingItem / rejectTarget) for the retry.
    setReviewOpen(false);
    setRejectOpen(false);
    setRetry(() => retryFn);
    setStepUpOpen(true);
  }

  // When the step-up dialog closes (verified or cancelled), bring the parent
  // modal back so the admin lands where they left off.
  function restoreParentAfterStepUp() {
    if (rejectTarget) setRejectOpen(true);
    else if (reviewingItem) setReviewOpen(true);
  }

  // True when the body of a 403 says step-up is required — open the dialog + retry.
  function isStepUpRequired(status: number, json: unknown): boolean {
    return status === 403 && (json as { code?: string })?.code === "STEP_UP_REQUIRED";
  }

  // ─── Data Fetching (admin edge endpoint) ──────────────────────────

  const { data, isLoading } = useQuery({
    queryKey: ["admin-review-queue"],
    queryFn: async (): Promise<QueueResponse> => {
      const res = await edgeFetch("/api/admin/grading/review-queue");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load review queue.");
      return json as QueueResponse;
    },
    staleTime: 30 * 1000,
  });

  const items = useMemo(() => data?.data ?? [], [data]);
  const queueAgeSeconds = data?.queue_age_seconds ?? 0;

  // ─── Filtering ────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (confidenceFilter !== "all") {
        const level = getConfidenceLevel(item.confidence_score);
        if (confidenceFilter !== level) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        const titleMatch = item.title?.toLowerCase().includes(q);
        const emailMatch = item.user_email?.toLowerCase().includes(q);
        const nameMatch = item.user_name?.toLowerCase().includes(q);
        if (!titleMatch && !emailMatch && !nameMatch) return false;
      }
      return true;
    });
  }, [items, confidenceFilter, search]);

  // ─── Sorting ──────────────────────────────────────────────────────

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortField === "waiting_time") return (a.waiting_ms - b.waiting_ms) * dir;
      if (sortField === "confidence") return (a.confidence_score - b.confidence_score) * dir;
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

  function openReview(item: QueueItem) {
    setReviewingItem(item);
    setReviewOpen(true);
    setAdjustedScores({ ...item.factor_scores });
    setReviewNotes("");
    setIntentionalMisread(false);
    setReviewImages([]);
  }

  // Load the full detail (incl. ≤900s signed photo URLs) when a review opens.
  useEffect(() => {
    if (!reviewingItem) return;
    let cancelled = false;
    setLoadingPhotos(true);
    (async () => {
      try {
        const res = await edgeFetch(`/api/admin/grading/review/${reviewingItem.report_id}`);
        const json = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setReviewImages((json.images ?? []) as ReviewImage[]);
        }
      } finally {
        if (!cancelled) setLoadingPhotos(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reviewingItem]);

  // ─── Computed review values ───────────────────────────────────────

  const computedOverallScore = useMemo(
    () => computeWeightedScore(adjustedScores),
    [adjustedScores]
  );

  const scoreDifference = reviewingItem
    ? Math.abs(computedOverallScore - reviewingItem.overall_score)
    : 0;

  // Whether the reviewer changed ANY factor from the AI's original scores. This
  // — not a move in the rounded overall — gates "Adjust & Approve", so a single
  // factor correction is always submittable even when the lightest (10% Odor)
  // factor's 0.5 nudge doesn't quite cross a 0.1 overall boundary.
  const factorsChanged = useMemo(
    () =>
      !!reviewingItem &&
      FACTOR_KEYS.some(
        (key) => adjustedScores[key] !== reviewingItem.factor_scores[key],
      ),
    [adjustedScores, reviewingItem],
  );

  const requiresSuperAdmin = scoreDifference > 1.5;
  const isSuperAdmin = profile?.role === "super_admin";

  // ─── Actions ──────────────────────────────────────────────────────

  async function handleApproveAsIs() {
    if (!reviewingItem) return;
    setActionLoading(true);
    try {
      const res = await edgeFetch(
        `/api/admin/grading/review/${reviewingItem.report_id}/approve`,
        { method: "POST", json: { notes: reviewNotes }, silentGate: true },
      );
      const json = await res.json().catch(() => ({}));
      if (isStepUpRequired(res.status, json)) {
        handleStepUp(() => void handleApproveAsIs());
        return;
      }
      if (!res.ok) throw new Error(json.error || "Approve failed.");
      toast.success("Grade approved", {
        description: `Grade ${reviewingItem.overall_score.toFixed(1)} approved for "${reviewingItem.title ?? ""}".`,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-review-queue"] });
      closeReview();
    } catch (err) {
      toast.error("Failed to approve grade", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleAdjustAndApprove() {
    if (!reviewingItem) return;
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
      const res = await edgeFetch(
        `/api/admin/grading/review/${reviewingItem.report_id}/adjust`,
        {
          method: "POST",
          json: {
            factors: adjustedScores,
            notes: reviewNotes,
            intentional_misread: intentionalMisread,
          },
          silentGate: true,
        },
      );
      const json = await res.json().catch(() => ({}));
      if (isStepUpRequired(res.status, json)) {
        handleStepUp(() => void handleAdjustAndApprove());
        return;
      }
      if (!res.ok) throw new Error(json.error || "Adjust failed.");
      toast.success("Grade adjusted and approved", {
        description: `Grade updated from ${reviewingItem.overall_score.toFixed(1)} to ${Number(json.overall_score).toFixed(1)}${json.resealed ? " (certificate resealed)" : ""}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-review-queue"] });
      closeReview();
    } catch (err) {
      toast.error("Failed to adjust grade", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSendBack() {
    if (!rejectTarget) return;
    setActionLoading(true);
    try {
      const res = await edgeFetch(
        `/api/admin/grading/review/${rejectTarget.report_id}/send-back`,
        { method: "POST", json: { notes: reviewNotes }, silentGate: true },
      );
      const json = await res.json().catch(() => ({}));
      if (isStepUpRequired(res.status, json)) {
        handleStepUp(() => void handleSendBack());
        return;
      }
      if (!res.ok) throw new Error(json.error || "Send-back failed.");
      toast.success("Sent back for better photos", {
        description: `"${rejectTarget.title ?? ""}" was returned to the seller for clearer photos.`,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-review-queue"] });
      closeReview();
      closeReject();
    } catch (err) {
      toast.error("Failed to send back", {
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

  // ─── Render ───────────────────────────────────────────────────────

  const pendingCount = items.length;
  const slaBreaching = queueAgeSeconds >= 24 * 3600; // oldest item waited > 24h

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-6 w-6 text-brand-red-text" />
          <h1 className="text-2xl font-bold">Human Reviews</h1>
          <Badge variant="secondary" className="ml-2">
            {pendingCount} pending
          </Badge>
        </div>
        {pendingCount > 0 && (
          <Badge
            variant="outline"
            className={slaBreaching ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300" : ""}
          >
            <Clock className="mr-1 h-3 w-3" />
            Oldest waiting {formatWaitingTime(queueAgeSeconds * 1000)}
          </Badge>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
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
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="p-0">
                      <EmptyState
                        icon={CheckCircle2}
                        title="Review queue is clear"
                        description="No submissions are pending human review right now. Low-confidence grades will appear here for adjustment."
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((item) => (
                    <TableRow
                      key={item.report_id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => openReview(item)}
                    >
                      <TableCell className="font-medium max-w-[200px] truncate">
                        {item.title ?? "—"}
                      </TableCell>
                      <TableCell className="capitalize text-muted-foreground">
                        {item.garment_type ?? "—"}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span
                          className={
                            item.overall_score >= 7
                              ? "text-green-600 font-medium dark:text-green-400"
                              : item.overall_score >= 5
                                ? "text-yellow-600 font-medium dark:text-yellow-400"
                                : "text-red-600 font-medium dark:text-red-400"
                          }
                        >
                          {item.overall_score.toFixed(1)}
                        </span>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span className={CONFIDENCE_COLORS[getConfidenceLevel(item.confidence_score)]}>
                          {(item.confidence_score * 100).toFixed(0)}%
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{item.grade_tier}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatWaitingTime(item.waiting_ms)}
                        </span>
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
        open={reviewOpen}
        onOpenChange={(open) => {
          if (!open) closeReview();
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] max-w-4xl max-h-[90vh] overflow-y-auto overflow-x-hidden p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 shrink-0 text-brand-red-text" />
              <span className="min-w-0 break-words">Review: {reviewingItem?.title}</span>
            </DialogTitle>
            <DialogDescription className="break-words">
              {reviewingItem?.garment_type} &middot; {reviewingItem?.user_email} &middot;
              {" "}Submitted {reviewingItem ? formatDate(reviewingItem.created_at) : ""}
            </DialogDescription>
          </DialogHeader>

          {reviewingItem && (
            <div className="space-y-6">
              {/* Submitted Photos */}
              <div>
                <h4 className="text-sm font-medium mb-3">Submitted Photos</h4>
                {loadingPhotos ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="aspect-square rounded-lg" />
                    ))}
                  </div>
                ) : reviewImages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No photos available.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {reviewImages.map((img) => (
                      <div key={img.id} className="relative">
                        {img.signed_url ? (
                          <img
                            src={img.signed_url}
                            alt={img.image_type}
                            loading="lazy"
                            decoding="async"
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

              {/* AI Grade + Confidence */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">AI Grade</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-bold">
                        {reviewingItem.overall_score.toFixed(1)}
                      </span>
                      <Badge variant="secondary">{reviewingItem.grade_tier}</Badge>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Confidence</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span
                      className={`text-3xl font-bold ${CONFIDENCE_COLORS[getConfidenceLevel(reviewingItem.confidence_score)]}`}
                    >
                      {(reviewingItem.confidence_score * 100).toFixed(1)}%
                    </span>
                    <p className="text-xs text-muted-foreground mt-1 capitalize">
                      {getConfidenceLevel(reviewingItem.confidence_score)} confidence
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* AI Summary */}
              <div>
                <h4 className="text-sm font-medium mb-2">AI Summary</h4>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3">
                  {reviewingItem.ai_summary}
                </p>
              </div>

              {/* US-1536: peer-distribution line for peer-norm-flagged grades —
                  the reviewer sees how similar items graded before adjusting. */}
              {reviewingItem.peer_norm && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/40">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="text-sm text-amber-800 dark:text-amber-300">
                    Peer-norm outlier: {reviewingItem.peer_norm.replace(/^peer_norm:\s*/, "")}
                  </p>
                </div>
              )}

              {/* Factor Scores — review & adjust */}
              <div>
                <h4 className="text-sm font-medium mb-3">Factor Scores — Review & Adjust</h4>

                {requiresSuperAdmin && (
                  <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/40">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 dark:text-amber-400" />
                    <p className="text-sm text-amber-800 dark:text-amber-300">
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
                    const aiScore = reviewingItem.factor_scores[key];
                    const adjustedScore = adjustedScores[key];
                    const diff = Math.abs(adjustedScore - aiScore);
                    return (
                      <div key={key} className="grid grid-cols-12 items-center gap-2 sm:gap-3">
                        <div className="col-span-6 min-w-0 sm:col-span-5">
                          <Label className="text-sm break-words">
                            {meta.label} ({(meta.weight * 100).toFixed(0)}%)
                          </Label>
                          <p className="text-xs text-muted-foreground">AI: {aiScore.toFixed(1)}</p>
                        </div>
                        <div className="col-span-4 min-w-0 sm:col-span-4">
                          <Input
                            type="number"
                            min={1}
                            max={10}
                            step={0.5}
                            value={adjustedScore}
                            onChange={(e) => updateFactorScore(key, e.target.value)}
                            className="w-full tabular-nums"
                          />
                        </div>
                        <div className="col-span-2 text-right sm:col-span-3">
                          {diff > 0 ? (
                            <span className={`text-sm font-medium ${diff > 1 ? "text-amber-600 dark:text-amber-400" : "text-blue-600 dark:text-blue-400"}`}>
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

                  <div className="grid grid-cols-12 items-center gap-2 border-t pt-3 sm:gap-3">
                    <div className="col-span-6 min-w-0 sm:col-span-5">
                      <Label className="text-sm font-medium">Weighted Overall</Label>
                      <p className="text-xs text-muted-foreground">
                        AI: {reviewingItem.overall_score.toFixed(1)}
                      </p>
                    </div>
                    <div className="col-span-4 min-w-0 sm:col-span-4">
                      <span className="text-lg font-bold tabular-nums">
                        {computedOverallScore.toFixed(1)}
                      </span>
                    </div>
                    <div className="col-span-2 text-right sm:col-span-3">
                      {scoreDifference > 0 ? (
                        <span
                          className={`text-sm font-medium ${scoreDifference > 1.5 ? "text-red-600 dark:text-red-400" : scoreDifference > 0.5 ? "text-amber-600 dark:text-amber-400" : "text-blue-600 dark:text-blue-400"}`}
                        >
                          {computedOverallScore > reviewingItem.overall_score ? "+" : ""}
                          {(computedOverallScore - reviewingItem.overall_score).toFixed(1)}
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

              {/* Intentional-design misread flag */}
              <div className="flex items-start gap-2">
                <input
                  id="intentional-misread"
                  type="checkbox"
                  checked={intentionalMisread}
                  onChange={(e) => setIntentionalMisread(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-input"
                />
                <Label
                  htmlFor="intentional-misread"
                  className="text-sm font-normal leading-snug text-muted-foreground"
                >
                  AI mistook an intentional design feature (e.g. factory distressing, raw hem) for damage
                </Label>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:gap-3">
                <Button onClick={handleApproveAsIs} disabled={actionLoading} className="w-full sm:flex-1">
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
                  disabled={actionLoading || !factorsChanged || (requiresSuperAdmin && !isSuperAdmin)}
                  className="w-full sm:flex-1"
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
                  className="w-full sm:w-auto"
                  onClick={() => {
                    setRejectTarget(reviewingItem);
                    setRejectOpen(true);
                  }}
                  disabled={actionLoading}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Send Back
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Send-Back Confirmation ────────────────────────────────── */}
      <AlertDialog
        open={rejectOpen}
        onOpenChange={(o) => {
          if (!o) closeReject();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send back for better photos</AlertDialogTitle>
            <AlertDialogDescription>
              This returns the submission to &ldquo;needs photos&rdquo; so the seller can
              retake the flagged photos and resubmit. The certificate is withheld and the
              seller is not charged.
              <br /><br />
              <strong>Submission:</strong> {rejectTarget?.title}
              <br />
              <strong>Current Score:</strong> {rejectTarget?.overall_score.toFixed(1)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSendBack}
              disabled={actionLoading}
              className="bg-red-600 hover:bg-red-700"
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Step-up MFA re-verification — opened when a mutate returns 403
          STEP_UP_REQUIRED; on success it re-runs the stashed action. */}
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={(o) => {
          setStepUpOpen(o);
          // Closing (verified OR cancelled) → restore the parent modal so the
          // admin isn't dropped back to the bare queue.
          if (!o) restoreParentAfterStepUp();
        }}
        onVerified={() => retry?.()}
      />
    </div>
  );
}

import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { getImageUrl } from "@/lib/storage";
import { promoteEvalCandidate } from "@/lib/eval-candidates";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeFetch } from "@/lib/edge-fetch";
import { GRADE_FACTORS } from "@/lib/constants";
import {
  computeWeightedOverall as sharedWeightedOverall,
  type WeightedFactorScores,
} from "@/lib/weighted-grade";
import type {
  DisputeRow,
  DisputeStatus,
  SubmissionRow,
  GradeReportRow,
  SubmissionImageRow,
  UserRow,
} from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
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
import { ClickableRow } from "@/components/clickable-row";
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
import { SearchInput } from "@/components/search-input";
import { toast } from "sonner";
// US-2332: lazy façade — see lib/sentry.ts.
import { captureException } from "@/lib/sentry";

// Notify the submitter of a dispute status change (in-app always, email on
// resolve/reject). Best-effort — never blocks the admin action. Uses the edge
// (functions) host, not the Supabase host.
async function sendDisputeNotification(disputeId: string): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;

    await fetch(`${edgeApiUrl()}/api/notifications/dispute-status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ disputeId }),
    });
  } catch (err) {
    // US-785: the status change already succeeded — only the user notification
    // failed. Surface it to the admin + Sentry instead of swallowing it.
    if (import.meta.env.DEV) console.error("[Disputes] Failed to send status notification:", err);
    captureException(err, { tags: { area: "admin.dispute_notification" } });
    toast.warning("Status updated, but the user notification failed to send.");
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

// US-2386: FactorScores IS WeightedFactorScores. It used to be a local
// re-declaration of the same five keys, and every call into the shared
// computeWeightedOverall cast across the two — a cast that was harmless only
// while the shapes happened to match, and would have silently swallowed a
// dropped or renamed key the moment they stopped. An alias makes the compiler
// hold what the cast was asking a reader to hold.
type FactorScores = WeightedFactorScores;

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
  open: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
  under_review: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  resolved: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
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

// US-2034: delegates to the ONE shared implementation. This used to be a
// local copy of the weighted-sum + rounding; disputes.tsx's copy had drifted
// to 0.5 rounding while the server stored 0.1, so an operator saw a number
// the certificate did not get. See src/lib/weighted-grade.ts.
function computeWeightedScore(factors: FactorScores): number {
  return sharedWeightedOverall(factors);
}

const PAGE_SIZE = 20;
// US-2025: hard bound on the dispute set this console loads. The page is a
// triage queue ordered newest-first, so an operator works the head of it — but
// the query behind it was unbounded, and it also anchors the cascade that pulls
// reports/submissions/images. 500 is generous for a queue that should normally
// sit in the low tens; if it is ever hit, the queue itself is the incident.
const DISPUTE_LIMIT = 500;

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
  // US-2364: which photos FAILED to resolve, as opposed to not being there. A
  // reviewer deciding a dispute has to be able to tell "the buyer sent no photo
  // of the sleeve" from "we could not fetch the photo of the sleeve" — the two
  // rendered identically, and the second one silently weakens the evidence the
  // decision rests on.
  const [photoErrors, setPhotoErrors] = useState<Record<string, string>>({});
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  // US-1416: signed URLs for the filer's attached evidence photos. These live
  // in another user's storage folder, so they must be signed server-side via
  // the admin edge endpoint (admins have no client-side storage read policy).
  const [evidenceUrls, setEvidenceUrls] = useState<string[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);

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

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["admin-disputes"],
    queryFn: async () => {
      // US-2025: fetch as a DEPENDENT CASCADE off the disputes actually shown.
      //
      // This used to be five unbounded select("*") calls in one Promise.all —
      // the ENTIRE disputes, submissions, grade_reports, submission_images and
      // users tables — assembled into maps client-side just to enrich a dispute
      // list. submissions and grade_reports are platform-wide and append-only,
      // so at 100k graded submissions this transferred hundreds of MB into a
      // browser. It does not degrade gracefully: it works, then abruptly OOMs
      // or times out — the worst shape for a console someone reaches for DURING
      // an incident.
      //
      // Everything here hangs off `disputes`, so bound THAT and derive the rest
      // by id. Each step is still parallel where it can be.
      const disputesRes = await supabase
        .from("disputes")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(DISPUTE_LIMIT);
      if (disputesRes.error) throw disputesRes.error;
      const disputes = (disputesRes.data ?? []) as DisputeRow[];

      if (disputes.length === 0) return [];

      const reportIds = [...new Set(disputes.map((d) => d.grade_report_id))];
      const userIds = [...new Set(disputes.map((d) => d.user_id))];

      const [reportsRes, usersRes] = await Promise.all([
        supabase.from("grade_reports").select("*").in("id", reportIds),
        supabase.from("users").select("id, email, full_name").in("id", userIds),
      ]);
      if (reportsRes.error) throw reportsRes.error;
      if (usersRes.error) throw usersRes.error;
      const reports = (reportsRes.data ?? []) as GradeReportRow[];
      const users = (usersRes.data ?? []) as Pick<UserRow, "id" | "email" | "full_name">[];

      // Submissions + their images are reachable only via the reports above.
      const submissionIds = [...new Set(reports.map((r) => r.submission_id))];
      const [subsRes, imagesRes] = submissionIds.length > 0
        ? await Promise.all([
          supabase.from("submissions").select("*").in("id", submissionIds),
          supabase
            .from("submission_images")
            .select("*")
            .in("submission_id", submissionIds),
        ])
        : [{ data: [], error: null }, { data: [], error: null }];
      if (subsRes.error) throw subsRes.error;
      if (imagesRes.error) throw imagesRes.error;

      const submissions = (subsRes.data ?? []) as SubmissionRow[];
      const images = (imagesRes.data ?? []) as SubmissionImageRow[];

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

  const items = useMemo(() => data ?? [], [data]);

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
    setPhotoErrors({});
  }

  // Load signed URLs for photos when detail dialog opens
  useEffect(() => {
    if (!selectedDispute || selectedDispute.images.length === 0) return;
    let cancelled = false;
    setLoadingPhotos(true);

    async function loadUrls() {
      const urls: Record<string, string> = {};
      const errors: Record<string, string> = {};
      for (const img of selectedDispute!.images) {
        try {
          urls[img.id] = await getImageUrl(img.storage_path);
        } catch (err) {
          errors[img.id] = err instanceof Error ? err.message : String(err);
        }
      }
      if (!cancelled) {
        setPhotoUrls(urls);
        setPhotoErrors(errors);
        setLoadingPhotos(false);
      }
    }

    loadUrls();
    return () => { cancelled = true; };
  }, [selectedDispute]);

  // US-1416: load the filer's evidence photos (signed server-side) when the
  // detail dialog opens.
  useEffect(() => {
    const paths = selectedDispute?.dispute.evidence_paths ?? [];
    setEvidenceUrls([]);
    if (!selectedDispute || paths.length === 0) return;
    let cancelled = false;
    setLoadingEvidence(true);

    (async () => {
      try {
        const res = await edgeFetch(
          `/api/admin/disputes/${selectedDispute.dispute.id}/evidence`,
        );
        const json = (await res.json().catch(() => ({}))) as { urls?: string[] };
        if (!cancelled && res.ok) setEvidenceUrls(json.urls ?? []);
      } catch {
        /* best-effort — the reason text still shows */
      } finally {
        if (!cancelled) setLoadingEvidence(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedDispute]);

  // ─── Computed values ──────────────────────────────────────────────

  const computedOverallScore = useMemo(
    () => computeWeightedScore(adjustedScores),
    [adjustedScores]
  );

  // ─── Actions ──────────────────────────────────────────────────────
  //
  // US-474: every dispute mutation goes through the admin-MFA-gated edge
  // endpoints (/api/admin/disputes/*). The browser Supabase client can't write
  // grade_reports/disputes/submissions (no admin UPDATE policy — those calls
  // no-oped under RLS while reporting success), and only the edge can reseal a
  // certificate after a grade adjustment. The server records the audit trail +
  // human_review and verifies each write changed a row.

  async function handleMarkUnderReview(item: EnrichedDispute) {
    setActionLoading(true);
    try {
      const res = await edgeFetch(
        `/api/admin/disputes/${item.dispute.id}/under-review`,
        { method: "POST", body: JSON.stringify({}) },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to update dispute.");

      // Notify the submitter their dispute is being reviewed.
      sendDisputeNotification(item.dispute.id);

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

    // US-478 parity: a swing > 1.5 points requires super_admin (the server
    // enforces this too — this is just an early, friendlier block).
    const scoreDiff = Math.abs(computedOverallScore - selectedDispute.report.overall_score);
    if (adjustGrade && scoreDiff > 1.5 && profile.role !== "super_admin") {
      toast.error("Super admin approval required", {
        description: "Grade changes greater than 1.5 points require super_admin approval.",
      });
      return;
    }

    setActionLoading(true);
    try {
      const res = await edgeFetch(
        `/api/admin/disputes/${selectedDispute.dispute.id}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            notes: resolutionNotes,
            adjustGrade,
            factors: adjustGrade ? adjustedScores : undefined,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to resolve dispute.");

      // US-329: a dispute resolved by adjusting the grade is a high-value
      // correction — promote it into a pending eval candidate (best-effort).
      if (adjustGrade) {
        await promoteEvalCandidate(selectedDispute.report.id, "dispute");
      }

      // Send dispute resolved email notification (fire-and-forget)
      sendDisputeNotification(selectedDispute.dispute.id);

      const newScore = typeof json.overall_score === "number"
        ? json.overall_score
        : computedOverallScore;
      toast.success("Dispute resolved", {
        description: adjustGrade
          ? `Grade adjusted from ${selectedDispute.report.overall_score.toFixed(1)} to ${newScore.toFixed(1)}${json.resealed ? " (certificate resealed)" : ""}.`
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
      const res = await edgeFetch(
        `/api/admin/disputes/${rejectTarget.dispute.id}/reject`,
        { method: "POST", body: JSON.stringify({ reason: rejectReason }) },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to reject dispute.");

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
          <Scale className="h-6 w-6 text-brand-red-text" />
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
            <p className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">{openCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground">Under Review</p>
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{underReviewCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground">Resolved</p>
            <p className="text-2xl font-bold text-green-600 dark:text-green-400">{resolvedCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground">Rejected</p>
            <p className="text-2xl font-bold text-red-600 dark:text-red-400">{rejectedCount}</p>
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
            <SearchInput
              label="Search disputes"
              placeholder="Search title, email, reason..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />

            {/* Status filter */}
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v as StatusFilter);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Filter disputes by status">
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
      {/* US-2507: a failed read rendered an empty queue, and an empty dispute
          queue is a thing an operator is happy to believe. */}
      {isError ? (
        <Card>
          <CardContent className="pt-6">
            <ErrorState
              title="Couldn't load the dispute queue"
              description="Disputes are still open — we just couldn't fetch them right now."
              onRetry={() => void refetch()}
              retrying={isFetching}
            />
          </CardContent>
        </Card>
      ) : isLoading ? (
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
                    <ClickableRow
                      key={item.dispute.id}
                      className="hover:bg-muted/50"
                      onActivate={() => openDetail(item)}
                      activateLabel={`View dispute for ${item.submission.title}`}
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
                          role="presentation"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
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
                    </ClickableRow>
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
        <DialogContent className="max-w-4xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-brand-red-text" />
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
              <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/50">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
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
                            loading="lazy"
                            decoding="async"
                            className="aspect-square rounded-lg border object-cover"
                          />
                        ) : photoErrors[img.id] ? (
                          <div
                            className="aspect-square rounded-lg border border-destructive/40 bg-destructive/5 flex flex-col items-center justify-center gap-1 p-2 text-center"
                            title={photoErrors[img.id]}
                          >
                            <ImageIcon className="h-8 w-8 text-destructive/70" />
                            <span className="text-[11px] leading-tight text-destructive">
                              Photo didn&apos;t load — evidence incomplete
                            </span>
                          </div>
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

              {/* US-1416: Evidence the filer attached when opening the dispute. */}
              {(selectedDispute.dispute.evidence_paths?.length ?? 0) > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-3">
                    Evidence Submitted by Filer
                  </h4>
                  {loadingEvidence ? (
                    <div className="grid grid-cols-3 gap-3">
                      {selectedDispute.dispute.evidence_paths.map((p) => (
                        <Skeleton key={p} className="aspect-square rounded-lg" />
                      ))}
                    </div>
                  ) : evidenceUrls.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Evidence photos could not be loaded.
                    </p>
                  ) : (
                    <div className="grid grid-cols-3 gap-3">
                      {evidenceUrls.map((url, i) => (
                        <img
                          key={url}
                          src={url}
                          alt={`Evidence ${i + 1}`}
                          loading="lazy"
                          decoding="async"
                          className="aspect-square rounded-lg border object-cover"
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

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
                      className="h-4 w-4 rounded border-input"
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
                              <Label className="text-sm" htmlFor={`dispute-factor-${key}`}>
                                {meta.label} ({(meta.weight * 100).toFixed(0)}%)
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Current: {aiScore.toFixed(1)}
                              </p>
                            </div>
                            <div className="col-span-4">
                              <Input
                                id={`dispute-factor-${key}`}
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
                            <span className="text-sm font-medium text-blue-600 dark:text-blue-400">
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
                    ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/40"
                    : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
                }`}>
                  <p className={`text-sm font-medium ${
                    selectedDispute.dispute.status === "resolved" ? "text-green-800 dark:text-green-300" : "text-red-800 dark:text-red-300"
                  }`}>
                    This dispute has been {selectedDispute.dispute.status}.
                  </p>
                  {selectedDispute.dispute.resolution_notes && (
                    <p className={`text-sm mt-2 ${
                      selectedDispute.dispute.status === "resolved" ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"
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
            <AlertDialogTitle>Reject dispute</AlertDialogTitle>
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
              Reject dispute
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

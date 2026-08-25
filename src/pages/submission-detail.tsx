import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useSearchParams, Link, useNavigate } from "react-router";
import {
  ArrowLeft,
  Share2,
  AlertTriangle,
  CheckCircle2,
  Info,
  Flag,
  Clock,
  Loader2,
  Upload,
  Package,
  Camera,
  Tag,
  ArrowRight,
  Image as ImageIcon,
  Eye,
  ShieldCheck,
} from "lucide-react";
import { useRealtimeSubmission } from "@/hooks/use-realtime-submission";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { Button } from "@/components/ui/button";
import { ScoreBandIcon } from "@/components/grade/score-indicator";
import { Badge } from "@/components/ui/badge";
import { AuthenticityAppealDialog } from "@/components/grade/authenticity-appeal-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageLightbox } from "@/components/certificate/image-lightbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  GRADE_FACTORS,
  DISPUTE_REASONS,
  DISPUTE_WINDOW_DAYS,
  COUNTERFEIT_RISK_LABELS,
  getScoreColor,
  getTierBadgeClasses,
  getProgressColor,
} from "@/lib/constants";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeFetch } from "@/lib/edge-fetch";
import { track } from "@/lib/analytics";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GradedPhotoPanel } from "@/components/verified/graded-photo-panel";
import { ShowcaseConsentPanel } from "@/components/showcase/showcase-consent-panel";
import { RepairTriagePanel } from "@/components/grade/repair-triage-panel";
import { GarmentPassportPanel } from "@/components/passport/garment-passport-panel";
import { CertShareActions } from "@/components/certificate/cert-share-actions";
import { CrossSurfaceNudge } from "@/components/cross-surface/cross-surface-nudge";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import type {
  SubmissionRow,
  GradeReportRow,
  SubmissionImageRow,
  DisputeRow,
  InventoryItemRow,
  ImageType,
} from "@/types/database";
import type { RetakeBridgeState } from "@/lib/retake-submission";
import { HelpLink } from "@/components/help/help-link";

function getConfidenceLabel(score: number): {
  label: string;
  color: string;
  icon: typeof CheckCircle2;
} {
  if (score > 0.85)
    return { label: "High", color: "text-emerald-500", icon: CheckCircle2 };
  if (score >= 0.75)
    return { label: "Medium", color: "text-amber-500", icon: Info };
  return { label: "Low", color: "text-brand-red-text", icon: AlertTriangle };
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// US-1466: minutes past which an in-flight grade is flagged as "taking longer
// than expected" (with a support link). Normal grades finish well under this.
// US-1437: read a File as a base64 data URI so dispute evidence can be POSTed to
// the server-side validation endpoint (which sniffs + strips it before storage).
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read file"));
    reader.readAsDataURL(file);
  });
}

const LONG_GRADE_THRESHOLD_MS = 3 * 60 * 1000;

// Human-readable elapsed time for the in-progress grading card.
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return "under a minute";
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-8 w-8" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}

export function SubmissionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const visible = useDocumentVisible();
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  const [gradeReport, setGradeReport] = useState<GradeReportRow | null>(null);
  const [images, setImages] = useState<SubmissionImageRow[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  // US-2545 AC2: index of the photo open in the full-screen viewer.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // US-2145: the authenticity appeal dialog.
  const [appealOpen, setAppealOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispute, setDispute] = useState<DisputeRow | null>(null);
  const [linkedItem, setLinkedItem] = useState<InventoryItemRow | null>(null);
  const [disputeDialogOpen, setDisputeDialogOpen] = useState(false);
  const [disputeCategory, setDisputeCategory] = useState("");
  const [disputeReason, setDisputeReason] = useState("");
  const [disputePhotos, setDisputePhotos] = useState<File[]>([]);
  const [submittingDispute, setSubmittingDispute] = useState(false);

  // Tracks the currently-rendered submission id so an in-flight refetch bound to
  // a previous id can detect it navigated away and skip its stale setState.
  const currentIdRef = useRef(id);
  useEffect(() => {
    currentIdRef.current = id;
  }, [id]);

  const refetchData = useCallback(async () => {
    if (!id) return;
    const { data: sub } = await supabase
      .from("submissions")
      .select("*")
      .eq("id", id)
      .single();
    // A refetch (realtime handler or the 5s interval) can still be in flight
    // when the route param changes A→B; without this guard its resolution would
    // setState the previous submission's data over B. Drop stale writes.
    if (currentIdRef.current !== id) return;
    if (sub) setSubmission(sub);

    const { data: reportData } = await supabase
      .from("grade_reports")
      .select("*")
      // US-479: a regraded submission keeps superseded history; fetch only the
      // active report so .single() resolves to exactly one row.
      .eq("submission_id", id)
      .is("superseded_at", null)
      .maybeSingle();
    if (currentIdRef.current !== id) return;
    if (reportData) setGradeReport(reportData);
  }, [id]);

  // Subscribe to realtime status updates for this submission (US-1628: pass
  // refetchData so the useState-held submission actually refreshes on change —
  // resolving the "we'll let you know the moment it's official" banner live).
  useRealtimeSubmission(id, refetchData);

  // ── Auto-retry payment after a mid-flow credit-pack purchase (US-207) ──
  //
  // The new-submission flow sends the user to a pack Checkout with a
  // returnPath of ?pay_retry=1&tier=… on this page. On return we re-run the
  // payment precedence (/api/grade/pay/:id) so the grade proceeds without a
  // second click. The credit-grant webhook lands a beat after Stripe redirects,
  // so we retry a few times before giving up.
  const payRetryDone = useRef(false);
  useEffect(() => {
    if (!id) return;
    if (searchParams.get("pay_retry") !== "1") return;
    if (payRetryDone.current) return;
    payRetryDone.current = true;

    const checkout = searchParams.get("checkout");
    const tier = searchParams.get("tier") ?? "standard";

    // Strip the flow params so a refresh doesn't re-trigger.
    const clearParams = () => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          ["pay_retry", "tier", "checkout", "product", "credits"].forEach((k) =>
            next.delete(k),
          );
          return next;
        },
        { replace: true },
      );
    };

    if (checkout === "cancelled") {
      toast.info("Payment cancelled — your submission is saved as unpaid.");
      clearParams();
      return;
    }

    let cancelled = false;
    (async () => {
      toast.loading("Applying your new credits…", { id: "pay-retry" });
      // Up to ~16s of retries to outrun the credit-grant webhook.
      for (let attempt = 0; attempt < 8 && !cancelled; attempt++) {
        try {
          const res = await edgeFetch(`/api/grade/pay/${id}`, {
            method: "POST",
            json: { tier },
            silentGate: true,
          });
          const json = await res.json().catch(() => ({}));
          if (res.ok && json.payment?.paid) {
            track("grade.pack_upsell_converted", { tier });
            track("grade.paid", { method: json.payment.method, tier });
            toast.success("Grade unlocked with your new credits.", {
              id: "pay-retry",
            });
            await refetchData();
            clearParams();
            return;
          }
        } catch {
          /* transient — keep retrying */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!cancelled) {
        toast.info(
          "Credits are being added — this grade will start automatically in a moment.",
          { id: "pay-retry" },
        );
        clearParams();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, searchParams, setSearchParams, refetchData]);

  // Re-fetch when submission status changes via realtime. We only care
  // about `.status` here — read it into a local so the deps array is
  // honest and we don't re-run on unrelated submission-row updates.
  // Realtime (above) is the primary trigger; this 5s setInterval is a fallback
  // while a grade is in flight. Gate it on tab visibility so a backgrounded tab
  // stops polling every 5s, and refetch once on return to the foreground. (US-576)
  const submissionStatus = submission?.status;
  useEffect(() => {
    if (
      visible &&
      (!submissionStatus ||
        submissionStatus === "processing" ||
        submissionStatus === "pending" ||
        // US-1628: keep polling while a grade awaits human review, so the
        // "we'll let you know the moment it's official" banner resolves without
        // a hard refresh even if the realtime event is missed.
        submissionStatus === "pending_review")
    ) {
      refetchData();
      const interval = setInterval(refetchData, 5000);
      return () => clearInterval(interval);
    }
  }, [visible, submissionStatus, refetchData]);

  // US-1466: tick a clock while a grade is in flight so we can show elapsed time
  // and escalate to a "taking longer than expected" message — a long-but-normal
  // grade should look different from a stuck one.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (submissionStatus === "processing" || submissionStatus === "pending") {
      setNowMs(Date.now());
      const t = setInterval(() => setNowMs(Date.now()), 15_000);
      return () => clearInterval(t);
    }
  }, [submissionStatus]);

  useEffect(() => {
    if (!id) return;
    // US-1632: guard against an A→B navigation race — the old id's async
    // continuations must not write state over the new page.
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);
      // Reset stale detail state on id change so B never briefly shows A's
      // grade/dispute/images while it loads.
      setSubmission(null);
      setGradeReport(null);
      setDispute(null);
      setLinkedItem(null);
      setImages([]);
      setImageUrls({});

      // Fetch submission
      const { data: sub, error: subError } = await supabase
        .from("submissions")
        .select("*")
        .eq("id", id!)
        .single();

      if (cancelled) return;
      if (subError || !sub) {
        setError("Submission not found.");
        setLoading(false);
        return;
      }
      setSubmission(sub);

      // Fetch grade report (US-479: active report only — a regraded submission
      // keeps superseded history, which would break .single()).
      const { data: reportData, error: reportError } = await supabase
        .from("grade_reports")
        .select("*")
        .eq("submission_id", id!)
        .is("superseded_at", null)
        .maybeSingle();

      if (cancelled) return;
      // US-1632: a TRANSIENT error here (maybeSingle doesn't error on "no report
      // yet", so this is a real DB/network failure) previously was swallowed,
      // leaving a completed grade stuck on "Grade Report Pending" forever.
      // Surface it so the user can retry.
      if (reportError) {
        setError("Couldn't load the grade report. Please try again.");
        setLoading(false);
        return;
      }
      if (reportData) {
        setGradeReport(reportData);
      }

      // Fetch a linked inventory item, if any (non-fatal — optional).
      const { data: linkedItemData } = await supabase
        .from("inventory_items")
        .select("*")
        .eq("submission_id", id!)
        .maybeSingle();
      if (cancelled) return;
      if (linkedItemData) {
        setLinkedItem(linkedItemData as InventoryItemRow);
      }

      // Fetch submission images
      const { data: imagesRaw } = await supabase
        .from("submission_images")
        .select("*")
        .eq("submission_id", id!);

      if (cancelled) return;
      const imagesData = (imagesRaw ?? []) as SubmissionImageRow[];
      if (imagesData.length > 0) {
        const sorted = [...imagesData].sort(
          (a, b) => a.display_order - b.display_order
        );
        setImages(sorted);

        // Sign all image paths in ONE request rather than one awaited round-trip
        // per image (a submission has 5-8 photos — that was 5-8 serial calls
        // before any thumbnail rendered). Private bucket → short-lived signed
        // URLs (US-276).
        const urls: Record<string, string> = {};
        const { data: signed } = await supabase.storage
          .from("submission-images")
          .createSignedUrls(
            sorted.map((img) => img.storage_path),
            900,
          );
        if (signed) {
          const idByPath = new Map(sorted.map((img) => [img.storage_path, img.id]));
          for (const entry of signed) {
            const id = entry.path ? idByPath.get(entry.path) : undefined;
            if (id && entry.signedUrl) urls[id] = entry.signedUrl;
          }
        }
        if (cancelled) return;
        setImageUrls(urls);
      }

      // Fetch existing dispute for this grade report. US-1632: .maybeSingle() —
      // the normal zero-dispute case is NOT an error (.single() threw PGRST116).
      if (reportData) {
        const reportId = (reportData as GradeReportRow).id;
        const { data: disputeData } = await supabase
          .from("disputes")
          .select("*")
          .eq("grade_report_id", reportId)
          .maybeSingle();

        if (cancelled) return;
        if (disputeData) {
          setDispute(disputeData as DisputeRow);
        }
      }

      if (cancelled) return;
      setLoading(false);
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const canDispute =
    submission?.status === "completed" &&
    gradeReport &&
    !dispute &&
    (() => {
      const createdAt = new Date(gradeReport.created_at);
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - DISPUTE_WINDOW_DAYS);
      return createdAt > windowStart;
    })();

  // US-949: one-tap retake. Carry the prior submission's garment details, any
  // inventory linkage, the grader's flagged photo types, and the PASSING photos
  // (as short-lived signed URLs) over to a fresh submission so a needs_photos /
  // expired result isn't a dead end. The new submission references this one and
  // supersedes it server-side (see grade.ts /submit `retake_of`).
  function handleRetake() {
    if (!submission) return;
    const flaggedImageTypes = Array.from(
      new Set(
        (submission.quality_feedback?.issues ?? [])
          .filter((i) => i.severity === "block")
          .map((i) => i.image_type as ImageType)
      )
    );
    const flaggedSet = new Set<ImageType>(flaggedImageTypes);
    const reusablePhotos = images
      .filter((img) => !flaggedSet.has(img.image_type) && imageUrls[img.id])
      .map((img) => ({
        imageType: img.image_type,
        signedUrl: imageUrls[img.id]!,
      }));

    const retake: RetakeBridgeState = {
      priorSubmissionId: submission.id,
      garmentType: submission.garment_type,
      garmentCategory: submission.garment_category,
      brand: submission.brand ?? undefined,
      title: submission.title,
      description: submission.description ?? undefined,
      styleAttributes: submission.style_attributes,
      linkedItemId: linkedItem?.id ?? null,
      flaggedImageTypes,
      photoRequests: submission.quality_feedback?.photo_requests ?? [],
      reusablePhotos,
    };

    track("grade.retake_started", {
      from: submission.status,
      reused: reusablePhotos.length,
      flagged: flaggedImageTypes.length,
    });
    navigate("/dashboard/submissions/new", { state: { retake } });
  }

  async function handleSubmitDispute() {
    if (!user || !gradeReport) return;

    if (!disputeCategory) {
      toast.error("Please choose a reason for the dispute.");
      return;
    }
    const details = disputeReason.trim();
    // Free-text details are required for "Other", optional otherwise.
    if (disputeCategory === "other" && details.length < 20) {
      toast.error("Please describe the issue in at least 20 characters.");
      return;
    }

    // Compose the stored reason from the chosen category + optional details.
    const categoryLabel =
      DISPUTE_REASONS.find((r) => r.value === disputeCategory)?.label ?? "Other";
    const composedReason =
      disputeCategory === "other"
        ? details
        : details
          ? `${categoryLabel} — ${details}`
          : categoryLabel;

    setSubmittingDispute(true);

    try {
      // US-1437: file the dispute server-side (POST /api/grade/dispute). This
      // fixes two things the old client path got wrong: evidence photos now go
      // through magic-byte validation + EXIF/GPS stripping before storage
      // (US-276), and a WORKSPACE MEMBER can file at all — the old client-side
      // disputes.insert + storage.upload were keyed to the workspace owner's id
      // and so failed the auth.uid()=user_id RLS for a non-owner member.
      const images: string[] = [];
      for (const photo of disputePhotos) {
        if (photo) images.push(await fileToDataUrl(photo));
      }

      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Your session expired — please sign in again.");

      const res = await fetch(`${edgeApiUrl()}/api/grade/dispute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          gradeReportId: gradeReport.id,
          reason: composedReason,
          images,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        dispute?: DisputeRow;
        evidence_failures?: number;
        error?: string;
      };
      if (!res.ok || !json.dispute) {
        throw new Error(json.error || "Failed to submit dispute");
      }
      const newDispute = json.dispute;
      if ((json.evidence_failures ?? 0) > 0) {
        toast.error(
          `${json.evidence_failures} of ${images.length} evidence photo(s) couldn't be uploaded — filed your dispute without them.`,
        );
      }

      // Alert the platform admin to review (best-effort — never blocks filing).
      void (async () => {
        try {
          await fetch(`${edgeApiUrl()}/api/notifications/dispute-filed`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ disputeId: newDispute.id }),
          });
        } catch {
          /* best-effort */
        }
      })();

      setDispute(newDispute);
      setSubmission((prev) =>
        prev ? { ...prev, status: "disputed" as const } : prev
      );
      setDisputeDialogOpen(false);
      setDisputeCategory("");
      setDisputeReason("");
      setDisputePhotos([]);
      toast.success("Dispute submitted successfully. We'll review it shortly.");
    } catch (err) {
      toastError(err, "Failed to submit dispute");
    } finally {
      setSubmittingDispute(false);
    }
  }

  function getDisputeStatusBadge(status: string) {
    switch (status) {
      case "open":
        return "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-950/50 dark:text-yellow-300 dark:border-yellow-800";
      case "under_review":
        return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800";
      case "resolved":
        return "bg-green-100 text-green-800 border-green-200 dark:bg-green-950/50 dark:text-green-300 dark:border-green-800";
      case "rejected":
        return "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800";
      default:
        return "";
    }
  }

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error || !submission) {
    return (
      <div className="space-y-6">
        <Link
          to="/dashboard/submissions"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Submissions
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <AlertTriangle className="h-12 w-12 text-muted-foreground/50" />
            <h3 className="mt-4 text-lg font-medium">
              {error || "Submission not found"}
            </h3>
          </CardContent>
        </Card>
      </div>
    );
  }

  // US-1466: elapsed since submission + whether an in-flight grade has crossed
  // the "taking longer than expected" threshold (drives the escalation copy).
  const elapsedMs = nowMs - new Date(submission.created_at).getTime();
  const gradeTakingLong = elapsedMs >= LONG_GRADE_THRESHOLD_MS;

  const factorScores = gradeReport
    ? [
        {
          key: "fabric_condition" as const,
          score: gradeReport.fabric_condition_score,
        },
        {
          key: "structural_integrity" as const,
          score: gradeReport.structural_integrity_score,
        },
        {
          key: "cosmetic_appearance" as const,
          score: gradeReport.cosmetic_appearance_score,
        },
        {
          key: "functional_elements" as const,
          score: gradeReport.functional_elements_score,
        },
        {
          key: "odor_cleanliness" as const,
          score: gradeReport.odor_cleanliness_score,
        },
      ]
    : [];

  const defects =
    gradeReport?.detailed_notes &&
    typeof gradeReport.detailed_notes === "object"
      ? Object.entries(gradeReport.detailed_notes).filter(
          ([key]) => key.toLowerCase().includes("defect") || key.toLowerCase().includes("issue")
        )
      : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/dashboard/submissions"
            aria-label="Back to submissions"
            className="inline-flex items-center justify-center rounded-md border p-2 hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold">{submission.title}</h1>
            <HelpLink slug="reading-your-grade-report" label="Help: reading your grade report" />
            <p className="text-sm text-muted-foreground">
              Submitted {new Date(submission.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              submission.status === "completed" &&
                "border-green-200 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300",
              submission.status === "processing" &&
                "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
              submission.status === "pending_review" &&
                "border-violet-200 bg-violet-100 text-violet-800 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-300",
              submission.status === "pending" &&
                "border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300",
              submission.status === "needs_photos" &&
                "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
              submission.status === "expired" &&
                "border-gray-200 bg-gray-100 text-gray-600",
              submission.status === "failed" &&
                "border-red-200 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
            )}
          >
            {formatLabel(submission.status)}
          </Badge>
          {submission.status === "completed" && gradeReport?.certificate_id && (
            // US: the header "Share Certificate" button used to be a plain Link to
            // /cert/:id — it just navigated to the page instead of offering share
            // options. Open the real share actions (native share sheet + one-tap
            // channels + copy link + Save as PDF) in a popover, reusing the same
            // CertShareActions the post-grade prompt uses below.
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <Share2 className="mr-1 h-4 w-4" />
                  Share Certificate
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto max-w-[92vw] p-3">
                <CertShareActions
                  certificateId={gradeReport.certificate_id}
                  title={submission.title}
                  score={gradeReport.overall_score}
                  tier={gradeReport.grade_tier}
                />
              </PopoverContent>
            </Popover>
          )}
          {canDispute && (
            <Dialog open={disputeDialogOpen} onOpenChange={setDisputeDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Flag className="mr-1 h-4 w-4" />
                  Dispute Grade
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dispute This Grade</DialogTitle>
                  <DialogDescription>
                    Explain why you believe this grade is inaccurate. You can also
                    upload additional photos as evidence.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="dispute-category">Reason for dispute</Label>
                    <Select
                      value={disputeCategory}
                      onValueChange={setDisputeCategory}
                    >
                      <SelectTrigger id="dispute-category">
                        <SelectValue placeholder="Choose a reason…" />
                      </SelectTrigger>
                      <SelectContent>
                        {DISPUTE_REASONS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="dispute-reason">
                      Details{" "}
                      <span className="text-muted-foreground">
                        {disputeCategory === "other"
                          ? "(required, min 20 characters)"
                          : "(optional)"}
                      </span>
                    </Label>
                    <Textarea
                      id="dispute-reason"
                      placeholder="Add any specifics that will help us review this grade…"
                      value={disputeReason}
                      onChange={(e) => setDisputeReason(e.target.value)}
                      rows={4}
                    />
                    {disputeCategory === "other" && (
                      <p className="text-xs text-muted-foreground">
                        {disputeReason.trim().length}/20 characters minimum
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>Additional evidence (optional)</Label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const input = document.createElement("input");
                          input.type = "file";
                          input.accept = "image/jpeg,image/png,image/webp";
                          input.multiple = true;
                          input.onchange = (e) => {
                            const files = (e.target as HTMLInputElement).files;
                            if (files) {
                              setDisputePhotos((prev) => [
                                ...prev,
                                ...Array.from(files),
                              ]);
                            }
                          };
                          input.click();
                        }}
                      >
                        <Upload className="mr-1 h-4 w-4" />
                        Upload Photos
                      </Button>
                      {disputePhotos.length > 0 && (
                        <span className="text-sm text-muted-foreground">
                          {disputePhotos.length} photo
                          {disputePhotos.length !== 1 ? "s" : ""} selected
                        </span>
                      )}
                    </div>
                    {disputePhotos.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {disputePhotos.map((photo, i) => (
                          <Badge
                            key={i}
                            variant="secondary"
                            className="cursor-pointer"
                            onClick={() =>
                              setDisputePhotos((prev) =>
                                prev.filter((_, idx) => idx !== i)
                              )
                            }
                          >
                            {photo.name} &times;
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setDisputeDialogOpen(false)}
                    disabled={submittingDispute}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleSubmitDispute}
                    disabled={
                      submittingDispute ||
                      !disputeCategory ||
                      (disputeCategory === "other" &&
                        disputeReason.trim().length < 20)
                    }
                  >
                    {submittingDispute && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Submit Dispute
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* Garment Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Garment Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <p className="text-muted-foreground">Title</p>
              <p className="font-medium">{submission.title}</p>
            </div>
            {submission.brand && (
              <div>
                <p className="text-muted-foreground">Brand</p>
                <p className="font-medium">{submission.brand}</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground">Type</p>
              <p className="font-medium">
                {formatLabel(submission.garment_type)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Category</p>
              <p className="font-medium">
                {formatLabel(submission.garment_category)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Linked Inventory Item */}
      {linkedItem && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-muted p-2">
                <Package className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">
                  Linked to inventory item
                </p>
                <p className="text-xs text-muted-foreground">
                  {linkedItem.title}
                  {linkedItem.brand ? ` · ${linkedItem.brand}` : ""}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* US-2545 AC3: this was two buttons with one destination.
                  "View item" pointed at /dashboard/inventory/:id, which
                  InventoryItemRedirect rewrites straight to the FlipDesk item
                  page the primary button already opens — and since US-2519
                  there IS only one item editor, so a second link cannot lead
                  anywhere else. One button, named for what it does. */}
              <Button size="sm" asChild>
                <Link to={`/dashboard/flipdesk/items/${linkedItem.id}`}>
                  <Tag className="mr-1.5 h-3.5 w-3.5" />
                  Open item to use this grade
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Grade Report */}
      {gradeReport ? (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Mandatory review: the grade is preliminary until a human finalizes it. */}
          {submission.status === "pending_review" && (
            <div className="rounded-lg border border-violet-300 bg-violet-50 px-4 py-3 dark:border-violet-800 dark:bg-violet-950/40 lg:col-span-3">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-5 w-5 shrink-0 text-violet-600 dark:text-violet-300" />
                <div>
                  <p className="text-sm font-semibold text-violet-900 dark:text-violet-200">
                    Preliminary grade — pending expert review
                  </p>
                  <p className="mt-0.5 text-sm text-violet-800/80 dark:text-violet-300/80">
                    This AI grade is unofficial. One of our experts will review it
                    shortly — the score may change, and your shareable certificate
                    goes live once it's finalized. We'll let you know the moment it's
                    official.
                  </p>
                </div>
              </div>
            </div>
          )}
          {/* Left column: Score + Factors + Summary */}
          <div className="space-y-6 lg:col-span-2">
            {/* Overall Score */}
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-6">
                  <div
                    className={cn(
                      "flex h-24 w-24 flex-shrink-0 items-center justify-center rounded-full border-4",
                      gradeReport.overall_score > 7
                        ? "border-emerald-500"
                        : gradeReport.overall_score >= 5
                          ? "border-amber-500"
                          : "border-brand-red"
                    )}
                  >
                    <span
                      className={cn(
                        "text-3xl font-bold",
                        getScoreColor(gradeReport.overall_score)
                      )}
                    >
                      {gradeReport.overall_score.toFixed(1)}
                    </span>
                  </div>
                  <div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-sm font-medium",
                        getTierBadgeClasses(gradeReport.overall_score)
                      )}
                    >
                      {gradeReport.grade_tier}
                    </Badge>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Overall Condition Grade
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Factor Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Factor Breakdown</CardTitle>
                <CardDescription>
                  Individual scores across 5 grading criteria
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {factorScores.map(({ key, score }) => {
                  const factor = GRADE_FACTORS[key];
                  return (
                    <div key={key} className="space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">
                          {factor.label}{" "}
                          <span className="text-muted-foreground">
                            ({(factor.weight * 100).toFixed(0)}%)
                          </span>
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 font-semibold",
                            getScoreColor(score)
                          )}
                        >
                          <ScoreBandIcon score={score} />
                          {score.toFixed(1)}
                        </span>
                      </div>
                      <Progress
                        value={score * 10}
                        className={cn("h-2", getProgressColor(score))}
                      />
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* AI Summary */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">AI Analysis Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {gradeReport.ai_summary}
                </p>
                {/* US-514: AI-transparency disclosure (mirrors the public
                    certificate + Terms §5). */}
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  AI-generated condition estimate — not a professional appraisal
                  or guarantee. This grade is produced automatically from photos
                  and is an estimate of condition only; lower-confidence grades
                  are routed to a human reviewer. See{" "}
                  <a href="/terms" className="underline">Terms</a> §5.
                </p>
              </CardContent>
            </Card>

            {/* Intentional design features — shown so the seller/buyer can see
                distressing etc. was recognized as styling, not counted as damage. */}
            {gradeReport.detected_style_attributes &&
              gradeReport.detected_style_attributes.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Design Features</CardTitle>
                    <CardDescription>
                      Intentional design elements assessed as styling — these did
                      not lower the grade.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {gradeReport.detected_style_attributes.map((s, i) => (
                        <span
                          key={i}
                          className="rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize"
                        >
                          {s.attribute}
                          {s.location ? ` · ${s.location}` : ""}
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

            {/* US-601: premium authenticity / counterfeit-confidence add-on.
                A SEPARATE garment-authenticity signal — distinct from the
                condition grade and from photo-tamper detection. A confidence
                estimate, with limitations disclosed. */}
            {/* US-2145: while an appeal is open the server has NULLED the
                verdict, confidence, risk and summary, so the normal card would
                render a row of blanks. Show the pending state instead — the
                seller needs to know the result is withheld, not that it broke. */}
            {gradeReport.authenticity_assessment?.under_appeal && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                    Authenticity Check — under review
                  </CardTitle>
                  <CardDescription>
                    You contested this result. It is hidden from your
                    certificate and from buyers while a human reviews it, and
                    we will let you know the outcome.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}

            {gradeReport.authenticity_assessment?.assessed &&
              !gradeReport.authenticity_assessment?.under_appeal && (() => {
              const auth = gradeReport.authenticity_assessment!;
              const risk = COUNTERFEIT_RISK_LABELS[auth.counterfeit_risk];
              const tone =
                risk.tone === "good"
                  ? "text-green-600 dark:text-green-400"
                  : risk.tone === "alert"
                    ? "text-red-600 dark:text-red-400"
                    : risk.tone === "warn"
                      ? "text-yellow-600 dark:text-yellow-400"
                      : "text-muted-foreground";
              return (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <ShieldCheck className={cn("h-4 w-4", tone)} />
                      Authenticity Check
                    </CardTitle>
                    <CardDescription>
                      A premium counterfeit-confidence signal — separate from the
                      condition grade and from photo-tamper detection.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className={cn("font-semibold", tone)}>{risk.label}</span>
                      {auth.counterfeit_risk !== "indeterminate" && (
                        <span className="text-muted-foreground">
                          {(auth.authenticity_confidence * 100).toFixed(0)}% authentic-confidence
                        </span>
                      )}
                    </div>
                    {auth.brand_assessed && (
                      <p className="text-xs text-muted-foreground">
                        Assessed against: <span className="font-medium">{auth.brand_assessed}</span>
                      </p>
                    )}
                    <p className="leading-relaxed">{auth.summary}</p>
                    {auth.red_flags.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-red-600 dark:text-red-400">
                          Potential concerns
                        </p>
                        <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                          {auth.red_flags.map((f, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-500" />
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {auth.supporting_signals.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-green-600 dark:text-green-400">
                          Consistent with authentic
                        </p>
                        <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                          {auth.supporting_signals.map((s, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-green-500" />
                              {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <p className="rounded-md bg-muted/60 px-3 py-2 text-xs italic text-muted-foreground">
                      {auth.limitations}
                    </p>
                    {/* US-2145: the contest action, on the surface where the
                        seller SEES the verdict. Everything behind it already
                        existed; nothing called it. */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAppealOpen(true)}
                    >
                      This is genuine — contest this result
                    </Button>
                  </CardContent>
                </Card>
              );
            })()}
          </div>

          {/* Right column: Confidence + Defects + Images */}
          <div className="space-y-6">
            {/* Confidence Score */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Confidence</CardTitle>
              </CardHeader>
              <CardContent>
                {(() => {
                  const conf = getConfidenceLabel(
                    gradeReport.confidence_score
                  );
                  const ConfIcon = conf.icon;
                  return (
                    <div className="flex items-center gap-3">
                      <ConfIcon className={cn("h-5 w-5", conf.color)} />
                      <div>
                        <p className={cn("font-semibold", conf.color)}>
                          {conf.label}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {(gradeReport.confidence_score * 100).toFixed(0)}%
                          confidence
                        </p>
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* Defects */}
            {gradeReport.detailed_notes &&
              Object.keys(gradeReport.detailed_notes).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Detected Issues
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {defects.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {defects.map(([key, value]) => (
                          <Badge key={key} variant="secondary">
                            {value}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {Object.entries(gradeReport.detailed_notes).map(
                          ([key, value]) => (
                            <li key={key} className="flex items-start gap-2">
                              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted-foreground" />
                              <span>
                                <span className="font-medium">
                                  {formatLabel(key)}:
                                </span>{" "}
                                {value}
                              </span>
                            </li>
                          )
                        )}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              )}

            {/* US-1286: AI repair triage — which reversible/repairable defects
                are worth fixing, and what that recovers in grade + resale value.
                Renders nothing when there's no actionable (non-permanent) flaw. */}
            <RepairTriagePanel defects={gradeReport.defects_found} />

            {/* Model version */}
            <div className="text-xs text-muted-foreground">
              Graded by model: {gradeReport.model_version}
            </div>
          </div>
        </div>

      ) : (
        <Card>
          {/* Live region for async status (US-452): processing is announced
              politely; a failed grade is a critical error announced assertively
              so screen-reader users hear it interrupt. The decorative spinner is
              hidden from assistive tech — the heading/body text carry the
              message. */}
          <CardContent
            className="flex flex-col items-center justify-center py-12 text-center"
            role={submission.status === "failed" ? "alert" : "status"}
            aria-live={
              submission.status === "failed" ? "assertive" : "polite"
            }
            aria-busy={submission.status === "processing"}
          >
            {submission.status === "processing" ? (
              <>
                <div
                  className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent"
                  aria-hidden="true"
                />
                <h3 className="mt-4 text-lg font-medium">
                  Grading in Progress
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your garment is being analyzed. This usually takes a few
                  moments.
                </p>
                {/* US-1466: elapsed + escalation so a long-but-normal grade is
                    distinguishable from a stuck one. */}
                <p className="mt-2 text-xs text-muted-foreground">
                  Elapsed: {formatElapsed(elapsedMs)}
                </p>
                {gradeTakingLong && (
                  <p className="mt-2 max-w-md text-xs text-amber-700 dark:text-amber-300">
                    This is taking longer than usual — grades normally finish
                    within a couple of minutes. If it doesn&apos;t complete
                    shortly,{" "}
                    <a
                      href="mailto:support@gradethread.com"
                      className="font-medium underline underline-offset-2"
                    >
                      contact support
                    </a>
                    . You&apos;re only charged for a completed grade.
                  </p>
                )}
              </>
            ) : submission.status === "pending" ? (
              // US-1466: distinguish pending (awaiting payment) from processing
              // (AI running) — different copy so a checkout that hasn't cleared
              // doesn't read as a stalled grade.
              <>
                <div
                  className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent"
                  aria-hidden="true"
                />
                <h3 className="mt-4 text-lg font-medium">Finishing checkout</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  We&apos;re confirming your payment. Grading starts
                  automatically as soon as it clears.
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Elapsed: {formatElapsed(elapsedMs)}
                </p>
                {gradeTakingLong && (
                  <p className="mt-2 max-w-md text-xs text-amber-700 dark:text-amber-300">
                    Still waiting on payment confirmation. If you completed
                    checkout a while ago,{" "}
                    <a
                      href="mailto:support@gradethread.com"
                      className="font-medium underline underline-offset-2"
                    >
                      contact support
                    </a>
                    . You&apos;re only charged for a completed grade.
                  </p>
                )}
              </>
            ) : submission.status === "failed" ? (
              <>
                <AlertTriangle className="h-12 w-12 text-red-500/50" />
                <h3 className="mt-4 text-lg font-medium">Grading Failed</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Something went wrong while grading this submission — you
                  weren&apos;t charged (any payment was automatically refunded).
                  Retake to reuse these photos and details, or start a new
                  submission.
                </p>
                {/* US-1438: don't strand a failed grade — offer the same
                    recovery actions as needs_photos / expired. A failure has no
                    per-photo flags, so handleRetake reuses all photos. */}
                <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row">
                  <Button onClick={handleRetake}>
                    <Camera className="mr-1.5 h-4 w-4" />
                    Retake photos
                  </Button>
                  <Button asChild variant="outline">
                    <Link to="/dashboard/submissions/new">
                      Start a new submission
                    </Link>
                  </Button>
                </div>
              </>
            ) : submission.status === "needs_photos" ? (
              <>
                <Camera className="h-12 w-12 text-amber-500/70" />
                <h3 className="mt-4 text-lg font-medium">Better photos needed</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {submission.quality_feedback?.summary ??
                    "Some photos weren’t clear enough to grade reliably. We didn’t produce a grade so you’re not charged — please retake the photos below and resubmit."}
                </p>
                {submission.quality_feedback?.photo_requests &&
                  submission.quality_feedback.photo_requests.length > 0 && (
                    <ul className="mt-4 w-full max-w-md space-y-2 text-left">
                      {submission.quality_feedback.photo_requests.map((req, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                        >
                          <Camera className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{req}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                {/* US-949: one-tap retake — prefills garment details + reuses
                    the photos that passed, so the seller only redoes the
                    flagged ones instead of starting from scratch. */}
                <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row">
                  <Button onClick={handleRetake}>
                    <Camera className="mr-1.5 h-4 w-4" />
                    Retake photos
                  </Button>
                  <Button asChild variant="outline">
                    <Link to="/dashboard/submissions/new">
                      Start a new submission
                    </Link>
                  </Button>
                </div>
              </>
            ) : submission.status === "expired" ? (
              <>
                <Info className="h-12 w-12 text-muted-foreground/60" />
                <h3 className="mt-4 text-lg font-medium">Payment not completed</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  This submission expired because checkout was never completed, so
                  it was never graded and you weren’t charged. Retake to reuse
                  these photos and details, or start fresh.
                </p>
                {/* US-949: retake reuses the already-uploaded photos + garment
                    details so an expired checkout isn't a dead end. */}
                <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row">
                  <Button onClick={handleRetake}>
                    <Camera className="mr-1.5 h-4 w-4" />
                    Retake photos
                  </Button>
                  <Button asChild variant="outline">
                    <Link to="/dashboard/submissions/new">
                      Start a new submission
                    </Link>
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Info className="h-12 w-12 text-muted-foreground/50" />
                <h3 className="mt-4 text-lg font-medium">
                  Grade Report Pending
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  The grade report will appear here once processing is complete.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* US-2545 AC4: five separate cards, every one of them gated on the
          same "the grade landed" condition, stacked so that the last of them
          sat below three screens of report detail. They are one thing - what
          to do now the grade exists - so they are one section with one
          heading. The dispute card and the photo grid stay outside it: those
          are status and evidence, not next steps. */}
      {submission.status === "completed" && gradeReport && (
        <section className="space-y-4">
          <h2 className="text-base font-semibold text-foreground">
            What's next
          </h2>
        {/* Graded photo (US-765): the PSA-style certified image for this grade,
            ready to drop into a listing. Only once a certificate exists AND the
            grade is finalized (the cert is withheld while in review). */}
        {submission.status === "completed" && gradeReport?.certificate_id && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ImageIcon className="h-5 w-5 text-brand-navy dark:text-foreground" />
                Your graded photo
              </CardTitle>
              <CardDescription>
                A certified image of this item with the grade and a scannable code
                burned in — add it to your eBay, Poshmark, Depop or social listing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {gradeReport.view_count > 0 && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Eye className="h-3.5 w-3.5" />
                  Certificate viewed {gradeReport.view_count.toLocaleString()}{" "}
                  {gradeReport.view_count === 1 ? "time" : "times"}
                </p>
              )}
              <GradedPhotoPanel certificateId={gradeReport.certificate_id} />
            </CardContent>
          </Card>
        )}

        {/* US-1855: per-item consent for the public Showcase / Finds feed. Gated
            on a finalized certificate — there is nothing publishable before one,
            and the feed's own view refuses uncertified reports anyway. */}
        {submission.status === "completed" && gradeReport?.certificate_id && (
          <ShowcaseConsentPanel
            submissionId={submission.id}
            optIn={submission.showcase_opt_in === true}
            valueCents={submission.showcase_value_cents ?? null}
          />
        )}

        {/* US-862: post-grade share prompt — nudge the seller to share their
            certificate at the moment the grade lands. Reuses CertShareActions,
            whose shared link carries ?s=share for attribution (US-769). */}
        {submission.status === "completed" && gradeReport?.certificate_id && (
          <Card className="border-brand-red/30 bg-brand-red/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Share2 className="h-5 w-5 text-brand-red-text" />
                Share your certificate
              </CardTitle>
              <CardDescription>
                Show buyers this item is independently graded. Share the verified
                certificate to your listing or socials — every view builds trust.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CertShareActions
                certificateId={gradeReport.certificate_id}
                title={submission.title}
                score={gradeReport.overall_score}
                tier={gradeReport.grade_tier}
              />
            </CardContent>
          </Card>
        )}

        {/* US-1120: turn a fresh grade into a Garment Passport conversion surface —
            a prominent "View / Create a Garment Passport" path (no longer gated
            solely on the physical-tag panel), plus the physical-tag generator
            (US-1096) and verified-seller / buyer-guarantee trust hints. */}
        {submission.status === "completed" && gradeReport && (
          <GarmentPassportPanel
            garmentId={gradeReport.garment_id ?? null}
            submissionId={submission.id}
          />
        )}

        {/* US-1075: cross-surface activation — once a grade lands and it isn't
            already tied to a FlipDesk item, nudge the grader to turn the verified
            certificate into a listing. Dismissable + event-tracked; suppressed if
            the user opted out of product messaging. */}
        {submission.status === "completed" && gradeReport && !linkedItem && (
          <CrossSurfaceNudge
            nudgeId="grade-to-flipdesk"
            icon={Tag}
            title="Sell this with FlipDesk"
            description="Turn this graded certificate into a listing. FlipDesk lists it on eBay and shows buyers the verified grade to lift price and trust."
            cta={{ label: "Open FlipDesk", to: "/dashboard/flipdesk" }}
            context={{
              submission_id: submission.id,
              score: gradeReport.overall_score,
            }}
          />
        )}
        </section>
      )}

      {/* Dispute Status */}
      {dispute && (
        <Card className="border-yellow-500/60 bg-yellow-500/5">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Flag className="h-4 w-4" />
                Dispute
              </CardTitle>
              <Badge
                variant="outline"
                className={cn(getDisputeStatusBadge(dispute.status))}
              >
                {formatLabel(dispute.status)}
              </Badge>
            </div>
            <CardDescription>
              Submitted {new Date(dispute.created_at).toLocaleDateString()}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Reason
              </p>
              <p className="text-sm">{dispute.reason}</p>
            </div>
            {dispute.resolution_notes && (
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Resolution
                </p>
                <p className="text-sm">{dispute.resolution_notes}</p>
              </div>
            )}
            {(dispute.status === "open" ||
              dispute.status === "under_review") && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                Your dispute is being reviewed. We{"'"}ll notify you when a
                decision is made.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Image Gallery */}
      {images.length > 0 && (
        <>
          <Separator />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Submitted Photos</CardTitle>
              <CardDescription>
                {images.length} photo{images.length !== 1 ? "s" : ""} submitted
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {images.map((img, i) => (
                  <div key={img.id} className="space-y-1.5">
                    {/* US-2545 AC2: these are the photos the grade was made
                        from, and until now the seller could only see them as
                        150px thumbnails — while any buyer holding the public
                        certificate link could open the very same photos full
                        screen. Same viewer, same keyboard and swipe handling. */}
                    {imageUrls[img.id] ? (
                      <button
                        type="button"
                        onClick={() => setLightboxIndex(i)}
                        className="block aspect-square w-full overflow-hidden rounded-lg border bg-muted transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring"
                        aria-label={`View ${formatLabel(img.image_type)} photo full screen`}
                      >
                        <img
                          src={imageUrls[img.id]}
                          alt={`${img.image_type} photo`}
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ) : (
                      <div className="aspect-square overflow-hidden rounded-lg border bg-muted">
                        <div className="flex h-full w-full items-center justify-center">
                          <Skeleton className="h-full w-full" />
                        </div>
                      </div>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {formatLabel(img.image_type)}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {lightboxIndex !== null && (
        <ImageLightbox
          // Same index space as the grid above (no filtering), so the clicked
          // thumbnail's index always maps to the right photo.
          images={images.map((img) => ({
            id: img.id,
            src: imageUrls[img.id] ?? "",
            caption: formatLabel(img.image_type),
          }))}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      )}

      {/* US-2145: rendered at the page root rather than inside the card, so
          the dialog is not unmounted the moment the card swaps to its
          under-appeal state on a successful file. */}
      {gradeReport && (
        <AuthenticityAppealDialog
          gradeReportId={gradeReport.id}
          open={appealOpen}
          onOpenChange={setAppealOpen}
          onFiled={() => void refetchData()}
        />
      )}
    </div>
  );
}

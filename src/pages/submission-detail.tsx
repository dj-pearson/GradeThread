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
  Package,
  Camera,
  Tag,
  ArrowRight,
  Image as ImageIcon,
  Eye,
  ShieldCheck,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRealtimeSubmission } from "@/hooks/use-realtime-submission";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { GradeRangeNote } from "@/components/grading/grade-range-note";
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
  tierBandRange,
} from "@/lib/constants";
import { supabase } from "@/lib/supabase";
import { ScoreExplainer } from "@/components/grading/score-explainer";
import { WhatHappensNext } from "@/components/submission/what-happens-next";
import { formatReadyBy, useGradeTurnaround } from "@/hooks/use-grade-turnaround";
import { cleanlinessVisible } from "@/lib/cleanliness";
import { limitingFlawSentence } from "@/lib/limiting-flaw";
import {
  HUMAN_REVIEW,
  WHERE_IT_APPEARS,
  confidenceExplanation,
} from "@/lib/grading-journey";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  isFinalPayStatus,
  PAY_RETRY_ATTEMPTS,
  PAY_RETRY_DELAY_MS,
} from "@/lib/pay-retry";
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
import { DetectedIssues } from "@/components/grade/detected-issues";
import { DISPUTE_KIND_LABEL } from "@/lib/dispute-kind";
import {
  detailPollDelay,
  isPollableStatus,
  releaseRefetchDelay,
} from "@/lib/detail-poll";
import { DisputeEvidencePicker } from "@/components/grade/dispute-evidence-picker";
import {
  prepareEvidence,
  EVIDENCE_MAX_WIDTH,
  EVIDENCE_QUALITY,
} from "@/lib/dispute-evidence";
import { compressImage } from "@/lib/image-utils";
import { GarmentPassportPanel } from "@/components/passport/garment-passport-panel";
import { CertShareActions } from "@/components/certificate/cert-share-actions";
import { CrossSurfaceNudge } from "@/components/cross-surface/cross-surface-nudge";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import type { DisputeRow, ImageType } from "@/types/database";
import {
  GRADE_REPORT_OWNER_SELECT,
  SUBMISSION_DETAIL_COLUMNS,
  type SubmissionDetailView,
  SUBMISSION_IMAGE_COLUMNS,
  LINKED_ITEM_COLUMNS,
  DISPUTE_VIEW_COLUMNS,
  type GradeReportOwnerView,
  type SubmissionImageView,
  type LinkedItemView,
  type DisputeView,
} from "@/lib/submission-detail-columns";
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
function fileToDataUrl(file: Blob): Promise<string> {
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

// SUB-11: the page's secondary reads, as functions so each section's retry
// re-runs only its own read rather than the whole page load.

type LinkedItemRead = { ok: true; item: LinkedItemView | null } | { ok: false };

async function readLinkedItem(submissionId: string): Promise<LinkedItemRead> {
  const { data, error } = await supabase
    .from("inventory_items")
    .select(LINKED_ITEM_COLUMNS)
    .eq("submission_id", submissionId)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, item: data ? (data as LinkedItemView) : null };
}

/** Signed URLs by image id, or null when any photo could not be signed. */
async function signImages(
  images: readonly SubmissionImageView[],
): Promise<Record<string, string> | null> {
  if (images.length === 0) return {};
  // One request for every path (US-276: private bucket, TTL <= 900s).
  const { data: signed, error } = await supabase.storage
    .from("submission-images")
    .createSignedUrls(
      images.map((img) => img.storage_path),
      900,
    );
  if (error || !signed || signed.some((entry) => entry.error)) return null;
  const idByPath = new Map(images.map((img) => [img.storage_path, img.id]));
  const urls: Record<string, string> = {};
  for (const entry of signed) {
    const imageId = entry.path ? idByPath.get(entry.path) : undefined;
    if (imageId && entry.signedUrl) urls[imageId] = entry.signedUrl;
  }
  return urls;
}

type PhotosRead =
  | { ok: true; images: SubmissionImageView[]; urls: Record<string, string> }
  | { ok: false };

async function readPhotos(
  listed: PromiseLike<{ data: unknown; error: unknown }>,
): Promise<PhotosRead> {
  const { data, error } = await listed;
  if (error) return { ok: false };
  const images = [...((data ?? []) as SubmissionImageView[])].sort(
    (a, b) => a.display_order - b.display_order,
  );
  const urls = await signImages(images);
  // US-3433: a photo we cannot sign is a photo the seller cannot see, and it
  // is the same answer as one we could not list.
  if (!urls) return { ok: false };
  return { ok: true, images, urls };
}

function listPhotos(submissionId: string) {
  return supabase
    .from("submission_images")
    .select(SUBMISSION_IMAGE_COLUMNS)
    .eq("submission_id", submissionId);
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

function DisputeStatusCard({
  dispute,
  title,
  pendingCopy,
}: {
  dispute: DisputeView;
  title: string;
  pendingCopy: string;
}) {
  return (
    <Card className="border-yellow-500/60 bg-yellow-500/5">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Flag className="h-4 w-4" />
            {title}
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
          <p className="text-sm font-medium text-muted-foreground">Reason</p>
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
        {(dispute.status === "open" || dispute.status === "under_review") && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            {pendingCopy}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SubmissionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const visible = useDocumentVisible();
  const [submission, setSubmission] = useState<SubmissionDetailView | null>(null);
  const [gradeReport, setGradeReport] = useState<GradeReportOwnerView | null>(null);
  const [images, setImages] = useState<SubmissionImageView[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  // US-2545 AC2: index of the photo open in the full-screen viewer.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // US-2145: the authenticity appeal dialog.
  const [appealOpen, setAppealOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [dispute, setDispute] = useState<DisputeView | null>(null);
  /**
   * US-3427: the dispute lookup failed, so we do not know whether this report
   * has already been disputed.
   *
   * This is deliberately NOT `error`. The lookup answers one question -- has a
   * dispute been filed -- and its only consumer is the "Dispute Grade" action.
   * Blocking the page on it hid the grade report the seller paid for, which is
   * what turned the critical-path E2E red. read-failure-contract.md says a
   * failed read stops the DEPENDENT ACTION; here that is filing, not rendering.
   *
   * It must also never read as "no dispute exists", which is why canDispute
   * consults it rather than just leaning on `dispute` being null.
   */
  const [disputeCheckFailed, setDisputeCheckFailed] = useState(false);
  // SUB-04: the authenticity appeal on this report, kept apart from `dispute`.
  const [appeal, setAppeal] = useState<DisputeView | null>(null);
  // SUB-11: the page renders before the dispute read lands, so the action
  // waits for it rather than offering to file against an unknown.
  const [disputesLoaded, setDisputesLoaded] = useState(false);
  const [linkedItem, setLinkedItem] = useState<LinkedItemView | null>(null);
  /**
   * US-3428: the linked-inventory lookup failed, so we do not know whether this
   * grade is already attached to a FlipDesk item.
   *
   * Same shape as disputeCheckFailed (US-3427), and here the failure has TWO
   * surfaces of opposite polarity: the linked-item card renders when the row is
   * set, and the "Sell this with FlipDesk" nudge renders when it is NOT. Letting
   * the page render with a null row would keep the card away (correct, we have
   * no row) and show the nudge (wrong -- it asserts the grade is attached to
   * nothing, which is the failed read becoming a fact).
   */
  const [linkedItemCheckFailed, setLinkedItemCheckFailed] = useState(false);
  /**
   * US-3433: the photos could not be loaded, or could not be signed.
   *
   * Third instance of the same shape in this one effect (US-3427's dispute
   * read, US-3428's linked item). The photos feed the submitted-photos card,
   * the lightbox and the retake bridge -- not the grade report, which is what
   * the seller came for. Blocking the page on them hid the grade to explain a
   * missing thumbnail.
   *
   * Both failures collapse to one flag on purpose: a listed-but-unsignable
   * photo and an unlisted one are the same thing to the seller, and to the
   * retake bridge, which needs a signed URL to carry anything at all.
   */
  const [photosUnavailable, setPhotosUnavailable] = useState(false);
  const [disputeDialogOpen, setDisputeDialogOpen] = useState(false);
  const [disputeCategory, setDisputeCategory] = useState("");
  const [disputeReason, setDisputeReason] = useState("");
  const [disputePhotos, setDisputePhotos] = useState<File[]>([]);
  const [evidenceTooLarge, setEvidenceTooLarge] = useState(false);
  const [submittingDispute, setSubmittingDispute] = useState(false);

  // Tracks the currently-rendered submission id so an in-flight refetch bound to
  // a previous id can detect it navigated away and skip its stale setState.
  const currentIdRef = useRef(id);
  useEffect(() => {
    currentIdRef.current = id;
  }, [id]);

  const refetchData = useCallback(async () => {
    if (!id) return;
    try {
      // SUB-11: both reads together.
      const [subRes, reportRes] = await Promise.all([
        supabase.from("submissions").select(SUBMISSION_DETAIL_COLUMNS).eq("id", id).single(),
        supabase
          .from("grade_reports")
          .select(GRADE_REPORT_OWNER_SELECT)
          // US-479: a regraded submission keeps superseded history; fetch only
          // the active report so maybeSingle resolves to one row.
          .eq("submission_id", id)
          .is("superseded_at", null)
          .maybeSingle(),
      ]);
      // A refetch (realtime handler or the poll) can still be in flight when
      // the route param changes A→B; without this guard its resolution would
      // setState the previous submission's data over B. Drop stale writes.
      if (currentIdRef.current !== id) return;
      if (subRes.error) throw subRes.error;
      if (reportRes.error) throw reportRes.error;
      const sub = subRes.data as SubmissionDetailView | null;
      const report = (reportRes.data ?? null) as GradeReportOwnerView | null;
      // SUB-11: a poll that finds nothing new must not re-render the page.
      if (sub) {
        setSubmission((prev) =>
          prev && prev.updated_at === sub.updated_at && prev.status === sub.status
            ? prev
            : sub,
        );
      }
      setGradeReport((prev) =>
        JSON.stringify(prev) === JSON.stringify(report) ? prev : report,
      );
      setRefreshError(false);
    } catch {
      if (currentIdRef.current === id) setRefreshError(true);
    }
  }, [id]);

  // Subscribe to realtime status updates for this submission (US-1628: pass
  // refetchData so the useState-held submission actually refreshes on change —
  // resolving the "we'll let you know the moment it's official" banner live).
  useRealtimeSubmission(id, refetchData);

  // US-3328: a finished grade held for its paid turnaround is invisible to the
  // direct read above (RLS, 00786); its release time comes from the server.
  const turnaround = useGradeTurnaround();
  const readyBy = id && !gradeReport ? turnaround.releaseTimes[id] ?? null : null;

  // ── Auto-retry payment after a mid-flow credit-pack purchase (US-207) ──
  //
  // The new-submission flow sends the user to a pack Checkout with a
  // returnPath of ?pay_retry=1&tier=… on this page. On return we re-run the
  // payment precedence (/api/grade/pay/:id) so the grade proceeds without a
  // second click. The credit-grant webhook lands a beat after Stripe redirects,
  // so we retry a few times before giving up.
  // SUB-09: keyed by submission id, so a second submission's return flow is
  // not swallowed by the first one's flag, and released if the loop is torn
  // down before it finishes (StrictMode's double effect, a fast navigation).
  const payRetryFor = useRef<string | null>(null);
  // Set when the retries ran out without a final answer: the credits may still
  // be arriving, and nothing on the server will start the grade by itself.
  const [payRetryStalledTier, setPayRetryStalledTier] = useState<string | null>(null);
  const [startingGrade, setStartingGrade] = useState(false);
  useEffect(() => {
    setPayRetryStalledTier(null);
  }, [id]);
  useEffect(() => {
    if (!id) return;
    if (searchParams.get("pay_retry") !== "1") return;
    if (payRetryFor.current === id) return;
    payRetryFor.current = id;

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
      toast.info("Payment canceled — your submission is saved as unpaid.");
      clearParams();
      return;
    }

    let cancelled = false;
    let finished = false;
    (async () => {
      toast.loading("Applying your new credits…", { id: "pay-retry" });
      // Up to ~16s of retries to outrun the credit-grant webhook.
      for (let attempt = 0; attempt < PAY_RETRY_ATTEMPTS && !cancelled; attempt++) {
        try {
          const res = await edgeFetch(`/api/grade/pay/${id}`, {
            method: "POST",
            json: { tier },
            silentGate: true,
          });
          if (cancelled) return;
          const json = await res.json().catch(() => ({}));
          if (cancelled) return;
          if (res.ok && json.payment?.paid) {
            finished = true;
            track("grade.pack_upsell_converted", { tier });
            track("grade.paid", { method: json.payment.method, tier });
            toast.success("Grade unlocked with your new credits.", {
              id: "pay-retry",
            });
            await refetchData();
            clearParams();
            return;
          }
          // SUB-09: an answer that will not change on the next attempt.
          if (isFinalPayStatus(res.status)) {
            finished = true;
            toast.error(
              typeof json.error === "string" && json.error
                ? json.error
                : "Couldn't start this grade.",
              { id: "pay-retry" },
            );
            clearParams();
            return;
          }
        } catch {
          /* transient — keep retrying */
        }
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, PAY_RETRY_DELAY_MS));
      }
      if (!cancelled) {
        finished = true;
        // SUB-09: this used to promise the grade "will start automatically".
        // Nothing on the server retries, so say what is true and hand the
        // seller the button that does it.
        toast.info(
          "Your credits are still arriving. Press Start grading in a moment.",
          { id: "pay-retry" },
        );
        setPayRetryStalledTier(tier);
        clearParams();
      }
    })();

    return () => {
      cancelled = true;
      if (!finished) {
        // Torn down mid-loop: never leave the loading toast spinning, and let
        // a re-run of this effect start the loop again.
        toast.dismiss("pay-retry");
        payRetryFor.current = null;
      }
    };
  }, [id, searchParams, setSearchParams, refetchData]);

  async function handleStartGrading() {
    if (!id || !payRetryStalledTier) return;
    setStartingGrade(true);
    try {
      const res = await edgeFetch(`/api/grade/pay/${id}`, {
        method: "POST",
        json: { tier: payRetryStalledTier },
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.payment?.paid) {
        track("grade.paid", { method: json.payment.method, tier: payRetryStalledTier });
        toast.success("Grading started.");
        setPayRetryStalledTier(null);
        await refetchData();
      } else if (res.ok) {
        toast.info("Your credits haven't arrived yet. Try again in a minute.");
      } else {
        toast.error(
          typeof json.error === "string" && json.error ? json.error : "Couldn't start this grade.",
        );
        if (isFinalPayStatus(res.status)) setPayRetryStalledTier(null);
      }
    } catch (err) {
      toastError(err, "Couldn't start this grade");
    } finally {
      setStartingGrade(false);
    }
  }

  // Realtime (above) is the primary trigger; this poll is the fallback while a
  // grade is in flight. Gated on tab visibility so a backgrounded tab stops
  // polling, with one refetch on return to the foreground (US-576).
  //
  // SUB-11: it only runs once a submission has loaded without error (it used
  // to poll a not-found page forever), it no longer fires an immediate
  // duplicate of the load that just happened, and pending_review backs off
  // (detailPollDelay) instead of reading every 5s for a 12 to 48 hour review.
  const submissionStatus = submission?.status;
  const pollable = Boolean(submission) && !error && !loading && isPollableStatus(submissionStatus);
  const wasHiddenRef = useRef(false);
  useEffect(() => {
    if (!visible) {
      wasHiddenRef.current = true;
      return;
    }
    if (!pollable || !isPollableStatus(submissionStatus)) return;
    const status = submissionStatus;
    if (wasHiddenRef.current) {
      wasHiddenRef.current = false;
      void refetchData();
    }
    let n = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(() => {
        void refetchData();
        n++;
        tick();
      }, detailPollDelay(status, n));
    };
    tick();
    return () => clearTimeout(timer);
  }, [visible, pollable, submissionStatus, refetchData]);

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

  function applyLinkedItem(result: LinkedItemRead) {
    if (!result.ok) {
      // US-3428: withhold what this read feeds, not the grade report.
      setLinkedItem(null);
      setLinkedItemCheckFailed(true);
    } else {
      setLinkedItemCheckFailed(false);
      setLinkedItem(result.item);
    }
  }

  function applyPhotos(result: PhotosRead) {
    if (!result.ok) {
      // US-3433: withhold the photos, not the grade.
      setImages([]);
      setImageUrls({});
      setPhotosUnavailable(true);
      return;
    }
    setPhotosUnavailable(false);
    setImages(result.images);
    setImageUrls(result.urls);
    resignedRef.current = false;
  }

  // SUB-11: retry buttons re-run only their own read.
  async function retryLinkedItem() {
    if (!id) return;
    const result = await readLinkedItem(id);
    if (currentIdRef.current === id) applyLinkedItem(result);
  }
  async function retryPhotos() {
    if (!id) return;
    const result = await readPhotos(listPhotos(id));
    if (currentIdRef.current === id) applyPhotos(result);
  }

  // SUB-11: signed URLs last 15 minutes. A grid or lightbox image that fails
  // to load re-signs every photo once; a second failure is left alone so a
  // truly missing file cannot loop.
  const resignedRef = useRef(false);
  async function resignOnce() {
    if (resignedRef.current || images.length === 0) return;
    resignedRef.current = true;
    const urls = await signImages(images);
    if (urls && currentIdRef.current === id) setImageUrls(urls);
  }

  useEffect(() => {
    if (!id) return;
    // US-1632: guard against an A→B navigation race — the old id's async
    // continuations must not write state over the new page.
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);
      setRefreshError(false);
      // Reset stale detail state on id change so B never briefly shows A's
      // grade/dispute/images while it loads.
      setSubmission(null);
      setGradeReport(null);
      setDispute(null);
      setAppeal(null);
      setDisputesLoaded(false);
      setLinkedItem(null);
      setImages([]);
      setImageUrls({});

      // SUB-11: the four reads start together instead of one after another.
      // The page renders as soon as the two it is FOR have landed.
      const subP = supabase
        .from("submissions")
        .select(SUBMISSION_DETAIL_COLUMNS)
        .eq("id", id!)
        .single();
      // US-479: active report only — a regraded submission keeps superseded
      // history, which would break .single().
      const reportP = supabase
        .from("grade_reports")
        .select(GRADE_REPORT_OWNER_SELECT)
        .eq("submission_id", id!)
        .is("superseded_at", null)
        .maybeSingle();
      const linkedP = readLinkedItem(id!);
      const photosP = readPhotos(listPhotos(id!));

      const [subRes, reportRes] = await Promise.all([subP, reportP]);
      if (cancelled) return;
      const sub = subRes.data as SubmissionDetailView | null;
      if (subRes.error || !sub) {
        setError(subRes.error && subRes.error.code !== "PGRST116" ? "Couldn't load this submission. Please try again." : "Submission not found.");
        setLoading(false);
        return;
      }
      // US-1632: a TRANSIENT error here (maybeSingle doesn't error on "no
      // report yet", so this is a real DB/network failure) previously was
      // swallowed, leaving a completed grade stuck on "Grade Report Pending"
      // forever. Surface it so the user can retry.
      if (reportRes.error) {
        setError("Couldn't load the grade report. Please try again.");
        setLoading(false);
        return;
      }
      const reportData = (reportRes.data ?? null) as GradeReportOwnerView | null;
      setSubmission(sub);
      setGradeReport(reportData);
      setLoading(false);

      // Fetch existing disputes for this grade report. US-1632: .maybeSingle()
      // -- the normal zero-dispute case is NOT an error.
      // SUB-04: grade disputes and authenticity appeals share the table (00489).
      // Without the kind filter an appeal read as a dispute (hiding Dispute
      // Grade), and a report carrying both made maybeSingle error forever.
      const disputesP = reportData
        ? Promise.all([
            supabase
              .from("disputes")
              .select(DISPUTE_VIEW_COLUMNS)
              .eq("grade_report_id", reportData.id)
              .eq("kind", "grade")
              .maybeSingle(),
            supabase
              .from("disputes")
              .select(DISPUTE_VIEW_COLUMNS)
              .eq("grade_report_id", reportData.id)
              .eq("kind", "authenticity")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
          ])
        : Promise.resolve(null);

      const [linked, photos, disputes] = await Promise.all([linkedP, photosP, disputesP]);
      if (cancelled) return;
      applyLinkedItem(linked);
      applyPhotos(photos);
      if (disputes) {
        const [gradeDisputeRes, appealRes] = disputes;
        if (gradeDisputeRes.error) {
          // US-3427: withhold the dispute action, not the report. Clearing
          // `dispute` alongside the flag keeps the two from disagreeing on a
          // retry that fails after one that succeeded.
          setDispute(null);
          setDisputeCheckFailed(true);
        } else {
          setDisputeCheckFailed(false);
          setDispute(gradeDisputeRes.data ? (gradeDisputeRes.data as DisputeView) : null);
        }
        // An appeal that failed to load only hides its own status card.
        setAppeal(
          !appealRes.error && appealRes.data ? (appealRes.data as DisputeView) : null,
        );
      }
      setDisputesLoaded(true);
    }

    void fetchData().catch(() => {
      if (cancelled) return;
      setError("Couldn't load this submission. Please try again.");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [id, loadAttempt]);

  // SUB-11: a held grade has a known release time. Refetch once just after it
  // instead of polling for the whole hold.
  useEffect(() => {
    const delay = releaseRefetchDelay(readyBy);
    if (delay === null) return;
    const t = setTimeout(() => void refetchData(), delay);
    return () => clearTimeout(t);
  }, [readyBy, refetchData]);

  // SUB-11: the turnaround query is what knows a finished grade is being
  // held. When the status moves on and there is no report to show, ask it
  // again rather than serving the answer from before the grade finished.
  const queryClient = useQueryClient();
  const hasReport = Boolean(gradeReport);
  useEffect(() => {
    if (hasReport) return;
    if (submissionStatus === "pending_review" || submissionStatus === "completed") {
      void queryClient.invalidateQueries({ queryKey: ["grade-turnaround"] });
    }
  }, [submissionStatus, hasReport, queryClient]);

  // US-3427: split out so the withheld-action notice below can ask the same
  // question the button does. Everything except "do we know about an existing
  // dispute" lives here.
  const disputeWindowOpen = Boolean(
    submission?.status === "completed" &&
      gradeReport &&
      (() => {
        const createdAt = new Date(gradeReport.created_at);
        const windowStart = new Date();
        windowStart.setDate(windowStart.getDate() - DISPUTE_WINDOW_DAYS);
        return createdAt > windowStart;
      })(),
  );

  // US-3427: `!disputeCheckFailed` is the load-bearing clause. Without it an
  // unresolved lookup reads as "no dispute exists" and offers to file a second.
  const canDispute =
    disputeWindowOpen && disputesLoaded && !dispute && !disputeCheckFailed;

  /** The seller could dispute, but we could not find out whether they already have. */
  const disputeCheckUnavailable = disputeWindowOpen && disputeCheckFailed;

  // US-949: one-tap retake. Carry the prior submission's garment details, any
  // inventory linkage, the grader's flagged photo types, and the PASSING photos
  // (as short-lived signed URLs) over to a fresh submission so a needs_photos /
  // expired result isn't a dead end. The new submission references this one and
  // supersedes it server-side (see grade.ts /submit `retake_of`).
  async function handleRetake() {
    if (!submission) return;

    // US-3428: the retake bridge CARRIES linkedItemId, so it is genuinely
    // dependent on that read. If the page-load lookup failed, sending the
    // seller onward with `null` would silently detach a grade from an item it
    // is already on, and there is no undo for that from the new submission.
    //
    // A retake is a deliberate press, not a render, so one more read here is
    // cheap and it answers the question. Only if THAT fails do we stop, which
    // is the dependent action stopping -- the page itself stayed up the whole
    // time.
    // US-3433: the retake CARRIES reusablePhotos, so a failed photo load would
    // start the new submission with nothing to reuse and no sign that anything
    // was lost. A retake is a deliberate press, so say so and stop rather than
    // quietly hand over an empty set. Unlike the linked item, a re-read here
    // would also need the signing round-trip, and the page's own retry already
    // does both.
    if (photosUnavailable) {
      toast.error(
        "Couldn't load this submission's photos, and a retake would start without them. Use Try again on the photos card first.",
      );
      return;
    }

    let linked = linkedItem;
    if (linkedItemCheckFailed) {
      const { data, error } = await supabase
        .from("inventory_items")
        .select(LINKED_ITEM_COLUMNS)
        .eq("submission_id", submission.id)
        .maybeSingle();
      if (error) {
        toast.error(
          "Couldn't check whether this grade is on a FlipDesk item, and a retake would drop the link. Try again.",
        );
        return;
      }
      linked = data ? (data as LinkedItemView) : null;
      setLinkedItem(linked);
      setLinkedItemCheckFailed(false);
    }
    const flaggedImageTypes = Array.from(
      new Set(
        (submission.quality_feedback?.issues ?? [])
          .filter((i) => i.severity === "block")
          .map((i) => i.image_type as ImageType)
      )
    );
    const flaggedSet = new Set<ImageType>(flaggedImageTypes);
    // SUB-11: the page's URLs were signed when it loaded and last 15 minutes.
    // A seller who reads the feedback for a while and then presses Retake
    // would hand the new submission dead links, so sign fresh ones here.
    const reusable = images.filter((img) => !flaggedSet.has(img.image_type));
    const freshUrls = await signImages(reusable);
    if (!freshUrls) {
      toast.error(
        "Couldn't prepare this submission's photos for a retake. Try again.",
      );
      return;
    }
    const reusablePhotos = reusable
      .filter((img) => freshUrls[img.id])
      .map((img) => ({
        imageType: img.image_type,
        signedUrl: freshUrls[img.id]!,
      }));

    const retake: RetakeBridgeState = {
      priorSubmissionId: submission.id,
      garmentType: submission.garment_type,
      garmentCategory: submission.garment_category,
      brand: submission.brand ?? undefined,
      title: submission.title,
      description: submission.description ?? undefined,
      styleAttributes: submission.style_attributes,
      // US-3428: `linked`, not `linkedItem` -- the re-read above may have just
      // resolved it, and this state setter has not landed yet.
      linkedItemId: linked?.id ?? null,
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
      // SUB-10: shrink each photo before encoding, and refuse a body the edge
      // would answer 413 (nothing filed) before sending it.
      const prepared = await prepareEvidence(
        disputePhotos,
        async (file) =>
          (await compressImage(file, EVIDENCE_MAX_WIDTH, EVIDENCE_QUALITY)).blob,
        fileToDataUrl,
      );
      if (prepared.overBudget) {
        setEvidenceTooLarge(true);
        return;
      }
      const images = prepared.images;

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

      // SUB-05: the dispute route alerts the admins itself, keyed on the
      // workspace owner the dispute is stored under.

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
            <Button variant="outline" className="mt-4" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</Button>
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

  return (
    <div className="space-y-6">
      {payRetryStalledTier && submission.status === "pending" && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
        >
          <p>
            Your credits are still arriving. Once they land, start the grade here.
          </p>
          <Button size="sm" onClick={() => void handleStartGrading()} disabled={startingGrade}>
            {startingGrade && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Start grading
          </Button>
        </div>
      )}
      {refreshError && (
        <div role="alert" className="space-y-2">
          <p>Couldn't refresh this grade. You're seeing the last loaded result.</p>
          <Button variant="outline" onClick={() => void refetchData()}>Try again</Button>
        </div>
      )}
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
                    <DisputeEvidencePicker
                      photos={disputePhotos}
                      disabled={submittingDispute}
                      onChange={(next) => {
                        setEvidenceTooLarge(false);
                        setDisputePhotos(next);
                      }}
                    />
                    {evidenceTooLarge && (
                      <p role="alert" className="text-sm text-brand-red-text">
                        These photos are too large to send together. Remove one
                        or two and try again.
                      </p>
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
          {/*
            US-3427: the dispute action, withheld rather than missing. We do not
            know whether this report already carries a dispute, so offering to
            file one could file a second; saying nothing would read as "the
            window closed". The retry re-runs the same load the page does.
          */}
          {disputeCheckUnavailable && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Flag className="h-4 w-4 shrink-0" />
              <span>Couldn&apos;t check whether you already disputed this grade.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                Try again
              </Button>
            </div>
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
                    This grade is not official yet. {HUMAN_REVIEW.what}{" "}
                    {HUMAN_REVIEW.certificate} {HUMAN_REVIEW.cost}{" "}
                    {WHERE_IT_APPEARS}
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
                    {/* US-2871: the tier alone is a word with no arithmetic
                        behind it. The band comes from GRADE_TIER_BANDS, the
                        same table tierLabelForGrade now reads. */}
                    <p className="mt-1 text-sm text-muted-foreground">
                      Scores {tierBandRange(gradeReport.grade_tier)} out of 10
                    </p>
                    {/* US-3339: a measured range, only where regrades were measured. */}
                    <GradeRangeNote
                      score={gradeReport.overall_score}
                      category={submission.garment_category}
                    />
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
                  // US-3329: no photo could judge cleanliness, so the score is a
                  // neutral placeholder. Say so, and say what would fix it.
                  if (key === "odor_cleanliness" && !cleanlinessVisible(gradeReport.per_image_analysis)) {
                    return (
                      <div key={key} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium">
                            {factor.label}{" "}
                            <span className="text-muted-foreground">
                              ({(factor.weight * 100).toFixed(0)}%)
                            </span>
                          </span>
                          <span className="text-muted-foreground">n/a</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Not visible in these photos. A close-up of the collar, underarms or any marks lets it be judged next time.
                        </p>
                      </div>
                    );
                  }
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
                {/* label and weight come from GRADE_FACTORS here; the
                    certificate passes its grade's own rubric instead. */}
                <ScoreExplainer
                  factors={factorScores.map(({ key, score }) => ({
                    key,
                    label: GRADE_FACTORS[key].label,
                    weight: GRADE_FACTORS[key].weight,
                    score,
                  }))}
                  overallScore={gradeReport.overall_score}
                  className="mt-2"
                />
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
                {/* US-3330: which single flaw keeps this from the next tier. */}
                {limitingFlawSentence(gradeReport.limiting_flaw) && (
                  <p className="text-sm font-medium">
                    {limitingFlawSentence(gradeReport.limiting_flaw)}
                  </p>
                )}
                {/* US-514: AI-transparency disclosure (mirrors the public
                    certificate + Terms §5). */}
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  AI-generated condition estimate — not a professional appraisal
                  or guarantee. This grade is produced automatically from photos
                  and is an estimate of condition only. {HUMAN_REVIEW.what} See{" "}
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
                        <p className="mt-1.5 text-sm text-muted-foreground">
                          {confidenceExplanation()}
                        </p>
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* SUB-03: one row per structured flaw, never the internal notes. */}
            <DetectedIssues defects={gradeReport.defects_found} />

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
                  We are reading your photos now.
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
                <WhatHappensNext
                  status={submission.status}
                  tier={submission.service_tier ?? null}
                  live={turnaround.live}
                />
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
                <WhatHappensNext
                  status={submission.status}
                  tier={submission.service_tier ?? null}
                  live={turnaround.live}
                />
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
                  <Button onClick={() => void handleRetake()}>
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
                  <Button onClick={() => void handleRetake()}>
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
                  <Button onClick={() => void handleRetake()}>
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
            ) : readyBy ? (
              // US-3328: finished and held for the turnaround the seller paid
              // for (US-3326). The report is hidden until then, by design.
              <>
                <Clock className="h-12 w-12 text-muted-foreground/50" />
                <h3 className="mt-4 text-lg font-medium">
                  Ready by {formatReadyBy(readyBy)}
                </h3>
                <WhatHappensNext
                  status={submission.status}
                  tier={submission.service_tier ?? null}
                  readyBy={readyBy}
                  live={turnaround.live}
                />
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
        {submission.status === "completed" && gradeReport && !linkedItem &&
          linkedItemCheckFailed && (
          // US-3428: the nudge below says this grade is not on an item yet. We
          // do not know that, so say what we do know and offer the retry.
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Tag className="h-4 w-4 shrink-0" />
            Couldn&apos;t check whether this grade is already on a FlipDesk item.
            <Button
              variant="outline"
              size="sm"
              onClick={() => void retryLinkedItem()}
            >
              Try again
            </Button>
          </p>
        )}
        {submission.status === "completed" && gradeReport && !linkedItem &&
          !linkedItemCheckFailed && (
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
      {/* SUB-04: a grade dispute and an authenticity appeal are different
          things with different outcomes, so each has its own card. */}
      {dispute && (
        <DisputeStatusCard
          dispute={dispute}
          title={DISPUTE_KIND_LABEL.grade}
          pendingCopy="Your dispute is being reviewed. We'll notify you when a decision is made."
        />
      )}
      {appeal && (
        <DisputeStatusCard
          dispute={appeal}
          title={DISPUTE_KIND_LABEL.authenticity}
          pendingCopy="Your appeal is being reviewed. We'll notify you when a decision is made."
        />
      )}

      {/*
        US-3433: an absent photo card asserts "no photos were submitted", which
        is a different fact from "we could not load them". Say the second one,
        and offer the retry, rather than letting the section vanish.
      */}
      {photosUnavailable && (
        <>
          <Separator />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Submitted Photos</CardTitle>
              <CardDescription>
                Couldn&apos;t load the photos for this submission. The grade
                above is unaffected.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void retryPhotos()}
              >
                Try again
              </Button>
            </CardContent>
          </Card>
        </>
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
                          onError={() => void resignOnce()}
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
          onImageError={() => void resignOnce()}
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

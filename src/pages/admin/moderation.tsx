import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { supabase } from "@/lib/supabase";
import type {
  SubmissionRow,
  UserRow,
  SubmissionImageRow,
  GradeReportRow,
} from "@/types/database";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Ban,
  Loader2,
  ExternalLink,
  EyeOff,
  Eye,
  Undo2,
  Tags,
  Image as ImageIcon,
  Bell,
} from "lucide-react";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { safeHref } from "@/lib/safe-url";

interface FlaggedSubmission {
  submission: SubmissionRow;
  user: UserRow | null;
  report: GradeReportRow | null;
  images: { id: string; url: string }[];
}

interface FlagType {
  label: string;
  cls: string;
}

const RED =
  "border-red-200 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300";
const AMBER =
  "border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300";
const SLATE = "border-slate-200 bg-slate-100 text-slate-700";

// US-2025: defensive cap on the moderation queue. Normally a handful of rows —
// this exists so a mass-flagging event cannot take the console down at the
// moment it is most needed.
const MODERATION_QUEUE_LIMIT = 1000;

// Derive the specific reasons a submission is in the queue from the structured
// grade signals (US-336/337/338) + the free-text flag reason, so a reviewer
// sees WHAT to check rather than a generic "flagged".
function deriveFlagTypes(
  submission: SubmissionRow,
  report: GradeReportRow | null,
): FlagType[] {
  const types: FlagType[] = [];
  const auth = report?.image_authenticity ?? null;
  const notes = report?.detailed_notes ?? {};
  const reason = (submission.flag_reason ?? "").toLowerCase();

  if (auth?.manipulation_suspected) {
    types.push({ label: "Possible photo edit", cls: RED });
  }
  if (auth?.screenshot_or_watermark_detected) {
    types.push({ label: "Screenshot / watermark", cls: AMBER });
  }
  if (notes["photo_reuse"] || reason.includes("match an image")) {
    types.push({ label: "Reused photo", cls: RED });
  }
  if (reason.includes("clothing")) {
    types.push({ label: "May not be clothing", cls: SLATE });
  }
  if (types.length === 0) types.push({ label: "Flagged", cls: SLATE });
  return types;
}

export function AdminModerationPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Content Moderation"
        subtitle="Review and take down content across all tenants — flagged grading submissions, marketplace listings, uploaded item photos, and certificates buyers have reported."
        icon={ShieldAlert}
      />

      <Tabs defaultValue="submissions">
        <TabsList>
          <TabsTrigger value="submissions">
            <ShieldAlert className="mr-1.5 h-4 w-4" />
            Submissions
          </TabsTrigger>
          <TabsTrigger value="listings">
            <Tags className="mr-1.5 h-4 w-4" />
            Listings
          </TabsTrigger>
          <TabsTrigger value="photos">
            <ImageIcon className="mr-1.5 h-4 w-4" />
            Photos
          </TabsTrigger>
          {/* US-2550: buyer reports filed from /cert/:id. */}
          <TabsTrigger value="certificates">
            <ShieldAlert className="mr-1.5 h-4 w-4" />
            Certificates
          </TabsTrigger>
        </TabsList>
        <TabsContent value="submissions" className="mt-6">
          <SubmissionsTab />
        </TabsContent>
        <TabsContent value="listings" className="mt-6">
          <ListingsTab />
        </TabsContent>
        <TabsContent value="photos" className="mt-6">
          <PhotosTab />
        </TabsContent>
        <TabsContent value="certificates" className="mt-6">
          <CertificatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Submissions tab (the original grading-submission moderation queue).
// ─────────────────────────────────────────────────────────────────────────────
function SubmissionsTab() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<FlaggedSubmission | null>(null);
  // US-476: the ban endpoint requires a fresh MFA step-up; on a STEP_UP_REQUIRED
  // response we open this dialog and retry the pending ban after re-verification.
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingBan, setPendingBan] = useState<FlaggedSubmission | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["admin-moderation"],
    queryFn: async (): Promise<FlaggedSubmission[]> => {
      // US-2025: this page was flagged as "four unbounded select('*')", but on
      // reading it that is not what it is — everything after the anchor is
      // already a correctly-scoped .in() cascade, which is the pattern the other
      // admin pages were being fixed TO. The anchor is also selective by nature:
      // flagged AND not-yet-moderated is a live queue, normally tiny.
      //
      // The one real risk is a mass-flagging event (a bad heuristic, an abuse
      // wave) turning that queue into thousands of rows and taking the console
      // down exactly when an operator needs it. So: a defensive cap, not a
      // restructure.
      const { data: subsRaw, error } = await supabase
        .from("submissions")
        .select("*")
        .eq("flagged", true)
        .is("moderation_status", null)
        .order("created_at", { ascending: false })
        .limit(MODERATION_QUEUE_LIMIT);
      if (error) throw error;
      const submissions = (subsRaw ?? []) as SubmissionRow[];
      if (submissions.length === 0) return [];

      const userIds = [...new Set(submissions.map((s) => s.user_id))];
      const { data: usersRaw } = await supabase
        .from("users")
        .select("*")
        .in("id", userIds);
      const usersById = new Map<string, UserRow>();
      for (const u of (usersRaw ?? []) as UserRow[]) {
        usersById.set(u.id, u);
      }

      const submissionIds = submissions.map((s) => s.id);

      // Grade reports carry the structured fraud signals (authenticity, reuse
      // notes, confidence) we surface for each flagged item.
      const { data: reportsRaw } = await supabase
        .from("grade_reports")
        .select("*")
        .in("submission_id", submissionIds)
        .is("superseded_at", null); // US-479: active report per submission
      const reportBySubmission = new Map<string, GradeReportRow>();
      for (const r of (reportsRaw ?? []) as GradeReportRow[]) {
        reportBySubmission.set(r.submission_id, r);
      }

      const { data: imagesRaw } = await supabase
        .from("submission_images")
        .select("*")
        .in("submission_id", submissionIds);
      const imagesBySubmission = new Map<string, SubmissionImageRow[]>();
      for (const img of (imagesRaw ?? []) as SubmissionImageRow[]) {
        const list = imagesBySubmission.get(img.submission_id) ?? [];
        list.push(img);
        imagesBySubmission.set(img.submission_id, list);
      }

      const result: FlaggedSubmission[] = [];
      for (const submission of submissions) {
        const imgs = imagesBySubmission.get(submission.id) ?? [];
        const signed: { id: string; url: string }[] = [];
        for (const img of imgs) {
          const { data: urlData } = await supabase.storage
            .from("submission-images")
            // private bucket — short-lived signed URL (US-276)
            .createSignedUrl(img.storage_path, 900);
          if (urlData?.signedUrl) {
            signed.push({ id: img.id, url: urlData.signedUrl });
          }
        }
        result.push({
          submission,
          user: usersById.get(submission.user_id) ?? null,
          report: reportBySubmission.get(submission.id) ?? null,
          images: signed,
        });
      }
      return result;
    },
    staleTime: 30 * 1000,
  });

  // US-476/477: moderation actions go through audited service-role edge routes
  // (POST /api/admin/moderation/:id/{approve,reject,ban}) instead of direct
  // browser-client writes — so authz isn't left to RLS and every action writes
  // an admin_audit_log row attributed to the acting admin.
  async function handleApprove(entry: FlaggedSubmission) {
    setBusyId(entry.submission.id);
    try {
      const res = await edgeFetch(
        `/api/admin/moderation/${entry.submission.id}/approve`,
        { method: "POST", json: {} },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to approve submission.");
      toast.success("Submission approved — flag cleared.");
      await refetch();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to approve submission."
      );
    } finally {
      setBusyId(null);
    }
  }

  // Reject the submission as invalid and refund the user's monthly grade credit.
  async function handleReject(entry: FlaggedSubmission) {
    setBusyId(entry.submission.id);
    try {
      const res = await edgeFetch(
        `/api/admin/moderation/${entry.submission.id}/reject`,
        { method: "POST", json: {} },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to reject submission.");
      toast.success(
        j.grade_credit_refunded
          ? "Submission rejected and the grade credit refunded."
          : "Submission rejected.",
      );
      await refetch();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to reject submission."
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleBan(entry: FlaggedSubmission) {
    if (!entry.user) return;
    setBusyId(entry.submission.id);
    try {
      const res = await edgeFetch(
        `/api/admin/moderation/${entry.submission.id}/ban`,
        { method: "POST", json: {}, silentGate: true },
      );
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && j?.code === "STEP_UP_REQUIRED") {
        // Re-verify MFA, then retry this ban.
        setPendingBan(entry);
        setStepUpOpen(true);
        return;
      }
      if (!res.ok) throw new Error(j.error ?? "Failed to ban user.");
      toast.success("User suspended and submission rejected.");
      setBanTarget(null);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to ban user.");
    } finally {
      setBusyId(null);
    }
  }

  const entries = data ?? [];

  return (
    <>
      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      ) : isError ? (
        /* US-2507: BEFORE the empty branch. "Queue is clear" on a failed load
           is the most expensive lie this page can tell — it says there is
           nothing to moderate when nobody actually looked. */
        <Card>
          <ErrorState
            title="Couldn't load the moderation queue"
            description="The queue is still there — we just couldn't fetch it right now."
            onRetry={() => void refetch()}
            retrying={isFetching}
          />
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={CheckCircle2}
            title="Queue is clear"
            description="No submissions are currently awaiting moderation. Flagged submissions will appear here for review."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => {
            const busy = busyId === entry.submission.id;
            const report = entry.report;
            const flagTypes = deriveFlagTypes(entry.submission, report);
            const auth = report?.image_authenticity ?? null;
            const reuseNote = report?.detailed_notes?.["photo_reuse"] ?? null;
            return (
              <Card key={entry.submission.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">
                        {entry.submission.title}
                      </CardTitle>
                      <CardDescription>
                        {entry.user ? (
                          <Link
                            to={`/admin/users/${entry.user.id}`}
                            className="hover:underline"
                          >
                            {entry.user.full_name || entry.user.email}
                          </Link>
                        ) : (
                          "Unknown user"
                        )}
                        {" · "}
                        {new Date(
                          entry.submission.created_at
                        ).toLocaleDateString()}
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {flagTypes.map((t) => (
                        <Badge key={t.label} variant="outline" className={t.cls}>
                          {t.label}
                        </Badge>
                      ))}
                      {entry.user?.suspended && (
                        <Badge variant="outline" className={RED}>
                          User suspended
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <span className="font-medium">Flag reason: </span>
                      {entry.submission.flag_reason ||
                        "Images may not depict an item of clothing."}
                    </span>
                  </div>

                  {/* Grade + fraud-signal context */}
                  {report && (
                    <div className="rounded-md border bg-muted/30 p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>
                          <span className="text-muted-foreground">Grade: </span>
                          <span className="font-semibold">
                            {report.overall_score.toFixed(1)}
                          </span>{" "}
                          ({report.grade_tier})
                        </span>
                        <span>
                          <span className="text-muted-foreground">Confidence: </span>
                          <span className="font-medium">
                            {Math.round(report.confidence_score * 100)}%
                          </span>
                        </span>
                        {report.certificate_id && (
                          <Link
                            to={`/cert/${report.certificate_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-brand-navy hover:underline dark:text-foreground"
                          >
                            View grade
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                        )}
                      </div>
                      {auth &&
                        (auth.manipulation_suspected ||
                          auth.screenshot_or_watermark_detected) &&
                        auth.tells.length > 0 && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            <span className="font-medium">Authenticity tells: </span>
                            {auth.tells.join("; ")}
                            {auth.flagged_image_types.length > 0 &&
                              ` (images: ${auth.flagged_image_types.join(", ")})`}
                          </p>
                        )}
                      {reuseNote && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          <span className="font-medium">Photo reuse: </span>
                          {reuseNote}
                        </p>
                      )}
                    </div>
                  )}

                  {entry.images.length > 0 && (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                      {entry.images.map((img) => (
                        <div
                          key={img.id}
                          className="aspect-square overflow-hidden rounded-md border bg-muted"
                        >
                          <img
                            src={img.url}
                            alt="Flagged submission"
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => handleApprove(entry)}
                      aria-label={`Approve ${entry.submission.title}`}
                    >
                      {busy ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="mr-1.5 h-4 w-4 text-green-600 dark:text-green-400" />
                      )}
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => handleReject(entry)}
                      aria-label={`Reject and refund ${entry.submission.title}`}
                    >
                      <XCircle className="mr-1.5 h-4 w-4 text-destructive" />
                      Reject &amp; refund
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy || !entry.user || entry.user.suspended}
                      onClick={() => setBanTarget(entry)}
                      aria-label={`Ban the seller behind ${entry.submission.title}`}
                    >
                      <Ban className="mr-1.5 h-4 w-4" />
                      Ban user
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Ban confirmation */}
      <Dialog
        open={banTarget !== null}
        onOpenChange={(open) => !open && setBanTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend this user?</DialogTitle>
            <DialogDescription>
              {banTarget?.user
                ? `${
                    banTarget.user.full_name || banTarget.user.email
                  } will be unable to create new submissions. This submission will also be rejected.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBanTarget(null)}
              disabled={busyId !== null}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busyId !== null}
              onClick={() => banTarget && handleBan(banTarget)}
            >
              {busyId !== null && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Suspend User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          const target = pendingBan;
          setPendingBan(null);
          if (target) void handleBan(target);
        }}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared types + helpers for the listing/photo moderation tabs (US-889).
// ─────────────────────────────────────────────────────────────────────────────
interface ModOwner {
  id: string;
  email: string | null;
  full_name: string | null;
  suspended: boolean;
}
interface ModFlag {
  id: string;
  reason: string;
  source: string;
  createdAt: string;
}
interface ListingRowDto {
  id: string;
  ownerUserId: string;
  owner: ModOwner | null;
  title: string | null;
  url: string | null;
  platform: string;
  price: number;
  listingStatus: string;
  isActive: boolean;
  moderationHidden: boolean;
  previewUrl: string | null;
  updatedAt: string;
  flag: ModFlag | null;
}
interface PhotoRowDto {
  id: string;
  inventoryItemId: string;
  ownerUserId: string | null;
  owner: ModOwner | null;
  photoType: string;
  isHidden: boolean;
  previewUrl: string | null;
  createdAt: string;
  flag: ModFlag | null;
}
interface ModPage<T> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

function OwnerLink({ owner }: { owner: ModOwner | null }) {
  if (!owner) return <span>Unknown user</span>;
  return (
    <Link to={`/admin/users/${owner.id}`} className="hover:underline">
      {owner.full_name || owner.email}
    </Link>
  );
}

function Pager({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 pt-2">
      <Button
        size="sm"
        variant="outline"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </Button>
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Listings tab — cross-tenant listing moderation (takedown / restore / notify).
// ─────────────────────────────────────────────────────────────────────────────
function ListingsTab() {
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingTakedown, setPendingTakedown] = useState<string | null>(null);
  const [notifyTarget, setNotifyTarget] = useState<ListingRowDto | null>(null);
  const [notifyMsg, setNotifyMsg] = useState("");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-moderation-listings", page],
    queryFn: async (): Promise<ModPage<ListingRowDto>> => {
      const res = await edgeFetch(
        `/api/admin/moderation/listings?page=${page}&page_size=20`,
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to load listings.");
      return j as ModPage<ListingRowDto>;
    },
    staleTime: 30 * 1000,
  });

  async function takedown(id: string) {
    setBusyId(id);
    try {
      const res = await edgeFetch(
        `/api/admin/moderation/listings/${id}/takedown`,
        { method: "POST", json: {}, silentGate: true },
      );
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && j?.code === "STEP_UP_REQUIRED") {
        setPendingTakedown(id);
        setStepUpOpen(true);
        return;
      }
      if (!res.ok) throw new Error(j.error ?? "Failed to take down listing.");
      toast.success("Listing taken down (unpublished).");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to take down listing.");
    } finally {
      setBusyId(null);
    }
  }

  async function restore(id: string) {
    setBusyId(id);
    try {
      const res = await edgeFetch(
        `/api/admin/moderation/listings/${id}/restore`,
        { method: "POST", json: {} },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to restore listing.");
      toast.success("Listing restored.");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restore listing.");
    } finally {
      setBusyId(null);
    }
  }

  async function sendNotice() {
    if (!notifyTarget || !notifyMsg.trim()) return;
    setBusyId(notifyTarget.id);
    try {
      const res = await edgeFetch(`/api/admin/moderation/notify-owner`, {
        method: "POST",
        json: {
          content_type: "listing",
          content_id: notifyTarget.id,
          message: notifyMsg.trim(),
        },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to notify owner.");
      toast.success("Owner notified.");
      setNotifyTarget(null);
      setNotifyMsg("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to notify owner.");
    } finally {
      setBusyId(null);
    }
  }

  const rows = data?.rows ?? [];

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={CheckCircle2}
          title="No flagged listings"
          description="Listings flagged by the fraud console or user reports will appear here for takedown review."
        />
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {rows.map((row) => {
          const busy = busyId === row.id;
          const down = row.moderationHidden;
          return (
            <Card key={row.id}>
              <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row">
                <div className="aspect-square h-24 w-24 shrink-0 overflow-hidden rounded-md border bg-muted">
                  {row.previewUrl ? (
                    <img
                      src={row.previewUrl}
                      alt="Listing"
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                      <ImageIcon className="h-6 w-6" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {row.title || "Untitled listing"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        <OwnerLink owner={row.owner} /> · {row.platform} · $
                        {Number(row.price).toFixed(2)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline" className={down ? RED : SLATE}>
                        {down ? "Taken down" : row.listingStatus}
                      </Badge>
                      {row.flag && (
                        <Badge variant="outline" className={AMBER}>
                          {row.flag.source}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {row.flag && (
                    <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{row.flag.reason}</span>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {down ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => restore(row.id)}
                      >
                        {busy ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <Undo2 className="mr-1.5 h-4 w-4" />
                        )}
                        Restore
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => takedown(row.id)}
                      >
                        {busy ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <EyeOff className="mr-1.5 h-4 w-4" />
                        )}
                        Take down
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      aria-label={`Notify the owner about ${row.title ?? row.url}`}
                      onClick={() => {
                        setNotifyTarget(row);
                        setNotifyMsg("");
                      }}
                    >
                      <Bell className="mr-1.5 h-4 w-4" />
                      Notify owner
                    </Button>
                    {safeHref(row.url) && (
                      <Button size="sm" variant="ghost" asChild>
                        <a href={safeHref(row.url) ?? undefined} target="_blank" rel="noreferrer">
                          <ExternalLink className="mr-1.5 h-4 w-4" />
                          View
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Pager
        page={data?.page ?? 1}
        totalPages={data?.totalPages ?? 1}
        onPage={setPage}
      />

      <NotifyDialog
        open={notifyTarget !== null}
        label={notifyTarget?.title || "this listing"}
        message={notifyMsg}
        onMessage={setNotifyMsg}
        busy={busyId !== null}
        onClose={() => setNotifyTarget(null)}
        onSend={sendNotice}
      />
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          const id = pendingTakedown;
          setPendingTakedown(null);
          if (id) void takedown(id);
        }}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Photos tab — cross-tenant item-photo moderation (hide / unhide / notify).
// ─────────────────────────────────────────────────────────────────────────────
function PhotosTab() {
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingHide, setPendingHide] = useState<string | null>(null);
  const [notifyTarget, setNotifyTarget] = useState<PhotoRowDto | null>(null);
  const [notifyMsg, setNotifyMsg] = useState("");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-moderation-photos", page],
    queryFn: async (): Promise<ModPage<PhotoRowDto>> => {
      const res = await edgeFetch(
        `/api/admin/moderation/photos?page=${page}&page_size=20`,
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to load photos.");
      return j as ModPage<PhotoRowDto>;
    },
    staleTime: 30 * 1000,
  });

  async function hide(id: string) {
    setBusyId(id);
    try {
      const res = await edgeFetch(`/api/admin/moderation/photos/${id}/hide`, {
        method: "POST",
        json: {},
        silentGate: true,
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && j?.code === "STEP_UP_REQUIRED") {
        setPendingHide(id);
        setStepUpOpen(true);
        return;
      }
      if (!res.ok) throw new Error(j.error ?? "Failed to hide photo.");
      toast.success("Photo hidden.");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to hide photo.");
    } finally {
      setBusyId(null);
    }
  }

  async function unhide(id: string) {
    setBusyId(id);
    try {
      const res = await edgeFetch(`/api/admin/moderation/photos/${id}/unhide`, {
        method: "POST",
        json: {},
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to unhide photo.");
      toast.success("Photo restored.");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to unhide photo.");
    } finally {
      setBusyId(null);
    }
  }

  async function sendNotice() {
    if (!notifyTarget || !notifyMsg.trim()) return;
    setBusyId(notifyTarget.id);
    try {
      const res = await edgeFetch(`/api/admin/moderation/notify-owner`, {
        method: "POST",
        json: {
          content_type: "photo",
          content_id: notifyTarget.id,
          message: notifyMsg.trim(),
        },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to notify owner.");
      toast.success("Owner notified.");
      setNotifyTarget(null);
      setNotifyMsg("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to notify owner.");
    } finally {
      setBusyId(null);
    }
  }

  const rows = data?.rows ?? [];

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-56 w-full" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={CheckCircle2}
          title="No flagged photos"
          description="Item photos flagged by the fraud console or user reports will appear here for takedown review."
        />
      </Card>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {rows.map((row) => {
          const busy = busyId === row.id;
          return (
            <Card key={row.id} className="flex flex-col overflow-hidden">
              <div className="aspect-square w-full overflow-hidden border-b bg-muted">
                {row.previewUrl ? (
                  <img
                    src={row.previewUrl}
                    alt="Item photo"
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                    <EyeOff className="h-6 w-6" />
                    <span className="text-xs">Hidden</span>
                  </div>
                )}
              </div>
              <CardContent className="flex flex-1 flex-col gap-2 p-3">
                <div className="flex items-center justify-between gap-1">
                  <Badge variant="outline" className={SLATE}>
                    {row.photoType}
                  </Badge>
                  {row.isHidden && (
                    <Badge variant="outline" className={RED}>
                      Hidden
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  <OwnerLink owner={row.owner} />
                </p>
                {row.flag && (
                  <p className="line-clamp-2 text-xs text-destructive">
                    {row.flag.reason}
                  </p>
                )}
                <div className="mt-auto flex flex-wrap gap-1.5">
                  {row.isHidden ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => unhide(row.id)}
                    >
                      {busy ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Eye className="mr-1.5 h-4 w-4" />
                      )}
                      Unhide
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => hide(row.id)}
                    >
                      {busy ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <EyeOff className="mr-1.5 h-4 w-4" />
                      )}
                      Hide
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setNotifyTarget(row);
                      setNotifyMsg("");
                    }}
                  >
                    <Bell className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Pager
        page={data?.page ?? 1}
        totalPages={data?.totalPages ?? 1}
        onPage={setPage}
      />

      <NotifyDialog
        open={notifyTarget !== null}
        label="this photo"
        message={notifyMsg}
        onMessage={setNotifyMsg}
        busy={busyId !== null}
        onClose={() => setNotifyTarget(null)}
        onSend={sendNotice}
      />
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          const id = pendingHide;
          setPendingHide(null);
          if (id) void hide(id);
        }}
      />
    </>
  );
}

// Shared "notify owner" composer dialog.
function NotifyDialog({
  open,
  label,
  message,
  onMessage,
  busy,
  onClose,
  onSend,
}: {
  open: boolean;
  label: string;
  message: string;
  onMessage: (v: string) => void;
  busy: boolean;
  onClose: () => void;
  onSend: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Notify owner</DialogTitle>
          <DialogDescription>
            Send the owner of {label} an in-app moderation notice.
          </DialogDescription>
        </DialogHeader>
        <textarea
          aria-label="Moderation notice message"
          value={message}
          onChange={(e) => onMessage(e.target.value)}
          rows={4}
          placeholder="Explain why this content was flagged or removed…"
          className="w-full rounded-md border bg-background p-2 text-sm"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSend} disabled={busy || !message.trim()}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send notice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// US-2550: the buyer reports queue.
//
// A buyer who is told "do not trust this certificate" can now say so, and this
// is where that lands. Two things make it different from the other three tabs:
// there is no "recent" view (a certificate is immutable once issued, so the
// only triage-worthy set is what somebody reported), and the destructive action
// is NOT here — withholding a certificate means flagging its submission, which
// the Submissions tab already owns and already steps up for. What this tab
// gives an operator is the report, the evidence to judge it, and the two ways
// out: open the submission, or dismiss the report.
interface CertificateRowDto {
  certificateId: string;
  gradeReportId: string | null;
  submissionId: string | null;
  overallScore: number | null;
  gradeTier: string | null;
  issuedAt: string | null;
  title: string | null;
  brand: string | null;
  ownerUserId: string | null;
  owner: ModOwner | null;
  withheld: boolean;
  flag: ModFlag;
}

function CertificatesTab() {
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingWithhold, setPendingWithhold] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["admin-moderation-certificates", page],
    queryFn: async (): Promise<ModPage<CertificateRowDto>> => {
      const res = await edgeFetch(
        `/api/admin/moderation/certificates?page=${page}&page_size=20`,
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to load reported certificates.");
      return j as ModPage<CertificateRowDto>;
    },
    staleTime: 30 * 1000,
  });

  async function act(
    certificateId: string,
    action: "withhold" | "restore",
  ) {
    setBusyId(certificateId);
    try {
      const res = await edgeFetch(
        `/api/admin/moderation/certificates/${certificateId}/${action}`,
        { method: "POST", json: {}, silentGate: true },
      );
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && j?.code === "STEP_UP_REQUIRED") {
        setPendingWithhold(certificateId);
        setStepUpOpen(true);
        return;
      }
      if (!res.ok) throw new Error(j.error ?? "That did not work.");
      toast.success(
        action === "withhold"
          ? "Certificate withheld from the public page."
          : "Certificate restored.",
      );
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(certificateId: string) {
    setBusyId(certificateId);
    try {
      const res = await edgeFetch(
        `/api/admin/moderation/certificates/${certificateId}/dismiss`,
        { method: "POST", json: {} },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed to dismiss the report.");
      toast.success("Report dismissed.");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to dismiss the report.");
    } finally {
      setBusyId(null);
    }
  }

  // Error FIRST: react-query leaves data undefined on error, so a loading
  // guard placed above this one would always win and this branch would be dead.
  if (isError) {
    return (
      <Card>
        <ErrorState
          title="Couldn't load reported certificates"
          description="The moderation queue did not answer. This is usually temporary."
          onRetry={() => refetch()}
          retrying={isFetching}
        />
      </Card>
    );
  }
  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
    );
  }

  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={CheckCircle2}
          title="No reported certificates"
          description="When a buyer reports a certificate from its public page, it appears here."
        />
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {rows.map((row) => {
          const busy = busyId === row.certificateId;
          return (
            <Card key={row.certificateId}>
              <CardContent className="space-y-3 pt-6">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {row.title || "Untitled garment"}
                      {row.brand ? (
                        <span className="text-muted-foreground"> · {row.brand}</span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {row.overallScore != null
                        ? `${row.overallScore.toFixed(1)} · ${row.gradeTier ?? ""}`
                        : "Grade no longer on record"}
                      {" · "}
                      <OwnerLink owner={row.owner} />
                    </p>
                  </div>
                  {row.withheld && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
                      Already withheld
                    </span>
                  )}
                </div>

                <div className="rounded-md border bg-muted/40 p-2 text-sm">
                  {/* The count lives in the reason text: the queue keeps one
                      open flag per certificate, so five reporters are five
                      counts on one row, not five rows. */}
                  <p>{row.flag.reason}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.flag.source} · {new Date(row.flag.createdAt).toLocaleString()}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" asChild>
                    <a
                      href={`/cert/${row.certificateId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      See what the buyer saw
                    </a>
                  </Button>
                  {/* The real action, and its exact inverse. Withholding
                      writes to the SUBMISSION, because US-484 is what makes
                      a certificate 404 on every public path — there is no
                      second certificate-visibility flag, and adding one
                      would give the product two answers to one question. */}
                  {row.withheld ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !row.submissionId}
                      onClick={() => act(row.certificateId, "restore")}
                      aria-label={`Restore certificate ${row.certificateId}`}
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy || !row.submissionId}
                      onClick={() => act(row.certificateId, "withhold")}
                      aria-label={`Withhold certificate ${row.certificateId}`}
                    >
                      Withhold
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => dismiss(row.certificateId)}
                  >
                    {busy ? "Dismissing…" : "Dismiss report"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Pager
        page={data?.page ?? 1}
        totalPages={data?.totalPages ?? 1}
        onPage={setPage}
      />
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          const id = pendingWithhold;
          setPendingWithhold(null);
          if (id) void act(id, "withhold");
        }}
      />
    </>
  );
}

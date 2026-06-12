import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
} from "lucide-react";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { EmptyState } from "@/components/ui/empty-state";

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
  const red = "border-red-200 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300";
  const amber = "border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300";
  const slate = "border-slate-200 bg-slate-100 text-slate-700";

  if (auth?.manipulation_suspected) {
    types.push({ label: "Possible photo edit", cls: red });
  }
  if (auth?.screenshot_or_watermark_detected) {
    types.push({ label: "Screenshot / watermark", cls: amber });
  }
  if (notes["photo_reuse"] || reason.includes("match an image")) {
    types.push({ label: "Reused photo", cls: red });
  }
  if (reason.includes("clothing")) {
    types.push({ label: "May not be clothing", cls: slate });
  }
  if (types.length === 0) types.push({ label: "Flagged", cls: slate });
  return types;
}

export function AdminModerationPage() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<FlaggedSubmission | null>(null);
  // US-476: the ban endpoint requires a fresh MFA step-up; on a STEP_UP_REQUIRED
  // response we open this dialog and retry the pending ban after re-verification.
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingBan, setPendingBan] = useState<FlaggedSubmission | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-moderation"],
    queryFn: async (): Promise<FlaggedSubmission[]> => {
      const { data: subsRaw, error } = await supabase
        .from("submissions")
        .select("*")
        .eq("flagged", true)
        .is("moderation_status", null)
        .order("created_at", { ascending: false });
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
        .in("submission_id", submissionIds);
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
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-brand-red-text" />
        <div>
          <h1 className="text-2xl font-bold">Content Moderation</h1>
          <p className="text-sm text-muted-foreground">
            Submissions flagged for review — non-clothing images, suspected photo
            editing, screenshots/watermarks, or photos reused across accounts.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
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
                        <Badge
                          variant="outline"
                          className="border-red-200 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
                        >
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
                    >
                      <XCircle className="mr-1.5 h-4 w-4 text-destructive" />
                      Reject &amp; refund
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy || !entry.user || entry.user.suspended}
                      onClick={() => setBanTarget(entry)}
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
    </div>
  );
}

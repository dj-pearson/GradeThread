import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import type {
  SubmissionRow,
  UserRow,
  SubmissionImageRow,
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
} from "lucide-react";
import { toast } from "sonner";

interface FlaggedSubmission {
  submission: SubmissionRow;
  user: UserRow | null;
  images: { id: string; url: string }[];
}

export function AdminModerationPage() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<FlaggedSubmission | null>(null);

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
            .createSignedUrl(img.storage_path, 3600);
          if (urlData?.signedUrl) {
            signed.push({ id: img.id, url: urlData.signedUrl });
          }
        }
        result.push({
          submission,
          user: usersById.get(submission.user_id) ?? null,
          images: signed,
        });
      }
      return result;
    },
    staleTime: 30 * 1000,
  });

  async function handleApprove(entry: FlaggedSubmission) {
    setBusyId(entry.submission.id);
    try {
      const { error } = await supabase
        .from("submissions")
        .update({ flagged: false, moderation_status: "approved" } as never)
        .eq("id", entry.submission.id);
      if (error) throw error;
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
      const { error } = await supabase
        .from("submissions")
        .update({
          flagged: false,
          moderation_status: "rejected",
          status: "failed",
        } as never)
        .eq("id", entry.submission.id);
      if (error) throw error;

      if (entry.user) {
        const refunded = Math.max(0, entry.user.grades_used_this_month - 1);
        await supabase
          .from("users")
          .update({ grades_used_this_month: refunded } as never)
          .eq("id", entry.user.id);
      }
      toast.success("Submission rejected and the grade credit refunded.");
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
      const { error: banError } = await supabase
        .from("users")
        .update({ suspended: true } as never)
        .eq("id", entry.user.id);
      if (banError) throw banError;

      // Banning over a submission also rejects that submission.
      await supabase
        .from("submissions")
        .update({
          flagged: false,
          moderation_status: "rejected",
          status: "failed",
        } as never)
        .eq("id", entry.submission.id);

      toast.success("User suspended and submission rejected.");
      setBanTarget(null);
      await refetch();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to ban user."
      );
    } finally {
      setBusyId(null);
    }
  }

  const entries = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-brand-red" />
        <div>
          <h1 className="text-2xl font-bold">Content Moderation</h1>
          <p className="text-sm text-muted-foreground">
            Submissions flagged because their images may not depict clothing.
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
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-500/60" />
            <h3 className="mt-4 text-lg font-medium">Queue is clear</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              No submissions are currently awaiting moderation.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => {
            const busy = busyId === entry.submission.id;
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
                    {entry.user?.suspended && (
                      <Badge
                        variant="outline"
                        className="border-red-200 bg-red-100 text-red-800"
                      >
                        User suspended
                      </Badge>
                    )}
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
                        <CheckCircle2 className="mr-1.5 h-4 w-4 text-green-600" />
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
    </div>
  );
}

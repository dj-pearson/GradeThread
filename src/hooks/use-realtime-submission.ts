import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useWorkspace } from "@/hooks/use-workspace";
import { toast } from "sonner";
import type { SubmissionStatus } from "@/types/database";

interface SubmissionChange {
  id: string;
  status: SubmissionStatus;
  title: string;
}

/**
 * Subscribes to realtime status changes on the submissions table for the
 * active workspace. Filters by workspaceOwnerId so a member acting inside
 * an owner's workspace sees grade-complete toasts for the workspace's
 * submissions, not their personal ones. The subscription re-binds when the
 * user switches workspaces.
 */
export function useRealtimeSubmissions() {
  const { workspaceOwnerId } = useWorkspace();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workspaceOwnerId) return;

    const channel = supabase
      .channel(`submissions-realtime-${workspaceOwnerId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "submissions",
          filter: `user_id=eq.${workspaceOwnerId}`,
        },
        (payload) => {
          const row = payload.new as SubmissionChange;

          // Invalidate submission-related queries
          queryClient.invalidateQueries({ queryKey: ["submissions"] });
          queryClient.invalidateQueries({ queryKey: ["submission", row.id] });
          queryClient.invalidateQueries({ queryKey: ["recent-submissions"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });

          // Notify user on completion
          if (row.status === "completed") {
            toast.success("Grade Complete", {
              description: `Your grade for "${row.title}" is ready!`,
              action: {
                label: "View",
                onClick: () => {
                  window.location.href = `/dashboard/submissions/${row.id}`;
                },
              },
            });
          } else if (row.status === "failed") {
            toast.error("Grading Failed", {
              description: `Grading for "${row.title}" encountered an error.`,
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceOwnerId, queryClient]);
}

/**
 * Subscribes to realtime status changes for a single submission.
 * Use on the submission detail page.
 */
export function useRealtimeSubmission(
  submissionId: string | undefined,
  // US-1628: the detail page holds its submission in useState, not useQuery, so
  // invalidating ["submission", id] matched nothing and the "we'll let you know
  // the moment it's official" banner never resolved without a hard refresh. Pass
  // an onChange so the page can refetch its own state on a realtime UPDATE. The
  // key invalidation is kept for any useQuery consumers.
  onChange?: (row: SubmissionChange) => void,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!submissionId) return;

    const channel = supabase
      .channel(`submission-${submissionId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "submissions",
          filter: `id=eq.${submissionId}`,
        },
        (payload) => {
          queryClient.invalidateQueries({ queryKey: ["submission", submissionId] });
          onChange?.(payload.new as SubmissionChange);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [submissionId, queryClient, onChange]);
}

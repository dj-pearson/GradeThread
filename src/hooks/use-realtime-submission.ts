import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import type { SubmissionStatus } from "@/types/database";

interface SubmissionChange {
  id: string;
  status: SubmissionStatus;
  title: string;
}

/**
 * Subscribes to realtime status changes on the submissions table
 * for the current user. Shows a toast when a grade completes and
 * invalidates relevant queries so lists/detail views stay fresh.
 */
export function useRealtimeSubmissions() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel("submissions-realtime")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "submissions",
          filter: `user_id=eq.${user.id}`,
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
  }, [user?.id, queryClient]);
}

/**
 * Subscribes to realtime status changes for a single submission.
 * Use on the submission detail page.
 */
export function useRealtimeSubmission(submissionId: string | undefined) {
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
        () => {
          queryClient.invalidateQueries({ queryKey: ["submission", submissionId] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [submissionId, queryClient]);
}

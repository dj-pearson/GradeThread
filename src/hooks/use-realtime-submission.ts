import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
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
 * SUB-14: the last status a cached list page saw for this submission, if any.
 * Seeds the change check so the first realtime event for a row already known
 * to be completed does not read as the grade completing.
 */
function cachedStatus(queryClient: QueryClient, id: string): string | undefined {
  for (const [, data] of queryClient.getQueriesData<{
    submissions?: Array<{ id: string; status: string }>;
  }>({ queryKey: ["submissions"] })) {
    const hit = data?.submissions?.find((s) => s.id === id);
    if (hit) return hit.status;
  }
  return undefined;
}

/**
 * Decide whether an UPDATE is worth a toast. Every write to a completed row
 * (a Showcase toggle, a view count, a passport link) is an UPDATE with
 * status "completed", and each one used to toast "Grade Complete". Only a
 * status that differs from the last one seen is news, and a row seen for the
 * first time with no cached status is not assumed to have changed.
 */
export function statusChangeToast(
  previous: string | undefined,
  next: string,
): "completed" | "failed" | null {
  if (previous === undefined || previous === next) return null;
  if (next === "completed") return "completed";
  if (next === "failed") return "failed";
  return null;
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
  const navigate = useNavigate();
  const location = useLocation();
  // Read inside the handler without re-binding the channel on every route.
  const navRef = useRef({ navigate, pathname: location.pathname });
  useEffect(() => {
    navRef.current = { navigate, pathname: location.pathname };
  });
  const lastStatus = useRef(new Map<string, string>());

  useEffect(() => {
    if (!workspaceOwnerId) return;
    const seen = lastStatus.current;
    seen.clear();

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
          const previous = seen.get(row.id) ?? cachedStatus(queryClient, row.id);
          seen.set(row.id, row.status);
          const change = statusChangeToast(previous, row.status);
          const href = `/dashboard/submissions/${row.id}`;
          // The detail page shows the result itself; a toast there is noise.
          const onThatPage = navRef.current.pathname === href;

          // Invalidate submission-related queries. US-1633: the previous
          // ["recent-submissions"] / ["dashboard-stats"] keys were phantoms — no
          // query used them, so a grade completing never refreshed the
          // dashboard. The real key is ["dashboard-submissions", userId]
          // (prefix-matched here).
          queryClient.invalidateQueries({ queryKey: ["submissions"] });
          queryClient.invalidateQueries({ queryKey: ["submission", row.id] });
          queryClient.invalidateQueries({ queryKey: ["dashboard-submissions"] });

          // Notify on a real change of status only (SUB-14).
          if (!change || onThatPage) return;
          if (change === "completed") {
            toast.success("Grade Complete", {
              description: `Your grade for "${row.title}" is ready!`,
              action: {
                label: "View",
                onClick: () => navRef.current.navigate(href),
              },
            });
          } else {
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

  // Hold onChange in a ref so a non-memoized callback from a caller doesn't tear
  // down and resubscribe the Supabase realtime channel (a full unsubscribe /
  // resubscribe round-trip) on every render. The channel binds only to
  // submissionId; the latest callback is always read from the ref.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

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
          onChangeRef.current?.(payload.new as SubmissionChange);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [submissionId, queryClient]);
}

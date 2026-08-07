import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import type { SubmissionRow } from "@/types/database";

// US-1841: the walk-around grades a buyer requested against their closet items.
//
// Read direct from Supabase under the owner-read RLS on `submissions` — same
// pattern as useBuyerCloset. It exists so the portfolio can show a grade that is
// still RUNNING. Once a grade finishes, the result is written back onto the
// closet item itself (closet-grade-link.ts), so the finished state does not
// depend on this hook — which matters, because a buyer who closes the tab and
// comes back tomorrow should still see the grade on the item.

export type BuyerVideoGrade = Pick<
  SubmissionRow,
  "id" | "closet_item_id" | "status" | "created_at"
>;

/** Statuses that mean "we are still working on it" (show a pending affordance). */
const IN_FLIGHT = new Set(["pending", "processing"]);

export function useBuyerVideoGrades() {
  const { user } = useAuth();
  const userId = user?.id;

  const query = useQuery<BuyerVideoGrade[]>({
    queryKey: ["buyer-video-grades", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("id, closet_item_id, status, created_at")
        .eq("user_id", userId!)
        .not("closet_item_id", "is", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as BuyerVideoGrade[];
    },
    enabled: !!userId,
    staleTime: 30 * 1000,
  });

  const grades = query.data ?? [];
  // Newest first from the query, so the first hit per closet item is the latest.
  const latestByItem = new Map<string, BuyerVideoGrade>();
  for (const g of grades) {
    if (g.closet_item_id && !latestByItem.has(g.closet_item_id)) {
      latestByItem.set(g.closet_item_id, g);
    }
  }

  return {
    isLoading: query.isLoading,
    /** The most recent video grade requested for a closet item, if any. */
    gradeFor: (closetItemId: string) => latestByItem.get(closetItemId) ?? null,
    /** True while that item's latest grade is still being produced. */
    isPending: (closetItemId: string) => {
      const g = latestByItem.get(closetItemId);
      return g ? IN_FLIGHT.has(g.status) : false;
    },
  };
}

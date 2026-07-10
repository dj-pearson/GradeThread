import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import {
  type BuyerRewardsSummary,
  computeBuyerRewardsSummary,
} from "@/lib/buyer-rewards-summary";

// US-1814: buyer rewards surfaces — confirmation streak + lifetime impact
// (computed client-side from the buyer's own grade_outcomes under owner-read
// RLS) and the opt-in confirmer leaderboard (an edge feed, since ranking reads
// across buyers). Opt-in writes go through the edge (service-role users update).

export interface LeaderboardEntry {
  display_name: string;
  confirmations: number;
}

export interface LeaderboardMe {
  enabled: boolean;
  display_name: string | null;
}

export interface LeaderboardOptInInput {
  enabled?: boolean;
  display_name?: string | null;
}

export function useBuyerRewards() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;

  const summaryQuery = useQuery<BuyerRewardsSummary>({
    queryKey: ["buyer-rewards-summary", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("grade_outcomes")
        .select("match_status, created_at")
        .eq("buyer_user_id", userId!);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ match_status: string | null; created_at: string }>;
      const confirmedAt = rows.filter((r) => r.match_status === "confirmed").map((r) => r.created_at);
      const disputed = rows.filter((r) => r.match_status === "disputed").length;
      return computeBuyerRewardsSummary(confirmedAt, disputed, Date.now());
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const leaderboardKey = ["buyer-rewards-leaderboard", userId];
  const leaderboardQuery = useQuery<{ leaderboard: LeaderboardEntry[]; me: LeaderboardMe }>({
    queryKey: leaderboardKey,
    queryFn: async () => {
      const res = await edgeFetch("/api/buyer/rewards/leaderboard", { skipWorkspaceHeader: true });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't load the leaderboard.");
      return { leaderboard: json.leaderboard ?? [], me: json.me ?? { enabled: false, display_name: null } };
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const optInMutation = useMutation({
    mutationFn: async (input: LeaderboardOptInInput) => {
      const res = await edgeFetch("/api/buyer/rewards/leaderboard", {
        method: "POST",
        json: input,
        skipWorkspaceHeader: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't update your leaderboard settings.");
      return json.me as LeaderboardMe;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: leaderboardKey }),
  });

  return {
    summary: summaryQuery.data ?? null,
    leaderboard: leaderboardQuery.data?.leaderboard ?? [],
    myLeaderboard: leaderboardQuery.data?.me ?? null,
    setLeaderboardOptIn: (input: LeaderboardOptInInput) => optInMutation.mutateAsync(input),
    isUpdatingOptIn: optInMutation.isPending,
  };
}

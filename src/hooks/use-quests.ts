import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";

// US-1852: quests + community challenges.
//
// A SECOND read, deliberately not folded into `useRewards`. The quests endpoint
// evaluates progress and scans cross-user events for each challenge's standings,
// so the level card would otherwise sit behind a leaderboard. Personal, not
// workspace-scoped (`skipWorkspaceHeader`), matching the route.

export interface QuestProgress {
  current: number;
  target: number;
  complete: boolean;
  percent: number;
}

export interface Quest {
  id: string;
  key: string;
  name: string;
  description: string;
  quest_type: "personal" | "community";
  metric: string;
  target: number;
  cadence: "weekly" | "monthly" | "fixed";
  xp_reward: number;
  icon: string;
  period_key: string;
  window_ends_at: string;
  progress: QuestProgress;
  completed_at: string | null;
  xp_awarded: number;
}

export interface ChallengeStanding {
  rank: number;
  handle: string;
  display_name: string;
  score: number;
  is_you: boolean;
}

export interface Challenge extends Quest {
  standings: ChallengeStanding[];
  your_rank: number | null;
  you_are_listed: boolean;
}

export interface QuestsState {
  enabled: boolean;
  quests: Quest[];
  challenges: Challenge[];
  season_timezone: string;
}

const EMPTY: QuestsState = {
  enabled: false,
  quests: [],
  challenges: [],
  season_timezone: "UTC",
};

export function useQuests() {
  const { user } = useAuth();

  const query = useQuery<QuestsState>({
    queryKey: ["rewards-quests", user?.id],
    queryFn: async () => {
      const res = await edgeFetch("/api/rewards/quests", { skipWorkspaceHeader: true });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't load your quests.");
      return json as QuestsState;
    },
    enabled: !!user?.id,
    staleTime: 60 * 1000,
  });

  return {
    // A failed quests read degrades to "no quests" rather than breaking the
    // rewards page: the level and season cards are the ones that matter.
    quests: query.data ?? EMPTY,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

/** How the personal quests in the window that just closed turned out. */
export interface LastPeriodSummary {
  label: "week" | "month" | "round";
  done: number;
  total: number;
  xp: number;
}

/** "Last week: 3 of 4 done, +60 XP." */
export function lastPeriodLine(p: LastPeriodSummary): string {
  const label = p.label === "round" ? "Last round" : `Last ${p.label}`;
  const xp = p.xp > 0 ? `, +${p.xp.toLocaleString()} XP` : "";
  return `${label}: ${p.done} of ${p.total} done${xp}.`;
}

export interface QuestsState {
  enabled: boolean;
  quests: Quest[];
  challenges: Challenge[];
  season_timezone: string;
  /** Absent when no personal quest's window closed recently. */
  last_period?: LastPeriodSummary;
}

const EMPTY: QuestsState = {
  enabled: false,
  quests: [],
  challenges: [],
  season_timezone: "UTC",
};

/**
 * Ids of quests that finished between two reads, or whose completion is fresh
 * enough that THIS read is what paid it. Pure; exported for the unit test.
 *
 * GET /quests pays a finished quest on read, so the XP lands after /state may
 * already have been read: the level card showed the pre-quest total until
 * something else refetched it.
 */
export function newlyCompletedQuests(
  prev: QuestsState | null | undefined,
  next: QuestsState,
  sinceMs: number,
): string[] {
  const all = (s: QuestsState) => [...s.quests, ...s.challenges];
  const before = new Set(
    prev ? all(prev).filter((q) => q.completed_at).map((q) => `${q.key}:${q.period_key}`) : [],
  );
  const out: string[] = [];
  for (const q of all(next)) {
    if (!q.completed_at) continue;
    const id = `${q.key}:${q.period_key}`;
    if (before.has(id)) continue;
    const at = Date.parse(q.completed_at);
    // With no earlier read to compare against, only a completion from the last
    // minute counts: that one was paid by the read that just returned.
    if (!prev && !(Number.isFinite(at) && at >= sinceMs)) continue;
    out.push(id);
  }
  return out;
}

export function useQuests(opts: { enabled?: boolean } = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const previous = useRef<QuestsState | null>(null);

  const query = useQuery<QuestsState>({
    queryKey: ["rewards-quests", user?.id],
    queryFn: async () => {
      const res = await edgeFetch("/api/rewards/quests", { skipWorkspaceHeader: true });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't load your quests.");
      return json as QuestsState;
    },
    enabled: !!user?.id && opts.enabled !== false,
    staleTime: 60 * 1000,
  });

  // A quest that just finished was paid by that read, so the level card's read
  // is now stale. Refresh it once per newly finished quest.
  const data = query.data;
  useEffect(() => {
    if (!data) return;
    const fresh = newlyCompletedQuests(previous.current, data, Date.now() - 60_000);
    previous.current = data;
    if (fresh.length > 0) {
      void queryClient.invalidateQueries({ queryKey: ["rewards-state"] });
    }
  }, [data, queryClient]);

  return {
    // A failed quests read degrades to "no quests" rather than breaking the
    // rewards page: the level and season cards are the ones that matter.
    quests: query.data ?? EMPTY,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

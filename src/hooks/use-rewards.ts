import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";

// US-1851: the seller rewards surface — level + season + perks. One edge read
// (`GET /api/rewards/state`) because the level, the season track and the recaps
// all derive from the same ledger and would otherwise disagree with each other
// across three round-trips.
//
// Personal, not workspace-scoped: `skipWorkspaceHeader` matches the route, which
// scopes strictly by the authed user (a workspace member must not read the
// owner's XP).

export interface RewardTier {
  key: string;
  name: string;
  minLevel: number;
  blurb: string;
  icon: string;
}

export interface RewardLevel {
  level: number;
  xp_total: number;
  xp_peak: number;
  tier: RewardTier;
  next_tier: RewardTier | null;
  xp_into_level: number;
  xp_level_span: number;
  xp_to_next_level: number;
  percent_to_next_level: number;
  xp_to_next_tier: number | null;
}

export interface SeasonGoal {
  key: string;
  name: string;
  description: string;
  target: number;
  current: number;
  complete: boolean;
  percent: number;
  icon: string;
}

export interface RewardSeason {
  key: string;
  label: string;
  starts_at: string;
  ends_at: string;
  elapsed: number;
  xp_earned: number;
  goals: SeasonGoal[];
  goals_completed: number;
  goals_total: number;
}

export interface SeasonRecap {
  season_key: string;
  season_label: string;
  season_started_at: string;
  season_ended_at: string;
  xp_earned: number;
  goals_completed: number;
  goals_total: number;
  level_at_end: number;
  tier_at_end: string;
  highlights: {
    goals: Array<{ key: string; name: string; current: number; target: number; complete: boolean }>;
    honours: string[];
  };
}

export interface CosmeticPerk {
  key: string;
  kind: "flair" | "frame";
  name: string;
  description: string;
  tier: string;
  minLevel: number;
}

// US-1857: the badge shelf. `earned_at` null = a medal still to earn. Hidden
// badges only ever appear once earned, so the shelf never spoils a surprise.
export interface RewardBadge {
  key: string;
  name: string;
  description: string;
  tier: "bronze" | "silver" | "gold";
  icon: string;
  earned_at: string | null;
}

export interface RewardBadgeShelf {
  earned: RewardBadge[];
  upcoming: RewardBadge[];
  earned_count: number;
  total: number;
}

/** A tangible reward that has already landed. Nothing here is claimable — the
 *  grant happens automatically on crossing the milestone (US-1853). */
export interface MilestoneGrant {
  milestone_key: string;
  label: string;
  reward_type: string;
  reward_value: number;
  status: string;
  granted_at: string | null;
  expires_at: string | null;
}

export interface NextMilestone {
  key: string;
  label: string;
  reward_type: string;
  value: number;
  xp_threshold: number;
  xp_from: number;
  xp_remaining: number;
  percent: number;
}

export interface MilestoneProgress {
  enabled: boolean;
  granted: MilestoneGrant[];
  next: NextMilestone | null;
}

const EMPTY_BADGES: RewardBadgeShelf = {
  earned: [],
  upcoming: [],
  earned_count: 0,
  total: 0,
};

const EMPTY_MILESTONES: MilestoneProgress = { enabled: false, granted: [], next: null };

export interface RewardsState {
  level: RewardLevel;
  season: RewardSeason;
  recaps: SeasonRecap[];
  perks: { unlocked: CosmeticPerk[]; locked: CosmeticPerk[] };
  badges: RewardBadgeShelf;
  milestones: MilestoneProgress;
  season_timezone: string;
}

export function useRewards() {
  const { user } = useAuth();

  const query = useQuery<RewardsState>({
    queryKey: ["rewards-state", user?.id],
    queryFn: async () => {
      const res = await edgeFetch("/api/rewards/state", { skipWorkspaceHeader: true });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't load your rewards.");
      // An edge that predates US-1857 sends no badges/milestones block. Defaults
      // here rather than `?.` at forty call sites — the shelf renders empty, the
      // ladder renders as off, and nothing crashes mid-deploy.
      const state = json as RewardsState;
      return {
        ...state,
        badges: state.badges ?? EMPTY_BADGES,
        milestones: state.milestones ?? EMPTY_MILESTONES,
      };
    },
    enabled: !!user?.id,
    staleTime: 60 * 1000,
  });

  return {
    rewards: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

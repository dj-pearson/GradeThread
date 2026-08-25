import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1856: the public reward leaderboards.
//
// The boards themselves are ANONYMOUS — they read the same public payload the
// SSR Pages Function renders (Model B), so a signed-out visitor sees exactly
// what a crawler sees. Only the opt-in and the caller's own standing are
// authenticated.

export type LeaderboardMetricKey = "xp" | "grades" | "finds" | "shares";
export type LeaderboardPeriod = "weekly" | "all_time";

export interface LeaderboardMetric {
  key: LeaderboardMetricKey;
  name: string;
  description: string;
  scoreLabel: string;
  secondaryLabel: string | null;
  facetable: boolean;
  icon: string;
}

export interface LeaderboardEntry {
  rank: number;
  alias: string;
  handle: string | null;
  profile_url: string | null;
  score: number;
  secondary: number;
  tied: boolean;
}

export interface LeaderboardFacet {
  label: string;
  slug: string;
  count: number;
}

export interface LeaderboardWindow {
  period: LeaderboardPeriod;
  starts_at: string | null;
  ends_at: string | null;
}

export interface LeaderboardHubResponse {
  hub: true;
  metrics: LeaderboardMetric[];
  boards: Array<{ metric: LeaderboardMetric; path: string; entries: LeaderboardEntry[] }>;
  window: LeaderboardWindow;
  listed: number;
}

export interface LeaderboardBoardResponse {
  hub: false;
  metric: LeaderboardMetric;
  metrics: LeaderboardMetric[];
  window: LeaderboardWindow;
  path: string;
  filters: { brand_slug: string | null; category: string | null };
  facet_applied: boolean;
  facet_supported: boolean;
  truncated: boolean;
  total: number;
  entries: LeaderboardEntry[];
  facets: { brands: LeaderboardFacet[]; categories: LeaderboardFacet[] };
  listed: number;
}

export interface LeaderboardFilters {
  metric: LeaderboardMetricKey | null;
  period: LeaderboardPeriod;
  brandSlug?: string | null;
  category?: string | null;
  limit?: number;
}

function leaderboardQueryString(filters: LeaderboardFilters): string {
  const params = new URLSearchParams({ period: filters.period });
  if (filters.metric) params.set("metric", filters.metric);
  if (filters.brandSlug) params.set("brand_slug", filters.brandSlug);
  if (filters.category) params.set("category", filters.category);
  if (filters.limit) params.set("limit", String(filters.limit));
  return params.toString();
}

/** The public board(s). No auth — works signed out, which is the whole point. */
export function useLeaderboard<T extends LeaderboardHubResponse | LeaderboardBoardResponse>(
  filters: LeaderboardFilters,
) {
  const qs = leaderboardQueryString(filters);
  return useQuery({
    queryKey: ["leaderboards", qs],
    staleTime: 120_000,
    queryFn: async (): Promise<T> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/content/public/leaderboards.json?${qs}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error("Couldn't load the leaderboards");
      return (await res.json()) as T;
    },
  });
}

export interface MyStanding {
  metric: LeaderboardMetricKey;
  name: string;
  score_label: string;
  secondary_label: string | null;
  icon: string;
  path: string;
  /** null = a zero score this window: not on the board, NOT last. */
  rank: number | null;
  score: number;
  secondary: number;
  tied: boolean;
  of: number;
}

export interface MyLeaderboardState {
  opt_in: boolean;
  /** The alias the seller typed, or null when they lean on an existing one. */
  alias: string | null;
  /** What they would actually appear as, after the fallback chain. */
  resolved_alias: string | null;
  handle: string | null;
  period: LeaderboardPeriod;
  standings: MyStanding[];
  board_url: string;
}

/** The signed-in seller's opt-in state and where they currently stand. */
export function useMyLeaderboard(period: LeaderboardPeriod) {
  return useQuery({
    queryKey: ["my-leaderboard", period],
    staleTime: 60_000,
    queryFn: async (): Promise<MyLeaderboardState> => {
      const res = await edgeFetch(`/api/rewards/leaderboard?period=${period}`, {
        skipWorkspaceHeader: true,
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<MyLeaderboardState>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't load your standing");
      return {
        opt_in: data.opt_in === true,
        alias: data.alias ?? null,
        resolved_alias: data.resolved_alias ?? null,
        handle: data.handle ?? null,
        period: data.period ?? period,
        standings: data.standings ?? [],
        board_url: data.board_url ?? "/leaderboards",
      };
    },
  });
}

/** Join, leave, or rename on the public boards. */
export function useSetLeaderboardOptIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { enabled?: boolean; alias?: string | null }) => {
      const res = await edgeFetch("/api/rewards/leaderboard", {
        method: "PUT",
        skipWorkspaceHeader: true,
        json: {
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.alias === undefined ? {} : { alias: input.alias }),
        },
      });
      const data = (await res.json().catch(() => ({}))) as {
        opt_in?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Couldn't update your leaderboard settings");
      return { optIn: data.opt_in === true };
    },
    onSuccess: ({ optIn }) => {
      queryClient.invalidateQueries({ queryKey: ["my-leaderboard"] });
      queryClient.invalidateQueries({ queryKey: ["leaderboards"] });
      toast.success(optIn ? "You're on the leaderboards." : "Removed from the leaderboards.");
    },
    onError: (err: Error) => toastError(err),
  });
}

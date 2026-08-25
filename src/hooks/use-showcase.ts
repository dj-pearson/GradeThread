import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";

// US-1855: the public Showcase / "Finds" feed.
//
// The feed itself is ANONYMOUS — it reads the same public payload the SSR Pages
// Function renders (Model B), so a signed-out visitor sees exactly what a
// crawler sees. Only the write half (consent + reactions) is authenticated.

export interface PublicFind {
  id: string;
  certificate_id: string;
  certificate_url: string;
  image_url: string;
  title: string;
  brand: string | null;
  brand_slug: string | null;
  category: string | null;
  overall_score: number;
  grade_tier: string;
  value_cents: number | null;
  showcased_at: string;
  seller_handle: string | null;
  seller_display_name: string | null;
  seller_url: string | null;
  reactions: number;
}

export interface FindFacet {
  label: string;
  slug: string;
  count: number;
}

export interface ShowcaseLeader {
  handle: string;
  display_name: string;
  finds: number;
  reactions: number;
}

export type FindsSort = "trending" | "recent" | "top_graded";

export interface FindsFilters {
  sort: FindsSort;
  brandSlug: string | null;
  category: string | null;
  minGrade: number | null;
  limit?: number;
}

export interface FindsResponse {
  finds: PublicFind[];
  facets: { brands: FindFacet[]; categories: FindFacet[] };
  leaderboard: ShowcaseLeader[];
  total: number;
  sort: FindsSort;
}

function findsQueryString(filters: FindsFilters): string {
  const params = new URLSearchParams({ sort: filters.sort });
  if (filters.brandSlug) params.set("brand_slug", filters.brandSlug);
  if (filters.category) params.set("category", filters.category);
  if (filters.minGrade != null) params.set("min_grade", String(filters.minGrade));
  if (filters.limit) params.set("limit", String(filters.limit));
  return params.toString();
}

/** The public feed. No auth — works signed out, which is the whole point. */
export function useFinds(filters: FindsFilters) {
  const qs = findsQueryString(filters);
  return useQuery({
    queryKey: ["showcase_finds", qs],
    staleTime: 60_000,
    queryFn: async (): Promise<FindsResponse> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/content/public/finds.json?${qs}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error("Couldn't load the Finds feed");
      return (await res.json()) as FindsResponse;
    },
  });
}

/**
 * Which of these finds the SIGNED-IN caller has already reacted to.
 *
 * Kept separate from the feed on purpose: the feed is a public, edge-cacheable
 * document, so folding a per-viewer flag into it would make it uncacheable and
 * would leak one person's reactions into a shared cache entry.
 */
export function useMyReactions(findIds: string[]) {
  const user = useAuthStore((s) => s.user);
  const ids = findIds.slice(0, 100).join(",");
  return useQuery({
    queryKey: ["showcase_my_reactions", user?.id, ids],
    enabled: !!user && findIds.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Set<string>> => {
      const res = await edgeFetch(
        `/api/showcase/reactions?ids=${encodeURIComponent(ids)}`,
        { skipWorkspaceHeader: true },
      );
      if (!res.ok) throw new Error("Couldn't load your reactions");
      const data = (await res.json()) as { reacted: string[] };
      return new Set(data.reacted ?? []);
    },
  });
}

/** Toggle the caller's reaction on one find. */
export function useToggleReaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      findId: string,
    ): Promise<{ reacted: boolean; reactions: number }> => {
      const res = await edgeFetch(`/api/showcase/reactions/${findId}`, {
        method: "POST",
        skipWorkspaceHeader: true,
      });
      const data = (await res.json().catch(() => ({}))) as {
        reacted?: boolean;
        reactions?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save your reaction");
      return { reacted: data.reacted === true, reactions: data.reactions ?? 0 };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["showcase_finds"] });
      queryClient.invalidateQueries({ queryKey: ["showcase_my_reactions"] });
    },
    onError: (err: Error) => toastError(err),
  });
}

export interface ShowcaseConsent {
  opt_in: boolean;
  opted_in_at: string | null;
  value_cents: number | null;
}

/** Publish (or withdraw) ONE of the caller's own finds to the public feed. */
export function useSetShowcaseConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      submissionId: string;
      optIn: boolean;
      valueCents?: number | null;
    }): Promise<ShowcaseConsent> => {
      const res = await edgeFetch("/api/showcase/consent", {
        method: "PUT",
        skipWorkspaceHeader: true,
        json: {
          submission_id: input.submissionId,
          opt_in: input.optIn,
          value_cents: input.valueCents ?? null,
        },
      });
      const data = (await res.json().catch(() => ({}))) as {
        showcase?: ShowcaseConsent;
        error?: string;
      };
      if (!res.ok || !data.showcase) {
        throw new Error(data.error ?? "Couldn't update your Showcase setting");
      }
      return data.showcase;
    },
    onSuccess: (showcase) => {
      queryClient.invalidateQueries({ queryKey: ["submission"] });
      queryClient.invalidateQueries({ queryKey: ["showcase_finds"] });
      toast.success(
        showcase.opt_in
          ? "Added to the public Finds feed."
          : "Removed from the public Finds feed.",
      );
    },
    onError: (err: Error) => toastError(err),
  });
}

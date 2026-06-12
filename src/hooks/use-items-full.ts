import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type { ItemFullRow } from "@/types/database";

// `items_full` is the heaviest read in FlipDesk — the full denormalized
// inventory view. Half a dozen routes (pipeline, prep, item, overview,
// composer, reconciliation, eBay SKU match) all need the same rows, so they
// MUST share one query key AND one queryFn. Same key + divergent queryFns is a
// foot-gun in React Query: whichever consumer mounts first wins, and every
// other route silently inherits its ordering and freshness — which previously
// meant the page-level `.order(...)` and `staleTime` overrides were redundant
// and non-deterministic. This hook is the single source of truth; import it
// instead of re-declaring the query. All mutations already invalidate the
// `["items_full"]` prefix, so every consumer refreshes together.

// Canonical order: newest first. Consumers that need a different order
// (e.g. prep wants oldest-first) sort client-side off this one cached array.
// Deliberate cache tuning for a large payload (US-419):
//  - staleTime 15 min: mutations invalidate `["items_full"]` explicitly, so we
//    don't need aggressive background refetching to stay correct.
//  - gcTime 30 min: keep the big array warm across route hops (Pipeline ->
//    Composer -> Item etc.) so navigating back doesn't refetch the whole view.
export const ITEMS_FULL_STALE_TIME = 15 * 60 * 1000;
export const ITEMS_FULL_GC_TIME = 30 * 60 * 1000;

export function itemsFullQueryKey(userId: string | undefined) {
  return ["items_full", userId] as const;
}

export function useItemsFull() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: itemsFullQueryKey(user?.id),
    enabled: !!user,
    staleTime: ITEMS_FULL_STALE_TIME,
    gcTime: ITEMS_FULL_GC_TIME,
    queryFn: async (): Promise<ItemFullRow[]> => {
      const { data, error } = await (
        supabase.from as unknown as (
          name: "items_full",
        ) => {
          select: (cols: string) => {
            order: (
              col: string,
              opts?: { ascending?: boolean },
            ) => Promise<{ data: ItemFullRow[] | null; error: Error | null }>;
          };
        }
      )("items_full")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

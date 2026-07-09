import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { watchTargetKey } from "@/lib/watchlist";
import type { WatchlistItemInsert, WatchlistItemRow } from "@/types/database";

// US-1806: the buyer's watchlist — specific certificates / listings / passports
// they follow so a status or price change on THAT item can alert them (delivery
// is US-1809). Owner-managed straight to Supabase under RLS (owner-only); the
// alert engine reads via the service-role client scoped by user_id (US-268).
//
// This is the SINGLE client contract for the "Watch" action so the certificate
// page, a graded listing, and (later) the extension all write the same model.

type WatchTarget = {
  target_type: WatchlistItemRow["target_type"];
  target_id: string;
  label?: string | null;
  brand?: string | null;
};

export interface UseWatchlist {
  items: WatchlistItemRow[];
  isLoading: boolean;
  /** True when the given target is already on the buyer's watchlist. */
  isWatched: (target_type: WatchlistItemRow["target_type"], target_id: string) => boolean;
  /** Idempotent add (unique on user+target — a repeat is a no-op upsert). */
  watch: (target: WatchTarget) => Promise<void>;
  /** Remove a target from the watchlist. */
  unwatch: (target_type: WatchlistItemRow["target_type"], target_id: string) => Promise<void>;
  isMutating: boolean;
}

export function useWatchlist(): UseWatchlist {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const key = ["watchlist", userId];

  const query = useQuery<WatchlistItemRow[]>({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("watchlist_items")
        .select("*")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as WatchlistItemRow[];
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const watched = useMemo(() => {
    const set = new Set<string>();
    for (const it of query.data ?? []) set.add(watchTargetKey(it.target_type, it.target_id));
    return set;
  }, [query.data]);

  const watchMutation = useMutation({
    mutationFn: async (target: WatchTarget) => {
      const row: WatchlistItemInsert = {
        user_id: userId!,
        target_type: target.target_type,
        target_id: target.target_id,
        label: target.label ?? null,
        brand: target.brand ?? null,
      };
      // Idempotent: the unique index on (user, target) makes a repeat watch a
      // no-op rather than a duplicate row.
      const { error } = await supabase
        .from("watchlist_items")
        // `as never`: works around the tsc -b project-reference quirk where the
        // Insert type resolves to `never` (tsc --noEmit types it correctly).
        .upsert(row as never, { onConflict: "user_id,target_type,target_id" });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const unwatchMutation = useMutation({
    mutationFn: async (
      { target_type, target_id }: { target_type: WatchlistItemRow["target_type"]; target_id: string },
    ) => {
      const { error } = await supabase
        .from("watchlist_items")
        .delete()
        .eq("user_id", userId!)
        .eq("target_type", target_type)
        .eq("target_id", target_id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return {
    items: query.data ?? [],
    isLoading: query.isLoading,
    isWatched: (t, id) => watched.has(watchTargetKey(t, id)),
    watch: (target) => watchMutation.mutateAsync(target),
    unwatch: (t, id) => unwatchMutation.mutateAsync({ target_type: t, target_id: id }),
    isMutating: watchMutation.isPending || unwatchMutation.isPending,
  };
}

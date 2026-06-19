import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// Shared per-status item counts for the unified Inventory surface (US-958).
// Backed by the `inventory_status_counts` RPC (one grouped row per status),
// keyed under the items_full prefix so the existing
// invalidateQueries({ queryKey: ["items_full"] }) calls refresh it after any
// status change. Both the table (stage-tab badges) and the kanban (column
// badges) read from this single cached query instead of each recomputing the
// totals — so the counts agree across views and a view switch never recomputes
// or refetches them (15-min freshness shared via one cache entry).
export function useInventoryStatusCounts() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["items_full", "status_counts", user?.id],
    enabled: !!user,
    staleTime: 15 * 60 * 1000,
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: "inventory_status_counts",
        ) => Promise<{
          data: Record<string, number> | null;
          error: Error | null;
        }>
      )("inventory_status_counts");
      if (error) throw error;
      return data ?? {};
    },
  });
}

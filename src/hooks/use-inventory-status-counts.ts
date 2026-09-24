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
//
// INV-D1 (migration 00833): the counts are for ONE workspace, the one on
// screen. RLS admits every workspace the caller belongs to, so before this a
// seller who was also a member elsewhere got both workspaces' counts added
// together. The key names the owner so a workspace switch is a new entry.

export function inventoryStatusCountsKey(ownerId: string | undefined) {
  return ["items_full", "status_counts", ownerId] as const;
}

/** The RPC arguments. Null lets the server fall back to the caller's own rows. */
export function inventoryStatusCountsArgs(ownerId: string | undefined) {
  return { p_owner_id: ownerId || null };
}

export function useInventoryStatusCounts() {
  const user = useAuthStore((s) => s.user);
  const ownerId = useAuthStore((s) => s.activeWorkspaceOwnerId) ?? user?.id;
  return useQuery({
    queryKey: inventoryStatusCountsKey(ownerId),
    enabled: !!user && !!ownerId,
    staleTime: 15 * 60 * 1000,
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: "inventory_status_counts",
          args: { p_owner_id: string | null },
        ) => Promise<{
          data: Record<string, number> | null;
          error: Error | null;
        }>
      )("inventory_status_counts", inventoryStatusCountsArgs(ownerId));
      if (error) throw error;
      return data ?? {};
    },
  });
}

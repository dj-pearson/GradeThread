import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// US-3078 AC6: the one number that decides whether the consignor-payout widget
// is in the catalog at all.
//
// Modelled on use-inventory-item-count.ts, and for the same reason: normalize()
// has to answer "does this account run consignment" before it can drop a widget
// from the board, and it cannot call the consignment API to find out. An
// index-only head count (no rows transferred), keyed by user, shared by every
// caller through TanStack Query's cache.

export const CONSIGNOR_COUNT_KEY = "consignor-count";

export function consignorCountKey(userId: string | undefined) {
  return [CONSIGNOR_COUNT_KEY, userId] as const;
}

/**
 * How many consignors the signed-in account has, or undefined until the answer
 * is known.
 *
 * Undefined rather than 0 while loading, and undefined on failure, so the gate
 * fails towards KEEPING the widget. The two mistakes are not equal: showing a
 * consignor card to a seller who has no consignors is one card they hide once,
 * and hiding it from a consignment business because a head count blipped is a
 * feature they cannot find and do not know to look for.
 */
export function useConsignorCount(): number | undefined {
  const user = useAuthStore((s) => s.user);

  const { data } = useQuery({
    queryKey: consignorCountKey(user?.id),
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // RLS scopes consignors to the signed-in account.
      const { count, error } = await supabase
        .from("consignors")
        .select("id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });

  return data;
}

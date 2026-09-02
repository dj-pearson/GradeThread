import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// US-3075 AC5: the one number that decides whether the FlipDesk promo is on the
// board at all.
//
// It was an incidental result of the dashboard's listing-suggestions query
// before the board existed, which meant only that page could ask the question.
// normalize() has to ask it too now, so it lives here: an index-only head count
// (no rows transferred), keyed by user, shared by every caller through
// TanStack Query's cache.

export const INVENTORY_ITEM_COUNT_KEY = "inventory-item-count";

export function inventoryItemCountKey(userId: string | undefined) {
  return [INVENTORY_ITEM_COUNT_KEY, userId] as const;
}

/**
 * How many inventory_items the signed-in account has, or undefined until the
 * answer is known.
 *
 * Undefined rather than 0 while loading, and undefined on failure, so a caller
 * gating on "has any inventory" fails OPEN. Hiding the promo from a seller who
 * has none because a count errored is the wrong way round: showing it to
 * someone who already uses FlipDesk is a wasted card, hiding it from someone
 * who does not is a lost one.
 */
export function useInventoryItemCount(): number | undefined {
  const user = useAuthStore((s) => s.user);

  const { data } = useQuery({
    queryKey: inventoryItemCountKey(user?.id),
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // RLS scopes inventory_items to the signed-in account.
      const { count, error } = await supabase
        .from("inventory_items")
        .select("id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });

  return data;
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// Seller-level Promoted-Listings defaults (migration 00432). Promotion is off by
// default; a seller opts in here and a new/un-configured listing follows it,
// with a per-listing override still winning. Stored on the user's own row (RLS
// self-scoped; the columns aren't in the users protected-column guard, so the
// client can read + write them directly).
export interface SellerPromoDefaults {
  promote_listings_by_default: boolean;
  default_promo_rate_pct: number | null;
  default_promo_mode: string | null;
}

const OFF_BY_DEFAULT: SellerPromoDefaults = {
  promote_listings_by_default: false,
  default_promo_rate_pct: null,
  default_promo_mode: null,
};

export function useSellerPromoDefaults() {
  const userId = useAuthStore((s) => s.user?.id);
  return useQuery({
    queryKey: ["seller_promo_defaults", userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SellerPromoDefaults> => {
      const { data } = await supabase
        .from("users")
        .select(
          "promote_listings_by_default, default_promo_rate_pct, default_promo_mode",
        )
        .eq("id", userId!)
        .maybeSingle();
      const row = data as SellerPromoDefaults | null;
      return row ?? OFF_BY_DEFAULT;
    },
  });
}

export function useUpdateSellerPromoDefaults() {
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  return useMutation({
    mutationFn: async (patch: Partial<SellerPromoDefaults>): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");
      const { error } = await supabase
        .from("users")
        .update(patch as never)
        .eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["seller_promo_defaults", userId] });
    },
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type { ListingFormat } from "@/types/database";

// US-2852 / migration 00668: seller-level listing defaults — the starting
// position the composer uses for a NEW draft. Same shape and same storage as the
// Promoted-Listings defaults (00432, use-seller-promo-defaults.ts): columns on
// the user's own row, RLS self-scoped, not in the users protected-column guard,
// so the client reads and writes them directly.
//
// These SEED. They never re-apply. Once a listing row exists, its own columns
// own the value and changing a default here does not touch it.
export interface SellerListingDefaults {
  default_listing_format: ListingFormat | null;
  default_auction_duration: string | null;
  default_best_offer_enabled: boolean;
  default_best_offer_on_auction: boolean;
  default_best_offer_accept_pct: number | null;
  default_best_offer_decline_pct: number | null;
  default_listing_quantity: number | null;
}

export const SELLER_LISTING_DEFAULTS_KEY = "seller_listing_defaults";

const COLUMNS =
  "default_listing_format, default_auction_duration, default_best_offer_enabled, default_best_offer_on_auction, default_best_offer_accept_pct, default_best_offer_decline_pct, default_listing_quantity";

/** What a seller who has never touched Settings gets — today's hard-coded composer state. */
export const PLATFORM_LISTING_DEFAULTS: SellerListingDefaults = {
  default_listing_format: null,
  default_auction_duration: null,
  default_best_offer_enabled: false,
  default_best_offer_on_auction: false,
  default_best_offer_accept_pct: null,
  default_best_offer_decline_pct: null,
  default_listing_quantity: null,
};

export function useSellerListingDefaults() {
  const userId = useAuthStore((s) => s.user?.id);
  return useQuery({
    queryKey: [SELLER_LISTING_DEFAULTS_KEY, userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SellerListingDefaults> => {
      const { data } = await supabase
        .from("users")
        .select(COLUMNS)
        .eq("id", userId!)
        .maybeSingle();
      const row = data as SellerListingDefaults | null;
      return row ?? PLATFORM_LISTING_DEFAULTS;
    },
  });
}

export function useUpdateSellerListingDefaults() {
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  return useMutation({
    mutationFn: async (patch: Partial<SellerListingDefaults>): Promise<void> => {
      if (!userId) throw new Error("Not signed in.");
      const { error } = await supabase
        .from("users")
        .update(patch as never)
        .eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: [SELLER_LISTING_DEFAULTS_KEY, userId],
      });
    },
  });
}

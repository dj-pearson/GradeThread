import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import type { BuyerPreferencesRow, BuyerPreferencesUpdate } from "@/types/database";

// US-1797/1798: the buyer's shopping preferences — the SHARED input for
// condition-based alerts (US-1807), fit (US-1839), and any recommendation
// surface. This hook is the single client read/write contract so those features
// don't each invent their own:
//   • `preferences` is the row (or null before onboarding).
//   • `followed_brands` / `categories` / `sizes` are the interest signals.
//   • `price_min_cents` / `price_max_cents` / `condition_floor` bound matches.
//   • `notify_email` / `notify_push` are opt-ins (delivery infra is US-1803).
//   • `onboarding_completed_at` marks the onboarding flow done/skipped.
// Writes go straight to Supabase under RLS (owner-only); downstream EDGE reads
// use the service-role client scoped by user_id (US-268). Keep the field set
// stable — many features read it.

export interface UseBuyerPreferences {
  preferences: BuyerPreferencesRow | null;
  isLoading: boolean;
  /** Upsert a partial patch onto the buyer's single preferences row. */
  save: (patch: BuyerPreferencesUpdate) => Promise<BuyerPreferencesRow>;
  isSaving: boolean;
}

export function useBuyerPreferences(): UseBuyerPreferences {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;

  const query = useQuery<BuyerPreferencesRow | null>({
    queryKey: ["buyer-preferences", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("buyer_preferences")
        .select("*")
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: async (patch: BuyerPreferencesUpdate) => {
      const { data, error } = await supabase
        .from("buyer_preferences")
        .upsert({ user_id: userId!, ...patch }, { onConflict: "user_id" })
        .select("*")
        .single();
      if (error) throw error;
      return data as BuyerPreferencesRow;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["buyer-preferences", userId], data);
    },
  });

  return {
    preferences: query.data ?? null,
    isLoading: query.isLoading,
    save: (patch) => mutation.mutateAsync(patch),
    isSaving: mutation.isPending,
  };
}

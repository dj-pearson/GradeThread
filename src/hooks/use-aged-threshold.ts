import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  agedThresholdDays,
  DEFAULT_AGED_THRESHOLD_DAYS,
  MAX_AGED_THRESHOLD_DAYS,
  MIN_AGED_THRESHOLD_DAYS,
} from "@/lib/aged-inventory";

// US-3195: how long this seller considers too long, read once and shared.
//
// STORED RATHER THAN PER-SESSION. A definition of "aged" that resets every
// visit is one the seller re-types before they can act on it, and two visits
// could disagree about which items are on the list. The same shape as
// useListerLocales: RLS on flipdesk_settings scopes the row to the signed-in
// user (00134), so this reads Supabase directly rather than through an edge
// route.
//
// The query ALWAYS resolves to a usable number. A missing row, a null column or
// a value outside the column's own CHECK all fall back to the default, because
// a screen that cannot say what "aged" means is a screen with nothing on it.

const KEY = "aged_threshold";

export function useAgedThreshold() {
  const user = useAuthStore((s) => s.user);
  const query = useQuery({
    queryKey: [KEY, user?.id],
    enabled: !!user,
    // Config, not data. The mutation below invalidates it.
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select("aged_threshold_days")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      const stored = (data as { aged_threshold_days?: number | null } | null)
        ?.aged_threshold_days;
      return agedThresholdDays(stored);
    },
  });

  return {
    ...query,
    /** Never undefined: the default stands in until the read resolves. */
    days: query.data ?? DEFAULT_AGED_THRESHOLD_DAYS,
  };
}

export function useSetAgedThreshold() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (days: number) => {
      if (
        !Number.isFinite(days) ||
        days < MIN_AGED_THRESHOLD_DAYS ||
        days > MAX_AGED_THRESHOLD_DAYS
      ) {
        // Refused here rather than let the database CHECK reject it, so the
        // seller gets a sentence instead of a Postgres error string.
        throw new Error(
          `Pick a number of days between ${MIN_AGED_THRESHOLD_DAYS} and ${MAX_AGED_THRESHOLD_DAYS}.`,
        );
      }
      const { error } = await supabase
        .from("flipdesk_settings")
        .upsert(
          { user_id: user!.id, aged_threshold_days: Math.floor(days) } as never,
          { onConflict: "user_id" },
        );
      if (error) throw error;
      return Math.floor(days);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [KEY, user?.id] });
    },
  });
}

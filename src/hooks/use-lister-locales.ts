import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type { ListerLocaleMap } from "@/lib/lister-locales";

// US-2777: the seller's country domain per marketplace, read once and shared.
//
// One query key, so the picker on the Marketplaces page and every send site in
// the Listing Kit see the same answer and one invalidation updates them all —
// the same shape as useCrossPostChannels (US-2721).
//
// `null` means the seller has chosen nothing, which means every platform uses
// its default domain. That is the behaviour every account has today, so an
// empty answer must never read as an error or as a reason to block a send.
//
// RLS on flipdesk_settings scopes the row to the signed-in user (00134), so
// this reads Supabase directly rather than through an edge route.

export function useListerLocales() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["lister_locales", user?.id],
    enabled: !!user,
    // Config, not data. It changes when the seller changes it, and the write
    // invalidates this key.
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<ListerLocaleMap | null> => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select("lister_locales")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      const value = (data as { lister_locales?: ListerLocaleMap | null } | null)
        ?.lister_locales;
      return value ?? null;
    },
  });
}

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// US-2721: the seller's channel selection, read once and shared.
//
// One query key, so the picker on the Marketplaces page, the composer's push
// card and the Listing Kit all see the same answer and one invalidation
// updates all three.
//
// `null` means ALL — never none. See src/lib/cross-post-channels.ts for why
// both "never chose" and "unticked everything" have to read that way.
//
// RLS on flipdesk_settings scopes the row to the signed-in user (00134), so
// this reads Supabase directly rather than through an edge route, exactly as
// the auto_end_cross_listings toggle already does.

export function useCrossPostChannels() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["cross_post_channels", user?.id],
    enabled: !!user,
    // Config, not data. It changes when the seller changes it, and the write
    // invalidates this key.
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<string[] | null> => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select("cross_post_channels")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      const value = (data as { cross_post_channels?: string[] | null } | null)
        ?.cross_post_channels;
      return value ?? null;
    },
  });
}

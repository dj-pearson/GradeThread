import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export const OPEN_PHOTO_SESSIONS_KEY = "reconcile_open_sessions";

/**
 * How many photo-dump sessions are open for this workspace owner: photos synced
 * from the phone (or started on the web board) that are not sorted into items
 * yet. A head-only count, so no rows come back.
 */
export function useOpenPhotoSessions(ownerId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: [OPEN_PHOTO_SESSIONS_KEY, ownerId],
    enabled: enabled && !!ownerId,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from("flipdesk_reconcile_sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ownerId!)
        .eq("status", "open");
      if (error) throw error;
      return count ?? 0;
    },
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { isValidSellerHandle, type MarketplaceHandleMap } from "@/lib/delist-links";

// US-3369: the seller's own username per marketplace (migration 00790).
//
// Poshmark's "your active listings" page is /closet/{username}, so the link on
// every listed Poshmark listing, and the page the extension searches when it
// has no link to a listing, both need it. Same shape and same RLS path as
// useListerLocales: one row per user in flipdesk_settings, read directly.

export function marketplaceHandlesKey(userId: string | undefined) {
  return ["marketplace_handles", userId] as const;
}

export function useMarketplaceHandles() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: marketplaceHandlesKey(user?.id),
    enabled: !!user,
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<MarketplaceHandleMap> => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select("marketplace_handles")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      const raw = (data as { marketplace_handles?: unknown } | null)?.marketplace_handles;
      const out: MarketplaceHandleMap = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (isValidSellerHandle(v)) out[k] = v;
        }
      }
      return out;
    },
  });
}

/** Save (or, with null, forget) the seller's username on one platform. */
export function useSaveMarketplaceHandle() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  return useMutation<void, Error, { platform: string; handle: string | null }>({
    mutationFn: async ({ platform, handle }) => {
      if (!user) throw new Error("Sign in first.");
      if (handle !== null && !isValidSellerHandle(handle)) {
        throw new Error("That doesn't look like a username.");
      }
      // Read fresh rather than from the cache: an unloaded cache would read as
      // "no handles" and this write would wipe the other platforms'.
      const { data, error: readErr } = await supabase
        .from("flipdesk_settings")
        .select("marketplace_handles")
        .eq("user_id", user.id)
        .maybeSingle();
      if (readErr) throw readErr;
      const raw = (data as { marketplace_handles?: unknown } | null)?.marketplace_handles;
      const next: MarketplaceHandleMap =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? { ...(raw as MarketplaceHandleMap) }
          : {};
      if (handle === null) delete next[platform];
      else next[platform] = handle;
      const { error } = await supabase
        .from("flipdesk_settings")
        .upsert(
          { user_id: user.id, marketplace_handles: next } as never,
          { onConflict: "user_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: marketplaceHandlesKey(user?.id) });
      // The pending delists carry the handle for the extension's search.
      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
    },
  });
}

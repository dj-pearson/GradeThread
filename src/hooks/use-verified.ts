import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";

// GradeThread Verified — seller-profile management hooks. The profile is the
// individual seller's own account (not workspace-scoped), so every call skips
// the X-Workspace-Owner header.

export interface VerifiedProfile {
  handle: string | null;
  display_name: string | null;
  bio: string | null;
  enabled: boolean;
  verified_since: string | null;
  // Storefront opt-in: list active listings on the public profile.
  show_listings: boolean;
  // US-1126: opt-in to embed verified credentials in listing descriptions.
  embed_in_listings: boolean;
}

export interface VerifiedStats {
  total_graded: number;
  average_grade: number;
}

interface ProfileResponse {
  profile: VerifiedProfile;
  stats: VerifiedStats;
}

export interface VerifiedProfileUpdate {
  handle?: string;
  display_name?: string | null;
  bio?: string | null;
  enabled?: boolean;
  show_listings?: boolean;
  embed_in_listings?: boolean;
}

export function useVerifiedProfile() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["verified_profile", user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<ProfileResponse> => {
      const res = await edgeFetch("/api/verified/profile", {
        skipWorkspaceHeader: true,
      });
      if (!res.ok) throw new Error("Failed to load verified profile");
      return (await res.json()) as ProfileResponse;
    },
  });
}

export function useUpdateVerifiedProfile() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  return useMutation({
    mutationFn: async (update: VerifiedProfileUpdate): Promise<VerifiedProfile> => {
      const res = await edgeFetch("/api/verified/profile", {
        method: "PUT",
        skipWorkspaceHeader: true,
        json: update,
      });
      const data = (await res.json().catch(() => ({}))) as {
        profile?: VerifiedProfile;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to save profile");
      }
      return data.profile as VerifiedProfile;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["verified_profile", user?.id] });
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });
}

export interface BadgeFunnel {
  clicksBySource: Record<string, number>;
  /** US-1913: the same clicks split by badge FORMAT — plain vs status. */
  clicksByVariant?: { plain: number; status: number };
  totalClicks: number;
  conversions: number;
  windowDays: number;
}

/** US-1760: the caller's own badge funnel (clicks by source + referral conversions). */
export function useBadgeFunnel() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["verified_badge_funnel", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<BadgeFunnel> => {
      const res = await edgeFetch("/api/verified/badge-funnel", { skipWorkspaceHeader: true });
      if (!res.ok) throw new Error("Failed to load badge funnel");
      return (await res.json()) as BadgeFunnel;
    },
  });
}

/** One-shot handle availability check (not cached — used while typing/debounced). */
export async function checkHandleAvailable(
  handle: string,
): Promise<{ available: boolean; reason: string | null }> {
  const res = await edgeFetch(
    `/api/verified/handle-available?handle=${encodeURIComponent(handle)}`,
    { skipWorkspaceHeader: true },
  );
  const data = (await res.json().catch(() => ({}))) as {
    available?: boolean;
    reason?: string | null;
  };
  return { available: data.available ?? false, reason: data.reason ?? null };
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";

// US-1818: manage the buyer's own opt-in public Trust Score profile. Private by
// default; the buyer chooses a handle + which stats to expose. Reads/writes go
// through the edge (service-role users update) — never a client self-update.

export interface ProfileVisibility {
  level: boolean;
  confirmations: boolean;
  member_since: boolean;
}

export interface BuyerProfileSettings {
  handle: string | null;
  enabled: boolean;
  show: ProfileVisibility;
}

export interface UpdateProfileInput {
  enabled?: boolean;
  handle?: string | null;
  show?: Partial<ProfileVisibility>;
}

export function useBuyerProfile() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const key = ["buyer-profile", userId];

  const query = useQuery<BuyerProfileSettings>({
    queryKey: key,
    queryFn: async () => {
      const res = await edgeFetch("/api/buyer/profile", { skipWorkspaceHeader: true });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't load your profile.");
      return json as BuyerProfileSettings;
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: async (input: UpdateProfileInput) => {
      const res = await edgeFetch("/api/buyer/profile", {
        method: "POST",
        json: input,
        skipWorkspaceHeader: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't update your profile.");
      return json as BuyerProfileSettings;
    },
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });

  return {
    profile: query.data ?? null,
    isLoading: query.isLoading,
    updateProfile: (input: UpdateProfileInput) => mutation.mutateAsync(input),
    isUpdating: mutation.isPending,
  };
}

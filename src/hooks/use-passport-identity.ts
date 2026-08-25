import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";

// Garment Passport — opt-in identity reveal (US-1105). The caller manages reveal
// consent on their OWN passport hops. Like the Verified profile, this is a
// per-account surface (not workspace-scoped), so every call skips the workspace
// header. Pseudonymous is the default; revealing is per-hop and reversible.

export interface PassportIdentityNode {
  node_id: string;
  label: string;
  kind: string;
  revealed: boolean;
  revealed_at: string | null;
  // True only when consent AND a public Verified profile both hold right now.
  revealed_effective: boolean;
  passport_slug: string | null;
  sku_class: Record<string, unknown>;
}

interface NodesResponse {
  verified_profile_public: boolean;
  verified_handle: string | null;
  nodes: PassportIdentityNode[];
}

export function usePassportIdentityNodes() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["passport_identity_nodes", user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<NodesResponse> => {
      const res = await edgeFetch("/api/passport-identity/nodes", {
        skipWorkspaceHeader: true,
      });
      if (!res.ok) throw new Error("Failed to load your passport identities");
      return (await res.json()) as NodesResponse;
    },
  });
}

export function useSetPassportReveal() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  return useMutation({
    mutationFn: async (
      input: { nodeId: string; revealed: boolean },
    ): Promise<{ revealed: boolean; revealed_effective: boolean }> => {
      const res = await edgeFetch(
        `/api/passport-identity/nodes/${encodeURIComponent(input.nodeId)}/reveal`,
        {
          method: "POST",
          skipWorkspaceHeader: true,
          json: { revealed: input.revealed },
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        revealed?: boolean;
        revealed_effective?: boolean;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to update reveal setting");
      }
      return {
        revealed: data.revealed ?? input.revealed,
        revealed_effective: data.revealed_effective ?? false,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["passport_identity_nodes", user?.id],
      });
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });
}

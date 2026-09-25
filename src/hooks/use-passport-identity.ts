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

export interface NodesResponse {
  verified_profile_public: boolean;
  verified_handle: string | null;
  /** The garment lookup failed, so item names and passport links are missing. */
  garments_unavailable?: boolean;
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
    // Patched in place rather than refetched: one toggle used to reload every
    // hop. The optimistic flip is rolled back if the POST fails, and replaced
    // by what the server answered if it succeeds.
    onMutate: async (input) => {
      const key = ["passport_identity_nodes", user?.id];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<NodesResponse>(key);
      queryClient.setQueryData<NodesResponse>(key, (old) =>
        patchNode(old, input.nodeId, { revealed: input.revealed }),
      );
      return { previous };
    },
    onSuccess: (result, input) => {
      queryClient.setQueryData<NodesResponse>(
        ["passport_identity_nodes", user?.id],
        (old) => patchNode(old, input.nodeId, result),
      );
    },
    onError: (err: Error, input, context) => {
      queryClient.setQueryData<NodesResponse>(
        ["passport_identity_nodes", user?.id],
        (old) => {
          // Put back only this hop, so a concurrent toggle on another hop that
          // succeeded is not rolled back with it.
          const before = context?.previous?.nodes.find((n) => n.node_id === input.nodeId);
          return before ? patchNode(old, input.nodeId, before) : old;
        },
      );
      toastError(err);
    },
  });
}

/** Replace one hop's fields in a cached node list. Pure. */
export function patchNode(
  data: NodesResponse | undefined,
  nodeId: string,
  patch: Partial<PassportIdentityNode>,
): NodesResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    nodes: data.nodes.map((n) => (n.node_id === nodeId ? { ...n, ...patch } : n)),
  };
}

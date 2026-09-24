import { useAuthStore } from "@/stores/auth-store";

// US-1933: tenant partition for query keys: the active workspace owner, or the
// user for a solo account. A query keyed on this can never serve one tenant's
// cached rows after a workspace switch or a new sign-in on a shared browser,
// independent of the queryClient.clear() on switch.
//
// MP-04: moved out of use-ebay.ts so the Shopify, extension-queue, sold-sync
// and cross-channel hooks key on the same thing.
export function useTenantKey(): string | undefined {
  return useAuthStore((s) => s.activeWorkspaceOwnerId ?? s.user?.id);
}

/**
 * MP-06: true when the signed-in user is acting in their OWN workspace.
 *
 * flipdesk_settings is per-user and RLS lets a user write only their own row
 * (00134), while the edge reads the workspace OWNER's row. A member changing a
 * setting inside someone else's workspace was saving to a row nothing reads,
 * behind a success toast. Settings controls disable themselves when this is
 * false.
 */
export function useOwnsActiveWorkspace(): boolean {
  return useAuthStore(
    (s) => s.activeWorkspaceOwnerId == null || s.activeWorkspaceOwnerId === s.user?.id,
  );
}

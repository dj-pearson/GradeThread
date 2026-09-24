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

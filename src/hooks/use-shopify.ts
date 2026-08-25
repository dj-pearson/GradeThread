import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { supabase } from "@/lib/supabase";
import { getFreshAccessToken } from "@/lib/auth-token";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";

// Shopify connector hooks (US-599) — the first real non-eBay marketplace.
// Mirror use-ebay.ts: connection state is read straight from
// marketplace_connections via supabase-js (RLS-scoped), and the OAuth /
// disconnect / sync actions hit the edge endpoints.

export interface ShopifyConnection {
  id: string;
  account_handle: string | null;
  is_active: boolean;
  last_synced_at: string | null;
}

export function useShopifyConnection(pollingInterval?: number) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["shopify_connection", user?.id],
    enabled: !!user,
    staleTime: pollingInterval ? 0 : 60_000,
    refetchInterval: pollingInterval ?? false,
    queryFn: async (): Promise<ShopifyConnection | null> => {
      const { data, error } = await supabase
        .from("marketplace_connections")
        .select("id, account_handle, is_active, last_synced_at")
        .eq("marketplace", "shopify")
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as ShopifyConnection | null;
    },
  });
}

async function authHeader(): Promise<string> {
  // US-1634: getFreshAccessToken proactively refreshes a near/expired token, so
  // Shopify admin calls no longer send getSession()'s possibly-expired token.
  const token = await getFreshAccessToken();
  if (!token) {
    throw new Error("You must be signed in.");
  }
  return `Bearer ${token}`;
}

async function shopifyHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Authorization: await authHeader(),
    "Content-Type": "application/json",
  };
  const { activeWorkspaceOwnerId, user } = useAuthStore.getState();
  const ownerId = activeWorkspaceOwnerId ?? user?.id;
  if (ownerId) headers["X-Workspace-Owner"] = ownerId;
  return headers;
}

// Kicks off the OAuth dance: the user supplies their *.myshopify.com store
// handle, we GET /oauth/start?shop=…, then redirect to the returned consent URL.
export function useStartShopifyOauth() {
  return useMutation<void, Error, { shop: string; redirectTo?: string }>({
    mutationFn: async ({ shop, redirectTo }) => {
      const params = new URLSearchParams({ shop });
      if (redirectTo) params.set("redirect_to", redirectTo);
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/shopify/oauth/start?${params.toString()}`,
        { headers: await shopifyHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not start Shopify sign-in.");
      }
      if (!json.consent_url) {
        throw new Error("Server did not return a consent URL.");
      }
      window.location.href = json.consent_url as string;
    },
    onError: (err) => toastError(err),
  });
}

export function useDisconnectShopify() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/shopify/disconnect`, {
        method: "POST",
        headers: await shopifyHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not disconnect Shopify.");
      return json as { ok: true };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shopify_connection"] });
      toast.success("Disconnected Shopify.");
    },
    onError: (err) => toastError(err),
  });
}

export interface SyncShopifyResponse {
  ok: boolean;
  listings_synced: number;
  ended: number;
  sales_new: number;
  payouts_new: number;
  errors: string[];
}

// Syncs from Shopify: refreshes live-listing status (delisted/archived →
// ended) and ingests paid orders into sales + the Reconciliation queue.
export function useSyncShopify() {
  const qc = useQueryClient();
  return useMutation<SyncShopifyResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/shopify/listings/pull`,
        { method: "POST", headers: await shopifyHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Shopify sync failed.");
      return json as SyncShopifyResponse;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["items_full"] });
      qc.invalidateQueries({ queryKey: ["shopify_connection"] });
      const parts: string[] = [];
      if (data.sales_new > 0) parts.push(`${data.sales_new} new sale${data.sales_new === 1 ? "" : "s"}`);
      if (data.ended > 0) parts.push(`${data.ended} ended`);
      if (data.payouts_new > 0) parts.push(`${data.payouts_new} payout${data.payouts_new === 1 ? "" : "s"} to reconcile`);
      toast.success(
        `Shopify synced — ${data.listings_synced} listing${data.listings_synced === 1 ? "" : "s"} checked.`,
        { description: parts.length ? parts.join(" · ") : undefined },
      );
    },
    onError: (err) => toastError(err),
  });
}

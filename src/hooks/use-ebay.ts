import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";

// ── Connection state ────────────────────────────────────────────────

export interface EbayConnection {
  id: string;
  account_handle: string | null;
  token_expires_at: string | null;
  is_active: boolean;
  last_synced_at: string | null;
}

// Reads marketplace_connections directly via supabase-js so we don't need a
// dedicated edge endpoint just to answer "is this user connected?". RLS keeps
// it scoped to the current user.
export function useEbayConnection() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["ebay_connection", user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<EbayConnection | null> => {
      const { data, error } = await supabase
        .from("marketplace_connections")
        .select(
          "id, account_handle, token_expires_at, is_active, last_synced_at"
        )
        .eq("marketplace", "ebay")
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as EbayConnection | null;
    },
  });
}

async function authHeader(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("You must be signed in.");
  }
  return `Bearer ${session.access_token}`;
}

// Kicks off the OAuth dance: GETs /oauth/start, then assigns window.location
// to the returned consent URL. On return, eBay redirects to /oauth/callback,
// which on success bounces back to /dashboard/flipdesk/marketplaces?ebay=connected.
export function useStartEbayOauth() {
  return useMutation<void, Error, { redirectTo?: string } | void>({
    mutationFn: async (input) => {
      const params = new URLSearchParams();
      if (input && input.redirectTo) params.set("redirect_to", input.redirectTo);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/oauth/start${qs}`,
        { headers: { Authorization: await authHeader() } }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not start eBay sign-in.");
      }
      if (!json.consent_url) {
        throw new Error("Server did not return a consent URL.");
      }
      window.location.href = json.consent_url as string;
    },
    onError: (err) => toast.error(err.message),
  });
}

// ── Taxonomy ────────────────────────────────────────────────────────

export interface EbayCategorySuggestion {
  categoryId: string;
  categoryName: string;
  categoryTreePath: string;
}

// Live suggestions for a free-text query. We don't debounce here — the
// consumer (composer) controls the input frequency.
export function useEbayCategorySuggest(query: string) {
  return useQuery({
    queryKey: ["ebay_category_suggest", query],
    enabled: query.trim().length >= 2,
    staleTime: 60_000,
    queryFn: async (): Promise<EbayCategorySuggestion[]> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/category/suggest?q=${encodeURIComponent(
          query
        )}`,
        { headers: { Authorization: await authHeader() } }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Category lookup failed.");
      }
      return (json.suggestions ?? []) as EbayCategorySuggestion[];
    },
  });
}

// Aspect spec for a leaf category. eBay's shape is preserved verbatim under
// `aspects.aspects[]`. Cached server-side; safe to call eagerly.
export interface EbayAspectValue {
  localizedValue: string;
}
export interface EbayAspect {
  localizedAspectName: string;
  aspectConstraint: {
    aspectDataType?: string;
    aspectMode?: string;
    aspectRequired?: boolean;
    aspectUsage?: string; // "RECOMMENDED" | "OPTIONAL"
    expectedRequiredByDate?: string;
    itemToAspectCardinality?: string; // "SINGLE" | "MULTI"
  };
  aspectValues?: EbayAspectValue[];
}
export interface EbayAspectsResponse {
  aspects: { aspects?: EbayAspect[] };
  categoryName: string | null;
  cached: boolean;
}

export function useEbayCategoryAspects(categoryId: string | null) {
  return useQuery({
    queryKey: ["ebay_category_aspects", categoryId],
    enabled: !!categoryId,
    staleTime: 24 * 60 * 60_000,
    queryFn: async (): Promise<EbayAspectsResponse> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/category/${encodeURIComponent(
          categoryId!
        )}/aspects`,
        { headers: { Authorization: await authHeader() } }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Aspect lookup failed.");
      }
      return json as EbayAspectsResponse;
    },
  });
}

// ── Persistence ─────────────────────────────────────────────────────

// Saves the chosen eBay category + aspect values on the inventory item.
// Values are arrays so we can handle MULTI-cardinality aspects uniformly.
export function useSaveEbayCategoryMapping() {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { itemId: string; categoryId: string; aspects: Record<string, string[]> }
  >({
    mutationFn: async ({ itemId, categoryId, aspects }) => {
      const { error } = await supabase
        .from("inventory_items")
        .update({
          ebay_category_id: categoryId,
          ebay_aspects: aspects,
        } as never)
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["items_full"] });
      qc.invalidateQueries({ queryKey: ["inventory_item", vars.itemId] });
    },
    onError: (err) => toast.error(err.message),
  });
}

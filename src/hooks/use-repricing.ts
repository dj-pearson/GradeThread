import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";

// Condition-aware dynamic repricing — nudges feed + scan/apply/dismiss.

export type ReasonCode = "UNDERPRICED" | "OVERPRICED" | "STALE" | "OK" | "NO_COMPS";

export interface RepriceSuggestion {
  id: string;
  inventory_item_id: string;
  listing_id: string;
  current_price_cents: number;
  suggested_price_cents: number;
  comp_median_cents: number | null;
  comp_count: number;
  condition_id: string | null;
  reason_code: ReasonCode;
  message: string;
  confidence: number;
  status: string;
  updated_at: string;
  inventory_items: {
    title: string | null;
    brand: string | null;
    grade_value: number | null;
    grade_label: string | null;
  } | null;
  listings: {
    listing_status: string;
    listing_url: string | null;
  } | null;
}

export function useRepricingSuggestions() {
  return useQuery({
    queryKey: ["repricing_suggestions"],
    staleTime: 30_000,
    queryFn: async (): Promise<RepriceSuggestion[]> => {
      const res = await edgeFetch("/api/flipdesk/pricing/suggestions");
      if (!res.ok) throw new Error("Failed to load repricing suggestions");
      const data = (await res.json()) as { suggestions: RepriceSuggestion[] };
      return data.suggestions ?? [];
    },
  });
}

export function useScanRepricing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (limit?: number) => {
      const res = await edgeFetch("/api/flipdesk/pricing/scan", {
        method: "POST",
        json: limit ? { limit } : {},
      });
      const data = (await res.json().catch(() => ({}))) as {
        scanned?: number;
        actionable?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Scan failed");
      return data;
    },
    onSuccess: (r) => {
      toast.success(
        `Scanned ${r.scanned ?? 0} listing${r.scanned === 1 ? "" : "s"} — ${r.actionable ?? 0} repricing nudge${r.actionable === 1 ? "" : "s"}.`,
      );
      queryClient.invalidateQueries({ queryKey: ["repricing_suggestions"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useApplyReprice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/flipdesk/pricing/suggestions/${id}/apply`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        applied?: boolean;
        new_price?: number;
        ebay_synced?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to apply");
      return data;
    },
    onSuccess: (r) => {
      toast.success(
        `New price $${(r.new_price ?? 0).toFixed(2)} applied${r.ebay_synced ? " and pushed to eBay" : ""}.`,
      );
      queryClient.invalidateQueries({ queryKey: ["repricing_suggestions"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDismissReprice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(
        `/api/flipdesk/pricing/suggestions/${id}/dismiss`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to dismiss");
      }
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repricing_suggestions"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

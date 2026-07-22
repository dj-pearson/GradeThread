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

// US-565: post-publish performance feedback loop. One actionable suggestion per
// active listing that needs attention, derived from the engagement snapshot.
export type PerformanceSignalCode =
  | "NO_TRAFFIC"
  | "FEW_PHOTOS"
  | "LOW_CTR"
  | "WATCHED_NO_SALE";

export interface PerformanceSuggestion {
  listing_id: string;
  inventory_item_id: string;
  title: string;
  listing_url: string | null;
  code: PerformanceSignalCode;
  title_text: string;
  message: string;
  suggests_price_drop: boolean;
  suggests_best_offer: boolean;
  suggests_content_fix: boolean;
  // US-1899: 90+ days of total zero-engagement → a MANUAL "Sell Similar" last
  // resort may be worth it. A hint only; the UI gates it behind a confirmation.
  sell_similar_eligible: boolean;
}

export function usePerformanceSuggestions() {
  return useQuery({
    queryKey: ["performance_suggestions"],
    staleTime: 60_000,
    queryFn: async (): Promise<PerformanceSuggestion[]> => {
      const res = await edgeFetch("/api/flipdesk/pricing/performance");
      if (!res.ok) throw new Error("Failed to load performance suggestions");
      const data = (await res.json()) as { suggestions: PerformanceSuggestion[] };
      return data.suggestions ?? [];
    },
  });
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

// US-962: bulk match-to-comp reprice. Preview computes a per-listing suggested
// price off the repricing engine; apply pushes it (eBay where present + local),
// respecting the margin floor server-side.
export type BulkRepriceSkip = "no_comps" | "below_margin_floor";

export interface BulkRepricePreviewRow {
  listing_id: string;
  inventory_item_id: string;
  title: string;
  current_price_cents: number;
  suggested_price_cents: number;
  delta_cents: number;
  comp_count: number;
  comp_median_cents: number | null;
  reason_code: ReasonCode;
  margin_floor_cents: number | null;
  skip: BulkRepriceSkip | null;
}

export interface BulkRepricePreview {
  items: BulkRepricePreviewRow[];
  capped: boolean;
}

export interface BulkRepriceApplyResult {
  applied: number;
  ebay_synced: number;
  skipped: Array<{ listing_id: string; reason: BulkRepriceSkip | "not_found" }>;
  errors: Array<{ listing_id: string; message: string }>;
}

export function useBulkRepricePreview() {
  return useMutation({
    mutationFn: async (listingIds: string[]): Promise<BulkRepricePreview> => {
      const res = await edgeFetch("/api/flipdesk/pricing/reprice/preview", {
        method: "POST",
        json: { listingIds },
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<BulkRepricePreview>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't build the reprice preview.");
      return { items: data.items ?? [], capped: data.capped ?? false };
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useBulkRepriceApply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      items: Array<{ listing_id: string; price_cents: number }>,
    ): Promise<BulkRepriceApplyResult> => {
      const res = await edgeFetch("/api/flipdesk/pricing/reprice/apply", {
        method: "POST",
        json: { items },
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<BulkRepriceApplyResult>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't apply the new prices.");
      return {
        applied: data.applied ?? 0,
        ebay_synced: data.ebay_synced ?? 0,
        skipped: data.skipped ?? [],
        errors: data.errors ?? [],
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["items_full"] });
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

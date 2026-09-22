import { useMutation, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import type { CrossPushPlatform } from "@/lib/constants";

// Multi-marketplace cross-listing dispatch (US-149). One call fans the saved
// draft out into a listings row per platform; eBay publishes live, the rest
// come back 501 from their stub adapters (rows created, publish pending).

export interface CrossPushPlatformResult {
  ok: boolean;
  /**
   * US-3213: the work went to the desktop extension queue rather than to an
   * API. `ok` is true because the enqueue succeeded; it is NOT live yet, and
   * the composer says so instead of claiming a publish.
   */
  queued?: boolean;
  /**
   * US-3367: the channel was left alone: it is already live there, or a job
   * for it is already waiting on the desktop. `ok` is true and nothing changed.
   */
  skipped?: "already_live" | "already_queued";
  status?: number;
  error?: string;
  blockers?: string[];
  listing_row_id: string;
  platform_listing_id?: string;
  listing_url?: string;
  price: number;
}

export interface CrossPushResponse {
  ok: boolean;
  draft_id: string;
  results: Partial<Record<CrossPushPlatform, CrossPushPlatformResult>>;
}

export interface CrossPushInput {
  listingId: string;
  platforms: CrossPushPlatform[];
  prices?: Partial<Record<CrossPushPlatform, number>>;
}

export function useCrossPush() {
  const qc = useQueryClient();
  return useMutation<CrossPushResponse, Error, CrossPushInput>({
    mutationFn: async ({ listingId, platforms, prices }) => {
      const res = await edgeFetch("/api/flipdesk/listings/cross-push", {
        method: "POST",
        json: { listing_id: listingId, platforms, prices },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error || "Cross-listing push failed.",
        );
      }
      return json as CrossPushResponse;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["items_full"] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
      // Same staleness as the eBay push: a cross-push writes listings rows, and
      // the composer decides publish-vs-resubmit from the one it has cached.
      void qc.invalidateQueries({ queryKey: ["listing"] });
    },
  });
}

// US-3456: N items, M channels, one request. eBay goes to the publish batch
// the page already has (useBulkPublish); this takes the rest.
export type BulkCrossPushOutcome =
  | "published"
  | "queued"
  | "already_live"
  | "already_queued"
  | "no_source"
  | "not_found"
  | "blocked";

export interface BulkCrossPushRow {
  item_id: string;
  platform: CrossPushPlatform;
  outcome: BulkCrossPushOutcome;
  listing_row_id: string | null;
  listing_url: string | null;
  error: string | null;
}

export interface BulkCrossPushSummary {
  rows: number;
  published: number;
  queued: number;
  skipped: number;
  noSource: number;
  notFound: number;
  blocked: number;
}

export interface BulkCrossPushResponse {
  ok: boolean;
  batch_label: string | null;
  dropped_items: number;
  summary: BulkCrossPushSummary;
  rows: BulkCrossPushRow[];
}

export interface BulkCrossPushInput {
  itemIds: string[];
  platforms: CrossPushPlatform[];
  prices?: Partial<Record<CrossPushPlatform, number>>;
  batchLabel?: string | null;
}

export function useCrossPushBulk() {
  const qc = useQueryClient();
  return useMutation<BulkCrossPushResponse, Error, BulkCrossPushInput>({
    mutationFn: async ({ itemIds, platforms, prices, batchLabel }) => {
      const res = await edgeFetch("/api/flipdesk/listings/cross-push-bulk", {
        method: "POST",
        json: { item_ids: itemIds, platforms, prices, batch_label: batchLabel ?? null },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((json as { error?: string }).error || "Bulk cross-listing failed.");
      }
      return json as BulkCrossPushResponse;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["items_full"] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
      void qc.invalidateQueries({ queryKey: ["listing"] });
    },
  });
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import type { CrossListingPlatform } from "@/lib/constants";

// Multi-marketplace cross-listing dispatch (US-149). One call fans the saved
// draft out into a listings row per platform; eBay publishes live, the rest
// come back 501 from their stub adapters (rows created, publish pending).

export interface CrossPushPlatformResult {
  ok: boolean;
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
  results: Partial<Record<CrossListingPlatform, CrossPushPlatformResult>>;
}

export interface CrossPushInput {
  listingId: string;
  platforms: CrossListingPlatform[];
  prices?: Partial<Record<CrossListingPlatform, number>>;
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
    },
  });
}

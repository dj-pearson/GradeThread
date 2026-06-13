import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  isListerAvailable,
  isListerPlatform,
  sendDelistToLister,
} from "@/lib/lister-extension";

// US-717: the cross-listing auto-delist queue for extension marketplaces.
//
// When a cross-listed item sells, the edge auto-ends its siblings. API
// marketplaces (eBay/Shopify/Depop) are delisted server-side; the extension
// marketplaces (Poshmark/Mercari/Grailed) have no write API, so the edge can
// only QUEUE the delist (listings.delist_requested_at). This hook reads that
// queue and, when the GradeThread Lister extension is available, ends each
// listing in the seller's OWN tab and confirms back to clear the stamp.

export interface PendingDelist {
  listing_id: string;
  platform: string;
  listing_url: string | null;
  item_id: string;
  item_title: string | null;
  requested_at: string;
}

export function usePendingDelists(enabled = true) {
  return useQuery({
    queryKey: ["pending_delists"],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<PendingDelist[]> => {
      const res = await edgeFetch("/api/flipdesk/listings/pending-delists");
      if (!res.ok) throw new Error("Could not load pending delists.");
      const json = (await res.json()) as { pending?: PendingDelist[] };
      return json.pending ?? [];
    },
  });
}

export interface RunDelistResult {
  ok: boolean;
  manual?: boolean;
  error?: string;
}

// Run one queued extension delist: hand the live listing URL to the extension,
// then clear the queue stamp once it (or the seller) ended it. Returns a manual
// flag when the extension degraded so the caller can tell the seller to end it
// by hand — in which case we still clear the local stamp (the sibling is already
// marked ended; the queue only tracks the marketplace-side action).
export function useRunDelist() {
  const qc = useQueryClient();
  return useMutation<RunDelistResult, Error, PendingDelist>({
    mutationFn: async (item) => {
      if (!isListerPlatform(item.platform)) {
        return { ok: false, error: `${item.platform} isn't an extension platform.` };
      }
      if (!item.listing_url) {
        return {
          ok: false,
          manual: true,
          error: "No saved listing URL — end this listing manually on the marketplace.",
        };
      }
      if (!isListerAvailable()) {
        return {
          ok: false,
          manual: true,
          error: "Install the GradeThread Lister extension to auto-end, or end it manually.",
        };
      }

      const res = await sendDelistToLister({
        platform: item.platform,
        platformLabel: item.platform,
        listingId: item.listing_id,
        listingUrl: item.listing_url,
      });

      // Whether the extension ended it or degraded to manual, clear the queue
      // stamp so it stops nagging (the row is already marked ended locally).
      const confirm = await edgeFetch("/api/flipdesk/listings/delist-confirm", {
        method: "POST",
        json: { listing_id: item.listing_id },
      });
      if (!confirm.ok) {
        const j = await confirm.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? "Could not clear the delist.");
      }
      return { ok: res.ok, manual: res.manual, error: res.error };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
    },
  });
}

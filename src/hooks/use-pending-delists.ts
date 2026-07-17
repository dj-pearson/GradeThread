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
  /** US-1877 (AC3): 'draft' = we never confirmed this prefill went live. */
  listing_status?: string | null;
  /** US-1877 (AC3): confirmed-active AND has a live URL — the only rows the
   *  extension can actually end. Everything else degrades to the manual path. */
  auto_delistable?: boolean;
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
      // US-1877 (AC3): auto-delist requires a CONFIRMED-live listing with a URL.
      // Two distinct reasons to degrade, and they need different copy — telling a
      // seller "no saved URL" for a listing that was never published sends them
      // hunting for something that may not exist.
      if (item.listing_status === "draft") {
        return {
          ok: false,
          manual: true,
          error:
            "GradeThread only prefilled this listing and never confirmed it went live. " +
            "Check the marketplace — if you did publish it, end it there.",
        };
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

      // US-1629: clear the queue stamp ONLY on a real success. Previously this
      // fired unconditionally — so a hard failure (res.ok === false: the
      // extension couldn't end the listing) still dropped the row off the queue
      // while the cross-listing was STILL LIVE, risking a double sale. On a hard
      // failure we leave the stamp so it's retryable; a manual degrade
      // (res.manual) also keeps the stamp — the seller clears it via
      // useMarkDelistDone once they've ended it by hand.
      if (res.ok) {
        const confirm = await edgeFetch("/api/flipdesk/listings/delist-confirm", {
          method: "POST",
          json: { listing_id: item.listing_id },
        });
        if (!confirm.ok) {
          const j = await confirm.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error ?? "Could not clear the delist.");
        }
      }
      return { ok: res.ok, manual: res.manual, error: res.error };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
    },
  });
}

// US-1629: explicit "I ended this listing myself" — clears the queue stamp for a
// manual path (degraded extension, no saved URL, or a non-extension platform) so
// it stops nagging. Distinct from useRunDelist, which only auto-clears on a real
// extension success and never on a hard failure (which would risk a double sale).
export function useMarkDelistDone() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (listingId) => {
      const res = await edgeFetch("/api/flipdesk/listings/delist-confirm", {
        method: "POST",
        json: { listing_id: listingId },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? "Could not clear the delist.");
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
    },
  });
}

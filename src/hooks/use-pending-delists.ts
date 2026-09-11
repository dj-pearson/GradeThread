import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  isListerAvailable,
  isListerPlatform,
  requestDrainNow,
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
  /** US-3369: the extension has a way to reach it: a saved link, or a platform
   *  whose active-listings page it can search. Everything else is by hand. */
  auto_delistable?: boolean;
  item_id: string;
  item_title: string | null;
  requested_at: string;
  /** US-3369: what the extension searches the active-listings page for. */
  match_titles?: string[];
  /** US-3369: the seller's username on this platform, when saved. */
  seller_handle?: string | null;
}

/** US-3369: one item's pending delists, for its Delist panel. */
export function useItemPendingDelists(itemId: string | undefined) {
  return useQuery({
    queryKey: ["pending_delists", "item", itemId],
    enabled: Boolean(itemId),
    staleTime: 30 * 1000,
    queryFn: async (): Promise<PendingDelist[]> => {
      const res = await edgeFetch(
        `/api/flipdesk/listings/pending-delists?item=${encodeURIComponent(itemId!)}`,
      );
      if (!res.ok) throw new Error("Could not load this item's delists.");
      const json = (await res.json()) as { pending?: PendingDelist[] };
      return json.pending ?? [];
    },
  });
}

export function usePendingDelists(enabled = true) {
  const query = useQuery({
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

  useDrainNudge(query.data);
  return query;
}

/**
 * US-3143: should this pending-delists result nudge the extension to drain?
 *
 * ON THE TRANSITION, not on the state. The rule is 0-or-unloaded → at least one
 * row. While the count stays above zero nothing further is sent, and the latch
 * only re-arms once the queue empties. A rule written as "there is work" would
 * fire on every refetch, remount and window focus, at a queue the extension is
 * already draining.
 *
 * `pendingCount` is null while the query has not resolved. Not the same as
 * zero: an unloaded query must neither send nor clear the latch, or the first
 * render after a refetch begins would re-arm it and the next result would send
 * again for work already nudged.
 *
 * Pure, and exported, because that is where the whole rule lives — there is no
 * @testing-library/react in this repo, and a rule tested only through a
 * source-scan is a rule nobody has actually run.
 */
export function planDrainNudge(
  pendingCount: number | null,
  alreadyNudged: boolean,
): { send: boolean; nudged: boolean } {
  if (pendingCount === null) return { send: false, nudged: alreadyNudged };
  if (pendingCount === 0) return { send: false, nudged: false };
  if (alreadyNudged) return { send: false, nudged: true };
  return { send: true, nudged: true };
}

/**
 * Tell the extension to run its queue when work newly appears.
 *
 * The module-level floor inside requestDrainNow is what makes several mounted
 * copies of this hook safe: each keeps its own latch and each will try once,
 * and only the first inside the window actually leaves the page.
 *
 * Fire-and-forget on purpose. Nothing reads the answer, because there is no
 * answer a seller should be shown: every refusal the extension can give (not
 * installed, lapsed plan, terms not accepted, already draining) leaves the
 * 5-minute alarm doing exactly what it does today.
 */
function useDrainNudge(pending: PendingDelist[] | undefined): void {
  const nudged = useRef(false);
  useEffect(() => {
    const plan = planDrainNudge(pending ? pending.length : null, nudged.current);
    nudged.current = plan.nudged;
    if (plan.send) void requestDrainNow();
  }, [pending]);
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
/**
 * Run ONE queued extension delist in this browser and, only on a verified end,
 * clear its stamp. Shared by the per-row "End listing" button and the item's
 * "Delist from other platforms" button, so both answer the same way.
 */
export async function runOneDelist(item: PendingDelist): Promise<RunDelistResult> {
  if (!isListerPlatform(item.platform)) {
    return { ok: false, error: `${item.platform} isn't an extension platform.` };
  }
  // US-3369: the old gates here refused every row without a URL and every
  // draft. With the extension able to search the seller's active listings,
  // the only row it cannot reach is one with no link on a platform it cannot
  // search (Vinted today). `auto_delistable` is the server's answer to exactly
  // that, computed once in pending-delists.ts for every surface.
  if (!item.listing_url && item.auto_delistable === false) {
    return {
      ok: false,
      manual: true,
      error:
        "GradeThread has no link to this listing and can't search this marketplace " +
        "for it. End it there yourself.",
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
    matchTitles: item.match_titles ?? (item.item_title ? [item.item_title] : []),
    sellerHandle: item.seller_handle ?? null,
  });

  // US-1629: clear the queue stamp ONLY on a real success. Previously this
  // fired unconditionally — so a hard failure (res.ok === false: the extension
  // couldn't end the listing) still dropped the row off the queue while the
  // cross-listing was STILL LIVE, risking a double sale. On a hard failure we
  // leave the stamp so it's retryable; a manual degrade (res.manual) also keeps
  // the stamp — the seller clears it via useMarkDelistDone once they've ended
  // it by hand.
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
}

export function useRunDelist() {
  const qc = useQueryClient();
  return useMutation<RunDelistResult, Error, PendingDelist>({
    mutationFn: runOneDelist,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
      void qc.invalidateQueries({ queryKey: ["item_listings"] });
    },
  });
}

export interface EndOtherListingsResult {
  summary: { ended: number; queued: number; unresolved: number; nothingLive: number };
  pending: PendingDelist[];
}

/**
 * US-3369: the item sold; end its other listings. eBay, Shopify, Depop and
 * Etsy end on the server. The extension listings come back in `pending` for
 * this browser to run. `mode: "auto"` honours the seller's auto-end switch
 * (Record sale); `"explicit"` is the Delist button and does not.
 */
export function useEndOtherListings() {
  const qc = useQueryClient();
  return useMutation<
    EndOtherListingsResult,
    Error,
    { itemId: string; soldListingId?: string | null; mode: "auto" | "explicit" }
  >({
    mutationFn: async ({ itemId, soldListingId, mode }) => {
      const res = await edgeFetch("/api/flipdesk/listings/end-other-listings", {
        method: "POST",
        json: { item_id: itemId, sold_listing_id: soldListingId ?? null, mode },
      });
      const j = (await res.json().catch(() => ({}))) as Partial<EndOtherListingsResult> & {
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? "Could not end the other listings.");
      return {
        summary: j.summary ?? { ended: 0, queued: 0, unresolved: 0, nothingLive: 0 },
        pending: j.pending ?? [],
      };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
      void qc.invalidateQueries({ queryKey: ["item_listings"] });
      void qc.invalidateQueries({ queryKey: ["items_full"] });
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

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useWorkspace } from "@/hooks/use-workspace";

// US-2174: refresh the inventory/listings views when a listing's state changes
// on a MARKETPLACE, rather than waiting for a staleness window to expire.
//
// The listings table caches items_full for 15 minutes, justified (US-735) by
// "mutations invalidate items_full explicitly". That reasoning holds only for
// changes WE make. A sale on eBay is not a local mutation: nothing invalidates
// anything, so a sold listing could keep showing as Active for a quarter of an
// hour — long enough for a seller to reprice or relist something already gone.
//
// WHY NOT SUBSCRIBE TO `listings` DIRECTLY: only `notifications` is in the
// supabase_realtime publication (00007). Adding `listings` to it is a migration,
// and a listings-wide realtime feed would also push every column change of every
// row to every connected seller. The notification is a much smaller signal that
// already fires for exactly the events we care about — so we listen for the
// SIGNAL, not the data, and let the normal queries refetch.
//
// Piggybacking on the notifications channel does mean this only fires for events
// that notify. That is the honest limit of the approach, and it covers the ones
// that matter: a sale, a listing going live, a status change, a stockout.

/**
 * Notification types that mean "a listing's state may have changed underneath
 * the cached inventory views".
 *
 * Deliberately NOT every type. A grading or billing notification changes
 * nothing about listing state, and invalidating the tenant's whole inventory
 * cache on each one would undo the caching this is meant to keep.
 *
 * WHAT ACTUALLY FIRES TODAY — checked, not assumed:
 *
 *   • `low_stock` is the ONLY live signal. inventory-monitor's notifyStockLevel
 *     runs during the eBay sync pull as quantities cross DOWN, so a
 *     one-of-a-kind garment selling goes quantity 1 → 0 → stockout → notify.
 *     That is precisely the case this story is about, and it lands at the same
 *     moment the synced listing data does.
 *
 *   • `sale_recorded`, `listing_live`, `item_status_change` and
 *     `return_requested` are declared in the edge's NotificationType union but
 *     NOTHING EMITS THEM as notifications. `sale_recorded` in particular is
 *     emitted via emitEvent(), which writes to `user_events` — a different
 *     table that is not in the supabase_realtime publication and never reaches
 *     this subscription.
 *
 * They are kept in the set anyway so that wiring any of them up later needs no
 * change here — but the comment above is the honest state, and a reader must
 * not infer coverage this hook does not have. If the low_stock path is ever
 * removed, this hook becomes a no-op and should be deleted with it.
 */
const LISTING_STATE_TYPES: ReadonlySet<string> = new Set([
  // Live today.
  "low_stock",
  // Declared but unemitted — see above.
  "sale_recorded",
  "listing_live",
  "item_status_change",
  "return_requested",
]);

interface NotificationRow {
  type?: string | null;
}

/**
 * Subscribes to the workspace owner's notifications and invalidates the
 * inventory/listing queries when a listing-state event arrives.
 *
 * Mount once, high in the tree (dashboard layout) — not per page, or every
 * FlipDesk route would open its own channel.
 */
export function useRealtimeListingState() {
  const { workspaceOwnerId } = useWorkspace();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workspaceOwnerId) return;

    // Distinct channel name from the notification centre's — two subscribers to
    // the same table are fine, but they must not share a channel or one
    // unmounting would tear down the other's subscription.
    const channel = supabase
      .channel(`listing-state-realtime-${workspaceOwnerId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${workspaceOwnerId}`,
        },
        (payload) => {
          const row = payload.new as NotificationRow;
          if (!row?.type || !LISTING_STATE_TYPES.has(row.type)) return;

          // Prefix invalidation: ["items_full"] covers the listings table's own
          // read plus the page-scoped covers/publish-issues maps (US-2168), and
          // the two "item_listing_*" prefixes cover the platform chips and
          // metrics. These are the same keys the lifecycle mutations invalidate.
          queryClient.invalidateQueries({ queryKey: ["items_full"] });
          queryClient.invalidateQueries({ queryKey: ["item_listing_platforms"] });
          queryClient.invalidateQueries({ queryKey: ["item_listing_metrics"] });
          queryClient.invalidateQueries({ queryKey: ["item_listing_quality"] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [workspaceOwnerId, queryClient]);
}

/** Exported for the unit test — the classification is the part worth locking. */
export function isListingStateNotification(type: string | null | undefined): boolean {
  return !!type && LISTING_STATE_TYPES.has(type);
}

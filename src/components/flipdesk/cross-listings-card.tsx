import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import { useItemListings } from "@/hooks/use-item-listings";
import { QUEUED_NOTICE, useExtensionQueue } from "@/hooks/use-extension-queue";
import { useEndListing } from "@/hooks/use-listing-lifecycle";
import { useMarkDelistDone } from "@/hooks/use-pending-delists";
import { requestDrainNow } from "@/lib/lister-extension";
import { deriveChannelState } from "@/lib/channel-state";

// US-3367: every non-eBay listing of this item, with its state, its
// marketplace page and the one verb that applies.
//
// The listing cards above this one on the item page are eBay-only by design
// (they read platform_offer_id and the eBay sync). Poshmark, Mercari, Grailed
// and Vinted had no link and no End button anywhere on the item page, which
// is how a seller ended up logging into each marketplace by hand after a
// sale. Renders nothing for an item with only eBay rows.

const WORDS: Record<string, string> = {
  live: "Live",
  queued: "Queued for your desktop",
  delist_queued: "Ending from your browser",
  prefilled: "Form filled, not confirmed live",
  failed: "Needs you",
  ended: "Ended",
  sold: "Sold here",
};

export function CrossListingsCard({ itemId }: { itemId: string }) {
  const { data: rows = [] } = useItemListings(itemId);
  const { data: queue } = useExtensionQueue();
  const endListing = useEndListing();
  const markDone = useMarkDelistDone();

  const platforms = [...new Set(rows.filter((r) => r.platform !== "ebay").map((r) => r.platform))];
  if (platforms.length === 0) return null;

  const items = [...(queue?.pending ?? []), ...(queue?.needsAttention ?? [])]
    .filter((it) => it.inventory_item_id === itemId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Other marketplaces</CardTitle>
        <CardDescription>
          Where else this item is listed, and what each one is doing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {platforms.map((p) => {
            const s = deriveChannelState(rows, items, p);
            const label = MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
            return (
              <li
                key={p}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground"> {WORDS[s.state] ?? ""}</span>
                  {s.state === "failed" && s.queueItem?.result?.error && (
                    <span className="block text-xs text-muted-foreground">
                      {s.queueItem.result.error}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {s.url && (
                    <Button variant="outline" size="sm" className="h-7" asChild>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="mr-1 h-3.5 w-3.5" />
                        View on {label}
                      </a>
                    </Button>
                  )}
                  {s.state === "live" && s.row && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7"
                      disabled={endListing.isPending}
                      aria-label={`End the ${label} listing`}
                      onClick={() =>
                        endListing.mutate(
                          { listingId: s.row!.id },
                          {
                            onSuccess: (r) => {
                              // Not "ended" for a queued end: it is live
                              // until the seller's browser runs the job.
                              if (r.queued) {
                                toast.info(`Ending on ${label} from your browser. ${QUEUED_NOTICE}`);
                                void requestDrainNow();
                              } else {
                                toast.success(`Ended on ${label}.`);
                              }
                            },
                            onError: (e) => toastError(e, "Could not end the listing."),
                          },
                        )}
                    >
                      {endListing.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "End listing"
                      )}
                    </Button>
                  )}
                  {s.state === "delist_queued" && s.row && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={markDone.isPending}
                      aria-label={`Mark the ${label} listing ended in FlipDesk`}
                      onClick={() =>
                        markDone.mutate(s.row!.id, {
                          onError: (e) => toastError(e, "Could not update the queue."),
                        })}
                    >
                      Mark ended
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

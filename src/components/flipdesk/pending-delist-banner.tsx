import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import { isListerAvailable } from "@/lib/lister-extension";
import {
  type PendingDelist,
  useMarkDelistDone,
  usePendingDelists,
  useRunDelist,
} from "@/hooks/use-pending-delists";
import { QUEUED_NOTICE, useEnqueueExtensionWork } from "@/hooks/use-extension-queue";

// US-717: surfaces the extension auto-delist queue. When a cross-listed item
// sells, its API siblings (eBay/Shopify/Depop) are ended server-side, but the
// extension siblings (Poshmark/Mercari/Grailed) have no write API — the edge
// queues them (listings.delist_requested_at) and the seller ends each one here,
// in their OWN browser tab, via the GradeThread Lister extension. Renders
// nothing when the queue is empty.

function platformLabel(p: string): string {
  return MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
}

export function PendingDelistBanner() {
  const { data: pending = [] } = usePendingDelists();
  const runDelist = useRunDelist();
  const markDone = useMarkDelistDone();
  const enqueue = useEnqueueExtensionWork();

  if (pending.length === 0) return null;

  const extensionReady = isListerAvailable();
  const busy = runDelist.isPending || markDone.isPending || enqueue.isPending;

  const handleEnd = async (item: PendingDelist) => {
    try {
      const res = await runDelist.mutateAsync(item);
      if (res.manual || !res.ok) {
        // US-1629: the extension couldn't end it — the stamp is intentionally
        // NOT cleared (the listing may still be live), so warn and leave it
        // queued for a retry or a manual "Mark ended".
        toast.warning(
          res.error ?? `End the ${platformLabel(item.platform)} listing manually.`,
        );
      } else {
        toast.success(`Ended on ${platformLabel(item.platform)}.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delist failed.");
    }
  };

  // US-2481: the extension is not installed in THIS browser, but the seller's
  // desktop probably has it. Queue the delist rather than leaving them with only
  // "do it by hand" — a sibling left live after the item sold elsewhere is the
  // double sale this banner exists to prevent, and "I'll get to it" is how that
  // happens. The queue stores WHAT to do; it never holds a marketplace
  // credential.
  const handleQueue = async (item: PendingDelist) => {
    try {
      await enqueue.mutateAsync({
        kind: "delist",
        platform: item.platform,
        listingId: item.listing_id,
        inventoryItemId: item.item_id,
        ...(item.listing_url ? { payload: { listingUrl: item.listing_url } } : {}),
      });
      // Deliberately NOT "Ended." The listing is still live until a desktop
      // browser opens, and saying otherwise is the one thing this whole feature
      // is arranged to avoid.
      toast.success(`Queued for your desktop. ${QUEUED_NOTICE}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not queue that.");
    }
  };

  // US-1629: explicit manual clear — the seller ended the listing themselves
  // (no extension / degraded), so drop it off the queue on their say-so.
  const handleMarkDone = async (item: PendingDelist) => {
    try {
      await markDone.mutateAsync(item.listing_id);
      toast.success(`Marked ${platformLabel(item.platform)} as ended.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the queue.");
    }
  };

  return (
    <Card className="border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="space-y-0.5">
            <p className="text-sm font-semibold">
              {pending.length} cross-listing
              {pending.length === 1 ? "" : "s"} need ending on their marketplace
            </p>
            <p className="text-xs text-muted-foreground">
              {extensionReady
                ? "These sold elsewhere. End them via the GradeThread Lister extension so the same item isn't sold twice."
                : "These sold elsewhere. Install the GradeThread Lister extension to auto-end, or end each one manually on the marketplace."}
            </p>
          </div>
        </div>
        <ul className="space-y-1.5">
          {pending.map((item) => (
            <li
              key={item.listing_id}
              className="flex items-center justify-between gap-3 rounded-md border bg-background px-2.5 py-1.5 text-sm"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium">{platformLabel(item.platform)}</span>
                <span className="text-muted-foreground">
                  {" — "}
                  {item.item_title ?? "Untitled item"}
                </span>
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {item.listing_url && (
                  <a
                    href={item.listing_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-brand-navy underline-offset-2 hover:underline dark:text-foreground"
                  >
                    Open
                  </a>
                )}
                {extensionReady ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={busy}
                      onClick={() => void handleEnd(item)}
                      aria-label={`End the listing for ${item.item_title ?? "untitled item"}`}
                    >
                      {runDelist.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "End listing"
                      )}
                    </Button>
                    {/* US-1629: fallback manual clear if the extension can't end it. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      disabled={busy}
                      onClick={() => void handleMarkDone(item)}
                      aria-label={`Mark ${item.item_title ?? "untitled item"} ended in FlipDesk`}
                    >
                      Mark ended
                    </Button>
                  </>
                ) : (
                  <>
                    {/* US-2481: this browser has no extension, but the seller's
                        desktop likely does. Offer the queue before offering
                        "I did it myself". */}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={busy}
                      onClick={() => void handleQueue(item)}
                    >
                      {enqueue.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Run on my desktop"
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      disabled={busy}
                      onClick={() => void handleMarkDone(item)}
                    >
                      {markDone.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Mark ended"
                      )}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

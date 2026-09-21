import { useEffect, useMemo } from "react";
import type React from "react";
import { ExternalLink, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/toast-error";
import { type CrossPushPlatform } from "@/lib/constants";
import { deriveChannelState, type ChannelStatus } from "@/lib/channel-state";
import { listOnRows, summarizeCrossPush } from "@/lib/list-on-channels";
import { requestDrainNow } from "@/lib/lister-extension";
import { useCrossPostChannels } from "@/hooks/use-cross-post-channels";
import { useCrossPush } from "@/hooks/use-cross-listing";
import { useItemListings } from "@/hooks/use-item-listings";
import { QUEUED_NOTICE, useCancelExtensionWork, useExtensionQueue } from "@/hooks/use-extension-queue";
import { useEndListing } from "@/hooks/use-listing-lifecycle";

// US-3450: the one place on the composer that says where this item can go,
// where it already is, and takes the ticks.
//
// It replaces two controls that each told half the story: the Push-to card
// offered the API channels and showed the extension ones as a dashed strip
// that could not be ticked, and the Listing Kit's checklist offered the
// extension channels and knew nothing about eBay. A seller listing to eBay
// plus Poshmark plus Mercari touched both. Now one list, every channel the
// seller sells on, each row carrying deriveChannelState (the same word the
// item page card uses) and the per-channel price the Push-to card had.
//
// The ticks are the composer's own `pushPlatforms`, so the rail's Publish
// button, its label and the readiness readout keep reading one set. In draft
// mode that button is the one button: eBay alone opens the preflight dialog,
// anything else fans out through cross-push, which queues the extension
// channels. In live mode the rail's button is "Save & resubmit to eBay" and
// cannot carry the other channels, so the panel offers the one button for
// them here, through the same cross-push call (US-3367).

const STATE_WORDS: Record<string, string> = {
  live: "Live",
  unconfirmed: "Recorded as listed, not confirmed",
  queued: "Queued for your desktop",
  delist_queued: "Ending from your browser",
  prefilled: "Form filled, not confirmed live",
  failed: "Needs you",
  ended: "Ended",
  sold: "Sold here",
};

export interface ListOnPanelProps {
  itemId: string;
  /** The eBay draft row the fan-out starts from; null before the first save. */
  draftListingId: string | null;
  editorMode: "draft" | "live" | "closed";
  pushPlatforms: Set<CrossPushPlatform>;
  togglePushPlatform: (p: CrossPushPlatform) => void;
  /** Drop channels the panel found blocked, so a stale tick cannot reach Publish. */
  removePushPlatforms: (platforms: CrossPushPlatform[]) => void;
  platformPrices: Partial<Record<CrossPushPlatform, string>>;
  setPlatformPrices: React.Dispatch<React.SetStateAction<Partial<Record<CrossPushPlatform, string>>>>;
  /** Placeholder for a per-platform override left blank. */
  price: string;
}

export function ListOnPanel({
  itemId,
  draftListingId,
  editorMode,
  pushPlatforms,
  togglePushPlatform,
  removePushPlatforms,
  platformPrices,
  setPlatformPrices,
  price,
}: ListOnPanelProps) {
  const qc = useQueryClient();
  // US-2721: only the channels this seller cross-posts to.
  const { data: chosenChannels } = useCrossPostChannels();
  const { data: listingRows = [] } = useItemListings(itemId);
  const { data: queue } = useExtensionQueue();
  const crossPush = useCrossPush();
  const endListing = useEndListing();
  const cancelJob = useCancelExtensionWork();

  const queueForItem = useMemo(
    () =>
      [...(queue?.pending ?? []), ...(queue?.needsAttention ?? [])]
        .filter((it) => it.inventory_item_id === itemId),
    [queue, itemId],
  );
  const rows = useMemo(() => {
    const statuses: Record<string, ChannelStatus> = {};
    const probe = listOnRows(chosenChannels, {});
    for (const r of probe) statuses[r.platform] = deriveChannelState(listingRows, queueForItem, r.platform);
    return listOnRows(chosenChannels, statuses);
  }, [chosenChannels, listingRows, queueForItem]);

  // A tick on a channel that has since gone live or queued must not reach
  // Publish: the server would skip it (US-3367), but the button's label would
  // still count it. Pruned here, where the block is known.
  const blockedTicked = rows
    .filter((r) => r.blocked && pushPlatforms.has(r.platform))
    .map((r) => r.platform);
  const blockedKey = blockedTicked.join(",");
  useEffect(() => {
    if (blockedTicked.length > 0) removePushPlatforms(blockedTicked);
    // blockedKey stands in for the array, which is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockedKey]);

  const ticked = rows.filter((r) => !r.blocked && pushPlatforms.has(r.platform));

  // Live mode only: the rail's button is eBay's resubmit, so the other
  // channels list from here. Same fan-out, same skips, same sentence.
  const listNow = async () => {
    if (!draftListingId) {
      toast.error("Save the eBay draft first.");
      return;
    }
    const platforms = ticked.map((r) => r.platform).filter((p) => p !== "ebay");
    if (platforms.length === 0) {
      toast.error("Pick at least one marketplace.");
      return;
    }
    const prices: Partial<Record<CrossPushPlatform, number>> = {};
    for (const p of platforms) {
      const parsed = Number.parseFloat(platformPrices[p] ?? "");
      if (Number.isFinite(parsed) && parsed > 0) prices[p] = parsed;
    }
    try {
      const res = await crossPush.mutateAsync({ listingId: draftListingId, platforms, prices });
      const s = summarizeCrossPush(res.results, platforms);
      for (const name of s.published) toast.success(`Published to ${name}.`);
      if (s.queued.length > 0) {
        toast.success(`Queued for your desktop: ${s.queued.join(", ")}. ${QUEUED_NOTICE}`, {
          duration: 10_000,
        });
        void requestDrainNow();
      }
      if (s.live.length > 0) toast.info(`Already live: ${s.live.join(", ")}.`);
      if (s.waiting.length > 0) toast.info(`Already waiting for your desktop: ${s.waiting.join(", ")}.`);
      if (s.stubbed.length > 0) {
        toast.info(`${s.stubbed.join(", ")} saved locally; publishing there ships soon.`);
      }
      for (const b of s.blocked) toast.error(b, { duration: 12_000 });
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
      void qc.invalidateQueries({ queryKey: ["item_listings", itemId] });
    } catch (err) {
      toastError(err, "Could not queue the cross-posts.");
    }
  };

  const tickedCount = ticked.filter((r) => r.platform !== "ebay").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>List on</CardTitle>
        <CardDescription>
          Every marketplace you sell on, and what this item is doing there. Tick
          the ones to list on. Each one can carry its own price; blank uses the
          price above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => {
          const id = `list-on-${r.platform}`;
          const checked = !r.blocked && pushPlatforms.has(r.platform);
          const state = r.status?.state ?? "none";
          const word = STATE_WORDS[state];
          const busy = crossPush.isPending || endListing.isPending || cancelJob.isPending;
          return (
            <div
              key={r.platform}
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5",
                r.blocked && "text-muted-foreground",
              )}
            >
              <label htmlFor={id} className="flex min-w-0 items-center gap-2 text-sm">
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={Boolean(r.blocked) || busy}
                  onCheckedChange={() => togglePushPlatform(r.platform)}
                />
                <span className="font-medium whitespace-nowrap">{r.label}</span>
                <Badge variant="outline" className="text-[10px] whitespace-nowrap">
                  {r.mechanism === "api" ? "Connected via API" : "Via browser extension"}
                </Badge>
                {r.blocked ? (
                  <span className="text-xs">({r.blocked})</span>
                ) : word ? (
                  <span className="text-xs text-muted-foreground">{word}</span>
                ) : null}
              </label>
              <span className="flex shrink-0 items-center gap-1.5">
                {r.status?.url && (
                  <Button variant="outline" size="sm" className="h-7" asChild>
                    <a href={r.status.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="mr-1 h-3.5 w-3.5" />
                      View on {r.label}
                    </a>
                  </Button>
                )}
                {state === "live" && r.status?.row && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={endListing.isPending}
                    aria-label={`End the ${r.label} listing`}
                    onClick={() =>
                      endListing.mutate(
                        { listingId: r.status!.row!.id },
                        {
                          onSuccess: (res) => {
                            if (res.queued) {
                              toast.info(`Ending on ${r.label} from your browser. ${QUEUED_NOTICE}`);
                              void requestDrainNow();
                            } else {
                              toast.success(`Ended on ${r.label}.`);
                            }
                          },
                          onError: (e) => toastError(e, "Could not end the listing."),
                        },
                      )}
                  >
                    End listing
                  </Button>
                )}
                {/* Cancel is offered on a WAITING row only (US-3048): a claimed
                    job is halfway through a marketplace form. */}
                {state === "queued" && r.status?.queueItem?.status === "queued" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={cancelJob.isPending}
                    aria-label={`Cancel the queued ${r.label} listing`}
                    onClick={() =>
                      cancelJob.mutate(r.status!.queueItem!.id, {
                        onSuccess: () => toast.success(`Canceled the ${r.label} job.`),
                        onError: (e) => toastError(e, "Could not cancel that job."),
                      })}
                  >
                    Cancel
                  </Button>
                )}
                {checked && (
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={platformPrices[r.platform] ?? ""}
                    onChange={(e) =>
                      setPlatformPrices((prev) => ({ ...prev, [r.platform]: e.target.value }))}
                    placeholder={price || "Price"}
                    className="h-8 max-w-[7rem] text-right"
                    aria-label={`${r.label} price`}
                  />
                )}
              </span>
            </div>
          );
        })}

        {editorMode === "live" && (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              type="button"
              size="sm"
              disabled={crossPush.isPending || tickedCount === 0}
              onClick={() => void listNow()}
            >
              {crossPush.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-1.5 h-4 w-4" />
              )}
              List on {tickedCount} marketplace{tickedCount === 1 ? "" : "s"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Extension channels run one at a time in your own browser, about 30
              seconds apart. {QUEUED_NOTICE}
            </p>
          </div>
        )}
        {editorMode === "draft" && (
          <p className="pt-1 text-xs text-muted-foreground">
            The Publish button names every ticked marketplace. eBay alone opens
            the preflight; with others ticked, the rest queue for your browser.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

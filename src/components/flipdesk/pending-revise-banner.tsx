import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import { isListerAvailable } from "@/lib/lister-extension";
import {
  type PendingRevise,
  pendingRevisesForItem,
  reviseFlowLive,
  staleSinceLabel,
  useMarkReviseDone,
  usePendingRevises,
  useRunRevise,
} from "@/hooks/use-pending-revises";

// US-9202: the edits FlipDesk is waiting to apply on extension channels.
//
// One banner, two mounts: the Listings page shows every stale listing, the
// item page shows the item's own. A row reads "Stale on Poshmark since <date>"
// until the marketplace confirms; "Apply now" is offered only where the
// extension's revise flow is switched on for that channel (the constants map
// that is drift-tested against selectors.js), and everywhere else the honest
// control is the link to edit it there and "I updated it".

function platformLabel(p: string): string {
  return MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
}

const FIELD_WORDS: Record<PendingRevise["fields"][number], string> = {
  price: "price",
  title: "title",
  description: "description",
  photos: "photos",
};

export function PendingReviseBanner({ itemId }: { itemId?: string }) {
  const { data: all = [] } = usePendingRevises();
  const runRevise = useRunRevise();
  const markDone = useMarkReviseDone();

  const pending = itemId ? pendingRevisesForItem(all, itemId) : all;
  if (pending.length === 0) return null;

  const extensionReady = isListerAvailable();
  const busy = runRevise.isPending || markDone.isPending;

  const handleApply = async (item: PendingRevise) => {
    try {
      const res = await runRevise.mutateAsync(item);
      if (res.applied) {
        toast.success(`${platformLabel(item.platform)} confirmed the update.`);
      } else {
        // The marker stays: the listing is still stale on the marketplace and
        // the row keeps saying so.
        toast.warning(
          res.unverified
            ? `Saved on ${platformLabel(item.platform)}, but it could not be confirmed. Check the listing there.`
            : `Update the ${platformLabel(item.platform)} listing by hand; the extension could not apply it.`,
          { duration: 10_000 },
        );
      }
    } catch (err) {
      toastError(err, "Could not apply the edit.");
    }
  };

  const handleDone = async (item: PendingRevise) => {
    try {
      await markDone.mutateAsync(item);
      toast.success(`Marked the ${platformLabel(item.platform)} listing as updated.`);
    } catch (err) {
      toastError(err, "Could not mark it updated.");
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <RefreshCw className="h-4 w-4" />
          {pending.length === 1
            ? "1 listing has an edit that has not reached its marketplace"
            : `${pending.length} listings have edits that have not reached their marketplace`}
        </div>
        <p className="text-xs text-muted-foreground">
          Poshmark, Mercari, Vinted and Grailed have no edit API. The GradeThread
          extension applies these in your own browser; until a marketplace
          confirms, the copy there still shows the old values.
        </p>
        <ul className="space-y-2">
          {pending.map((item) => {
            const live = reviseFlowLive(item.platform) && item.auto_revisable;
            return (
              <li
                key={item.listing_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{item.item_title ?? "Untitled item"}</div>
                  <div className="text-xs text-muted-foreground">
                    {staleSinceLabel(item, platformLabel(item.platform))}
                    {" · "}
                    {item.fields.map((f) => FIELD_WORDS[f]).join(", ")}
                    {item.last_error ? ` · last try: ${item.last_error}` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {item.listing_url && (
                    <Button asChild size="sm" variant="outline">
                      <a href={item.listing_url} target="_blank" rel="noopener noreferrer">
                        Edit there
                      </a>
                    </Button>
                  )}
                  {live && extensionReady && (
                    <Button size="sm" disabled={busy} onClick={() => void handleApply(item)}>
                      {runRevise.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Apply now
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleDone(item)}>
                    I updated it
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

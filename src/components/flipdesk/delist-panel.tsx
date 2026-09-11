import { useState } from "react";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import { isListerAvailable, isListerPlatform } from "@/lib/lister-extension";
import { safeHref } from "@/lib/safe-url";
import {
  activeListingsLink,
  needsSellerHandle,
  parseSellerHandle,
} from "@/lib/delist-links";
import { useItemListings, type ItemListingRow } from "@/hooks/use-item-listings";
import { useListerLocales } from "@/hooks/use-lister-locales";
import {
  useMarketplaceHandles,
  useSaveMarketplaceHandle,
} from "@/hooks/use-marketplace-handles";
import {
  type PendingDelist,
  runOneDelist,
  useEndOtherListings,
  useItemPendingDelists,
  useMarkDelistDone,
} from "@/hooks/use-pending-delists";
import { QUEUED_NOTICE, useEnqueueExtensionWork } from "@/hooks/use-extension-queue";
import { useQueryClient } from "@tanstack/react-query";

// US-3369: the delist workflow a seller actually asked for.
//
//   listed    every live listing shows a link to that platform's own
//             active-listings page, so there is always a way to check or end
//             it by hand when the extension cannot;
//   sold      one button, "Delist from other platforms", ends the item
//             everywhere else: eBay/Shopify/Depop/Etsy on the server, and the
//             extension channels in this browser one after another;
//   fallback  each row keeps the link and a "Mark ended" for the ones the
//             extension could not finish.

function platformLabel(p: string): string {
  return MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
}

/**
 * "Your Poshmark listings" (and "View listing" when we hold the link). For
 * Poshmark with no saved username it asks for one, inline, because that link
 * is the fallback that has to work when nothing else does.
 */
export function ActiveListingsLinks({
  platform,
  listingUrl,
}: {
  platform: string;
  listingUrl?: string | null;
}) {
  const { data: handles } = useMarketplaceHandles();
  const { data: locales } = useListerLocales();
  const link = activeListingsLink(platform, { handles, locales });
  const label = platformLabel(platform);
  const own = safeHref(listingUrl ?? null);

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {own && (
        <a
          href={own}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-brand-navy underline-offset-2 hover:underline dark:text-foreground"
        >
          View listing
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
      {link ? (
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-brand-navy underline-offset-2 hover:underline dark:text-foreground"
        >
          {link.exact ? `Your ${label} listings` : `Open ${label}`}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      ) : needsSellerHandle(platform) ? (
        <SellerHandlePrompt platform={platform} />
      ) : null}
    </span>
  );
}

/** Ask once for the seller's username on a platform whose listings page needs it. */
export function SellerHandlePrompt({ platform }: { platform: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useSaveMarketplaceHandle();
  const label = platformLabel(platform);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-brand-navy underline-offset-2 hover:underline dark:text-foreground"
      >
        Add your {label} username for a direct link
      </button>
    );
  }

  const submit = async () => {
    const handle = parseSellerHandle(value);
    if (!handle) {
      setError(`That doesn't look like a ${label} username.`);
      return;
    }
    try {
      await save.mutateAsync({ platform, handle });
      toast.success(`Saved your ${label} username.`);
      setOpen(false);
    } catch (err) {
      toastError(err, "Couldn't save that.");
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <label htmlFor={`handle-${platform}`} className="sr-only">
        Your {label} username
      </label>
      <Input
        id={`handle-${platform}`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder={`${label} username`}
        className="h-7 w-40 text-xs"
        aria-invalid={error ? true : undefined}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={save.isPending}
        onClick={() => void submit()}
        aria-label={`Save your ${label} username`}
      >
        {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
      </Button>
      {error && <span className="text-brand-red-text">{error}</span>}
    </span>
  );
}

function isLive(row: ItemListingRow): boolean {
  return row.listing_status === "active" || row.listing_status === "draft";
}

/**
 * Where this item is listed right now, each with its links. Renders nothing
 * when it is listed nowhere.
 */
export function ListedOnCard({ itemId }: { itemId: string }) {
  const { data: rows = [] } = useItemListings(itemId);
  const live = rows.filter(isLive);
  if (live.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div>
          <p className="font-medium">Where it's listed</p>
          <p className="text-sm text-muted-foreground">
            Each link opens that marketplace's own list of your active listings,
            so you can check or end one there if the extension can't.
          </p>
        </div>
        <ul className="space-y-2">
          {live.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium">{platformLabel(row.platform)}</span>
                <span className="text-muted-foreground">
                  {row.listing_status === "active" ? " · Live" : " · Filled in, not confirmed live"}
                </span>
              </span>
              <ActiveListingsLinks platform={row.platform} listingUrl={row.listing_url} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

type RowRun = { state: "working" | "ended" | "failed"; error?: string };

/**
 * The Delist panel for one item. Shows when the item is sold and still listed
 * somewhere, or when a sale left listings waiting on this browser.
 */
export function ItemDelistPanel({
  itemId,
  itemStatus,
}: {
  itemId: string;
  itemStatus: string;
}) {
  const qc = useQueryClient();
  const { data: rows = [] } = useItemListings(itemId);
  const { data: pending = [] } = useItemPendingDelists(itemId);
  const endOthers = useEndOtherListings();
  const markDone = useMarkDelistDone();
  const enqueue = useEnqueueExtensionWork();
  const [runs, setRuns] = useState<Record<string, RowRun>>({});
  const [running, setRunning] = useState(false);

  const sold = itemStatus === "sold";
  const pendingIds = new Set(pending.map((p) => p.listing_id));
  // Live rows the server has not ended yet. Only meaningful once it sold.
  const stillLive = sold ? rows.filter((r) => isLive(r) && !pendingIds.has(r.id)) : [];
  if (stillLive.length === 0 && pending.length === 0) return null;

  const extensionReady = isListerAvailable();

  const runAll = async () => {
    setRunning(true);
    try {
      let queue: PendingDelist[] = pending;
      let serverEnded = 0;
      let unresolved = 0;
      if (sold) {
        const res = await endOthers.mutateAsync({ itemId, mode: "explicit" });
        queue = res.pending;
        serverEnded = res.summary.ended + res.summary.nothingLive;
        unresolved = res.summary.unresolved;
      }
      const extensionRows = queue.filter((p) => isListerPlatform(p.platform));

      if (extensionRows.length > 0 && !extensionReady) {
        toast.warning(
          "The GradeThread extension isn't in this browser. Use Run on my desktop, " +
            "or end each one from its link and press Mark ended.",
        );
      }

      let ended = 0;
      let failed = 0;
      if (extensionReady) {
        // One at a time: each opens a marketplace tab in your own session, and
        // six at once in the browser you are using is not a feature.
        for (const p of extensionRows) {
          setRuns((r) => ({ ...r, [p.listing_id]: { state: "working" } }));
          try {
            const res = await runOneDelist(p);
            if (res.ok) {
              ended++;
              setRuns((r) => ({ ...r, [p.listing_id]: { state: "ended" } }));
            } else {
              failed++;
              setRuns((r) => ({
                ...r,
                [p.listing_id]: { state: "failed", error: res.error ?? "Couldn't end it." },
              }));
            }
          } catch (err) {
            failed++;
            setRuns((r) => ({
              ...r,
              [p.listing_id]: {
                state: "failed",
                error: err instanceof Error ? err.message : "Couldn't end it.",
              },
            }));
          }
        }
      }

      void qc.invalidateQueries({ queryKey: ["pending_delists"] });
      void qc.invalidateQueries({ queryKey: ["item_listings"] });

      const done = serverEnded + ended;
      if (failed === 0 && unresolved === 0 && (extensionReady || extensionRows.length === 0)) {
        toast.success(done > 0 ? `Ended ${done} listing${done === 1 ? "" : "s"}.` : "Nothing left to end.");
      } else if (failed > 0 || unresolved > 0) {
        toast.warning(
          `${failed + unresolved} listing${failed + unresolved === 1 ? "" : "s"} still need you. ` +
            "Use the link on each one to end it, then press Mark ended.",
        );
      }
    } catch (err) {
      toastError(err, "Delist failed.");
    } finally {
      setRunning(false);
    }
  };

  const queueOnDesktop = async (p: PendingDelist) => {
    try {
      const payload: Record<string, unknown> = {};
      if (p.listing_url) payload.listingUrl = p.listing_url;
      if (p.match_titles?.length) payload.matchTitles = p.match_titles;
      if (p.seller_handle) payload.sellerHandle = p.seller_handle;
      await enqueue.mutateAsync({
        kind: "delist",
        platform: p.platform,
        listingId: p.listing_id,
        inventoryItemId: p.item_id,
        payload,
      });
      // Not "ended": it is still live until a desktop browser runs it.
      toast.success(`Queued for your desktop. ${QUEUED_NOTICE}`);
    } catch (err) {
      toastError(err, "Could not queue that.");
    }
  };

  const markEnded = async (listingId: string, platform: string) => {
    try {
      await markDone.mutateAsync(listingId);
      setRuns((r) => ({ ...r, [listingId]: { state: "ended" } }));
      toast.success(`Marked ${platformLabel(platform)} as ended.`);
    } catch (err) {
      toastError(err, "Could not update it.");
    }
  };

  const count = stillLive.length + pending.length;

  return (
    <Card id="delist" className="border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-0.5">
            <p className="text-sm font-semibold">
              {sold ? "This sold. " : ""}
              {count} listing{count === 1 ? " is" : "s are"} still up elsewhere
            </p>
            <p className="text-xs text-muted-foreground">
              {extensionReady
                ? "Delist ends each one: eBay and other connected shops right away, the rest in your own browser, one tab at a time."
                : "Delist ends the connected shops right away. For the rest, open this on a computer with the GradeThread extension, or end them from the links below."}
            </p>
          </div>
          <Button size="sm" disabled={running} onClick={() => void runAll()}>
            {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Delist from other platforms
          </Button>
        </div>

        <ul className="space-y-1.5">
          {stillLive.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm"
            >
              <span>
                <span className="font-medium">{platformLabel(row.platform)}</span>
                <span className="text-muted-foreground"> · Still live</span>
              </span>
              <ActiveListingsLinks platform={row.platform} listingUrl={row.listing_url} />
            </li>
          ))}
          {pending.map((p) => {
            const run = runs[p.listing_id];
            return (
              <li
                key={p.listing_id}
                className="space-y-1 rounded-md border bg-background px-2.5 py-1.5 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-medium">{platformLabel(p.platform)}</span>
                    {run?.state === "working" ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Ending
                      </span>
                    ) : run?.state === "ended" ? (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Check className="h-3.5 w-3.5" aria-hidden="true" /> Ended
                      </span>
                    ) : run?.state === "failed" ? (
                      <span className="inline-flex items-center gap-1 text-brand-red-text">
                        <X className="h-3.5 w-3.5" aria-hidden="true" /> Needs you
                      </span>
                    ) : (
                      <span className="text-muted-foreground">· Needs ending</span>
                    )}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <ActiveListingsLinks platform={p.platform} listingUrl={p.listing_url} />
                    {!extensionReady && isListerPlatform(p.platform) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        disabled={enqueue.isPending || running}
                        onClick={() => void queueOnDesktop(p)}
                        aria-label={`Run the ${platformLabel(p.platform)} delist on my desktop`}
                      >
                        Run on my desktop
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      disabled={markDone.isPending || running}
                      onClick={() => void markEnded(p.listing_id, p.platform)}
                      aria-label={`Mark the ${platformLabel(p.platform)} listing ended`}
                    >
                      Mark ended
                    </Button>
                  </span>
                </div>
                {run?.state === "failed" && run.error && (
                  <p className="text-xs text-muted-foreground">{run.error}</p>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

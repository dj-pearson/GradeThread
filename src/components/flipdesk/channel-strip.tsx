import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { cn } from "@/lib/utils";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import { deriveChannelState, type ChannelRowLike, type ChannelState } from "@/lib/channel-state";
import { requestDrainNow } from "@/lib/lister-extension";
import { QUEUED_NOTICE, useCancelExtensionWork, type ExtensionQueueItem } from "@/hooks/use-extension-queue";
import { useEndListing } from "@/hooks/use-listing-lifecycle";
import type { PlatformChip } from "@/pages/flipdesk/listings-page-queries";

// US-3451: where this garment is, per marketplace, on one table row.
//
// One dot per channel that has a listings row for the item or a pending
// extension job, coloured by deriveChannelState (src/lib/channel-state.ts),
// which is the same reading the item page card and the composer's List on
// panel use. The dots are derived from rows the page already fetches
// (listings-page-queries.ts, the platform chips) plus the seller's queue; this
// file makes no request of its own, and listings-channel-strip.test.tsx holds
// it to that.
//
// A dot is a link when the row has a marketplace URL, the End verb when the
// listing is live, Cancel when a list job is still waiting, and a plain mark
// otherwise. A sold or ended dot has no verb.

export const STRIP_WORDS: Record<ChannelState, string> = {
  live: "live",
  unconfirmed: "recorded as listed, not confirmed",
  queued: "queued for your desktop",
  delist_queued: "ending from your browser",
  prefilled: "form filled, not confirmed live",
  failed: "needs you",
  ended: "ended",
  sold: "sold here",
  none: "",
};

const TONE: Record<ChannelState, string> = {
  live: "bg-emerald-500",
  unconfirmed: "bg-amber-500",
  queued: "bg-sky-500",
  delist_queued: "bg-amber-500",
  prefilled: "border border-dashed border-muted-foreground bg-transparent",
  failed: "bg-brand-red",
  ended: "bg-muted-foreground/40",
  sold: "bg-brand-navy",
  none: "bg-transparent",
};

function chipRow(c: PlatformChip): ChannelRowLike {
  return {
    id: c.id,
    platform: c.platform,
    listing_status: c.status,
    listing_url: c.listing_url,
    delist_requested_at: c.delist_requested_at,
    platform_fields: c.listed_unconfirmed ? { listed_unconfirmed: true } : null,
    updated_at: c.updated_at,
  };
}

export interface ChannelStripProps {
  itemId: string;
  chips: readonly PlatformChip[];
  /** The seller's queue rows for THIS item (pending plus needs-attention). */
  queueItems: readonly ExtensionQueueItem[];
}

export function ChannelStrip({ itemId, chips, queueItems }: ChannelStripProps) {
  const endListing = useEndListing();
  const cancelJob = useCancelExtensionWork();
  const rows = chips.map(chipRow);
  // Newest row per platform first, so a relisted garment reads from its
  // current row; the derivation itself picks the first match.
  rows.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  const platforms = [
    ...new Set([...rows.map((r) => r.platform), ...queueItems.map((q) => q.platform)]),
  ];
  if (platforms.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1" data-item-id={itemId}>
      {platforms.map((p) => {
        const s = deriveChannelState(rows, queueItems, p);
        const label = MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
        const word = STRIP_WORDS[s.state];
        const name = word ? `${label}: ${word}` : label;
        const since = s.since ? ` since ${new Date(s.since).toLocaleDateString()}` : "";
        const dot = (
          <span
            aria-hidden="true"
            className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", TONE[s.state])}
          />
        );
        const text = <span className="text-[10px] font-medium leading-none">{label}</span>;
        const cls =
          "inline-flex items-center gap-1 rounded border px-1 py-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

        if (s.url) {
          return (
            <a
              key={p}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cls}
              title={`${name}${since}. Opens on ${label}.`}
              aria-label={`${name}. View on ${label}.`}
              onClick={(e) => e.stopPropagation()}
            >
              {dot}
              {text}
            </a>
          );
        }
        if (s.state === "live" && s.row) {
          const rowId = s.row.id;
          return (
            <button
              key={p}
              type="button"
              className={cls}
              title={`${name}${since}. Ends the listing.`}
              aria-label={`${name}. End the ${label} listing.`}
              disabled={endListing.isPending}
              onClick={(e) => {
                e.stopPropagation();
                endListing.mutate(
                  { listingId: rowId },
                  {
                    onSuccess: (r) => {
                      if (r.queued) {
                        toast.info(`Ending on ${label} from your browser. ${QUEUED_NOTICE}`);
                        void requestDrainNow();
                      } else {
                        toast.success(`Ended on ${label}.`);
                      }
                    },
                    onError: (err) => toastError(err, "Could not end the listing."),
                  },
                );
              }}
            >
              {dot}
              {text}
            </button>
          );
        }
        if (s.state === "queued" && s.queueItem?.status === "queued") {
          const jobId = s.queueItem.id;
          return (
            <button
              key={p}
              type="button"
              className={cls}
              title={`${name}${since}. Cancels the queued job.`}
              aria-label={`${name}. Cancel the queued ${label} listing.`}
              disabled={cancelJob.isPending}
              onClick={(e) => {
                e.stopPropagation();
                cancelJob.mutate(jobId, {
                  onSuccess: () => toast.success(`Canceled the ${label} job.`),
                  onError: (err) => toastError(err, "Could not cancel that job."),
                });
              }}
            >
              {dot}
              {text}
            </button>
          );
        }
        return (
          <span key={p} className={cls} title={`${name}${since}`} aria-label={name} role="img">
            {dot}
            {text}
          </span>
        );
      })}
    </div>
  );
}

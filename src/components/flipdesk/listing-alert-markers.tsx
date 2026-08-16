// US-2165 (AC3) + US-1290 (AC3): the badges for the two listing markers that mean
// "a garment may be about to sell twice".
//
// Both markers were already being STAMPED into listings.platform_fields by
// autoEndCrossListings, and their code comments claimed each one "drives a UI
// badge". Neither did: nothing in src/ read either key, so the durable record the
// server went to the trouble of writing was invisible to the only person who
// could act on it. A marker nobody renders is not a signal.
//
// These are deliberately louder than the sync_drift notice. Drift is
// informational (eBay changed a field we own). These two mean money is at risk
// right now:
//   • delist_unresolved — the item sold, but we could not end this listing on its
//       marketplace, so it is STILL live and purchasable.
//   • oversell_conflict — the same physical garment appears to have sold twice
//       already. One of those orders has to be cancelled.

import { AlertTriangle, ExternalLink, PackageX, ShoppingBag } from "lucide-react";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import {
  type DelistUnresolvedMarker,
  type EbayStateMarker,
  NOTABLE_EBAY_STATE_REASONS,
  type OversellConflictMarker,
} from "@/lib/listing-origin";

/** Human marketplace name, falling back to the raw platform for an unmapped one. */
function platformLabel(platform: string): string {
  return (
    MARKETPLACE_LABELS[platform as keyof typeof MARKETPLACE_LABELS] ?? platform
  );
}

function formatDetectedAt(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const BANNER =
  "space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm";

// US-2656: one step quieter than BANNER. Nothing here is money leaving the
// building this minute, but each one means the listing is not selling and the
// seller has not been told why.
const NOTICE =
  "space-y-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-sm dark:border-amber-800/60 dark:bg-amber-950/20";

const EBAY_STATE_HEADING: Record<string, string> = {
  out_of_stock: "Out of stock on eBay",
  inactive: "eBay made this listing inactive",
  unknown_status: "eBay reports an unfamiliar status",
};

/**
 * Reads the markers off a listing's `platform_fields` and renders whichever are
 * present. Returns null when the listing is clean, so callers can drop it in
 * unconditionally.
 *
 * `listingUrl` is optional but worth passing: the whole point of the
 * delist_unresolved banner is to get the seller to the live listing and end it,
 * and a link is the difference between a warning and a fix.
 */
export function ListingAlertMarkers({
  platformFields,
  platform,
  listingUrl,
}: {
  platformFields: Record<string, unknown> | null | undefined;
  platform: string;
  listingUrl?: string | null;
}) {
  const pf = platformFields ?? {};
  const unresolved = (pf.delist_unresolved ?? null) as
    | DelistUnresolvedMarker
    | null;
  const oversell = (pf.oversell_conflict ?? null) as
    | OversellConflictMarker
    | null;
  const rawState = (pf.ebay_state ?? null) as EbayStateMarker | null;
  // Only the reasons that need saying. A live listing and an ended one are
  // already what the status badge shows.
  const ebayState =
    rawState && NOTABLE_EBAY_STATE_REASONS.has(rawState.reason) ? rawState : null;

  if (!unresolved && !oversell && !ebayState) return null;

  const unresolvedPlatform = platformLabel(unresolved?.platform || platform);

  return (
    <div className="space-y-3">
      {unresolved && (
        <div className={BANNER} role="alert">
          <p className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            This {unresolvedPlatform} listing may still be live
          </p>
          <p className="text-muted-foreground">
            This item sold elsewhere, so we ended it here — but we couldn't end it
            on {unresolvedPlatform}. Until you end it there, the same item can
            still be bought.
          </p>
          {unresolved.reason && (
            <p className="text-xs text-muted-foreground">
              Reason: {unresolved.reason}
            </p>
          )}
          {listingUrl && (
            <a
              href={listingUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-destructive underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open the listing to end it
            </a>
          )}
          {formatDetectedAt(unresolved.detected_at) && (
            <p className="text-xs text-muted-foreground">
              Detected {formatDetectedAt(unresolved.detected_at)}
            </p>
          )}
        </div>
      )}

      {ebayState && (
        <div className={NOTICE} role="status">
          <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
            <PackageX className="h-4 w-4 flex-shrink-0" />
            {EBAY_STATE_HEADING[ebayState.reason] ?? "eBay changed this listing"}
          </p>
          {ebayState.message && (
            <p className="text-amber-900/80 dark:text-amber-200/80">
              {ebayState.message}
            </p>
          )}
          {listingUrl && (
            <a
              href={listingUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-amber-800 underline dark:text-amber-300"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open it on eBay
            </a>
          )}
          {formatDetectedAt(ebayState.observed_at) && (
            <p className="text-xs text-amber-900/70 dark:text-amber-200/70">
              eBay said so {formatDetectedAt(ebayState.observed_at)}
            </p>
          )}
        </div>
      )}

      {oversell && (
        <div className={BANNER} role="alert">
          <p className="flex items-center gap-2 font-medium text-destructive">
            <ShoppingBag className="h-4 w-4 flex-shrink-0" />
            Possible double sale
          </p>
          <p className="text-muted-foreground">
            This item looks like it sold on more than one marketplace. We haven't
            picked a winner — review both orders and cancel one so a buyer isn't
            left waiting for an item that's gone.
          </p>
          {formatDetectedAt(oversell.detected_at) && (
            <p className="text-xs text-muted-foreground">
              Detected {formatDetectedAt(oversell.detected_at)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

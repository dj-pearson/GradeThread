import { Link } from "react-router";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketplaceConnectionSummary } from "@/components/flipdesk/marketplace-connection-summary";
import { EbayAccountHealthCard } from "@/components/flipdesk/ebay-account-health-card";
import { useEbayConnectionIssue } from "@/hooks/use-ebay";
import { MARKETPLACE_TIER } from "@/lib/constants";

// US-3078 AC5: is anything connected, and is eBay happy with me, in one frame.
//
// Both halves are the existing components. MarketplaceConnectionSummary is the
// Marketplaces page's own answer to "which platforms am I on", and
// EbayAccountHealthCard is the only renderer of useEbayAccountHealth, carrying
// the Seller Standards, the projected standing and the customer-service
// defects. Neither page loses its copy: react-query serves both from the same
// cache keys, so putting them here costs no extra requests.
//
// ── THE ALERT ───────────────────────────────────────────────────────────────
//
// A revoked or expired eBay grant is the one thing on this frame that is not
// reporting, it is a stopped business: nothing syncs, nothing lists, and the
// seller finds out days later from a buyer. So it goes ABOVE both cards as the
// frame's alert state, in eBay's own words about what went wrong, with the way
// to fix it attached. The Marketplaces page raises the same banner (US-463) and
// owns the re-auth flow, which is where the button goes rather than starting a
// second OAuth handshake from a dashboard tile.

/** Channels that list through the browser extension, so they have no connection. */
const EXTENSION_CHANNEL_COUNT = Object.values(MARKETPLACE_TIER).filter(
  (tier) => tier === "extension",
).length;

const MARKETPLACES_HREF = "/dashboard/flipdesk/marketplaces";

export function FlipdeskMarketplaceHealthWidget() {
  const { data: issue } = useEbayConnectionIssue();

  // The US-463 test: deactivated AND carrying a refresh error. A connection
  // that was never made is "Not connected" in the summary below, which is a
  // different sentence and not an alarm.
  const needsReconnect = !!issue && !issue.is_active && !!issue.refresh_error;

  return (
    <div className="space-y-3">
      {needsReconnect ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <span className="text-foreground">{issue.refresh_error}</span>
          </span>
          <Button size="sm" className="shrink-0" asChild>
            <Link to={MARKETPLACES_HREF}>Reconnect eBay</Link>
          </Button>
        </div>
      ) : null}

      <MarketplaceConnectionSummary
        extensionChannelCount={EXTENSION_CHANNEL_COUNT}
      />
      <EbayAccountHealthCard />
    </div>
  );
}

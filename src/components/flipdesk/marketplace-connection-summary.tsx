import { Link } from "react-router";
import { AlertTriangle, Check, Circle, Loader2, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEbayConnection, useEbayConnectionIssue } from "@/hooks/use-ebay";
import { useShopifyConnection } from "@/hooks/use-shopify";
import { useGoogleConnection } from "@/hooks/use-google-sheets";

// US-2543 AC3. The Marketplaces page runs to eight sections, and the one thing
// an operator opens it to learn — which platforms am I actually connected to —
// was only answerable by reading all of them. This is that answer, at the top,
// in one glance.
//
// Every hook here is already mounted further down the page (or on the Google
// page), so this adds no extra requests: react-query serves them from the same
// cache keys.

type Status = "connected" | "attention" | "off" | "loading";

interface Row {
  name: string;
  status: Status;
  /** What the status means in this row's own terms. */
  detail: string;
  /** Where to go to change it. */
  to?: string;
}

function StatusMark({ status }: { status: Status }) {
  if (status === "loading") {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }
  if (status === "connected") {
    return <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
  }
  if (status === "attention") {
    return <AlertTriangle className="h-4 w-4 text-destructive" />;
  }
  return <Minus className="h-4 w-4 text-muted-foreground" />;
}

export function MarketplaceConnectionSummary({
  extensionChannelCount,
}: {
  extensionChannelCount: number;
}) {
  const { data: ebay, isLoading: ebayLoading } = useEbayConnection();
  const { data: ebayIssue } = useEbayConnectionIssue();
  const { data: shopify, isLoading: shopifyLoading } = useShopifyConnection();
  const { data: google, isLoading: googleLoading } = useGoogleConnection();

  // A connection deactivated by a permanent refresh failure is NOT the same as
  // one that was never made, and rolling the two together is how a seller sits
  // for a week wondering why nothing syncs.
  const ebayNeedsReauth = !!ebayIssue && !ebayIssue.is_active && !!ebayIssue.refresh_error;

  const rows: Row[] = [
    {
      name: "eBay",
      status: ebayLoading
        ? "loading"
        : ebayNeedsReauth
          ? "attention"
          : ebay
            ? "connected"
            : "off",
      detail: ebayNeedsReauth
        ? "Sign in again to restore it"
        : ebay
          ? (ebay.account_handle ?? "Connected")
          : "Not connected",
    },
    {
      name: "Shopify",
      status: shopifyLoading ? "loading" : shopify ? "connected" : "off",
      detail: shopify
        ? (shopify.account_handle ?? "Connected")
        : "Not connected",
    },
    {
      name: "Google Sheets",
      status: googleLoading
        ? "loading"
        : google?.sync_status === "error"
          ? "attention"
          : google?.connected
            ? "connected"
            : "off",
      detail:
        google?.sync_status === "error"
          ? "Last sync failed"
          : google?.connected
            ? (google.google_email ?? "Connected")
            : "Not connected",
      to: "/dashboard/flipdesk/marketplaces/google",
    },
  ];

  const live = rows.filter((r) => r.status === "connected").length;
  const trouble = rows.filter((r) => r.status === "attention").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Your connections</CardTitle>
          {trouble > 0 ? (
            <Badge variant="destructive">
              {trouble} need{trouble === 1 ? "s" : ""} attention
            </Badge>
          ) : (
            <Badge variant="secondary">
              {live} of {rows.length} connected
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="space-y-1.5">
          {rows.map((row) => {
            const body = (
              <>
                <span className="flex items-center gap-2 font-medium">
                  <StatusMark status={row.status} />
                  {row.name}
                </span>
                <span
                  className={
                    row.status === "attention"
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {row.detail}
                </span>
              </>
            );
            return (
              <li key={row.name}>
                {row.to ? (
                  <Link
                    to={row.to}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {/* The extension channels have no connection to be in, by design: they
            list from the seller's own logged-in tab. Saying so here stops the
            count above from reading as "3 of 3 and nothing else exists". */}
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Circle aria-hidden="true" className="mt-1.5 h-1 w-1 flex-shrink-0 fill-current" />
          <span>
            {extensionChannelCount} more channel
            {extensionChannelCount === 1 ? "" : "s"} list through the browser
            extension from your own logged-in tab, so they have no connection to
            switch on.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

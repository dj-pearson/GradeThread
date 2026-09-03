import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2952: advertising, on the page that reports profit.
//
// Promoted-listing fees never reached the money view, so the profit figure a
// seller read was profit BEFORE advertising — higher than the number they
// banked, every month they ran ads.
//
// ── THE TOTAL IS THE SUM OF THE LINES ───────────────────────────────────────
//
// Both come from one server-side computation, so the figure at the bottom
// cannot disagree with the rows above it. A profit number a seller cannot
// reconcile against its own lines is one they stop trusting, and then stop
// using.
//
// ── AND ONE HONEST ABSENCE ──────────────────────────────────────────────────
//
// eBay bills the REDUCED price when a discount applies; it does not bill the
// discount as a line. So "discounts you gave" is not in the feed and is not
// inferred from a difference nobody can check. The card says so rather than
// showing a plausible number with nothing behind it.

interface MoneyLine {
  key: string;
  label: string;
  cents: number;
}

interface AdSpendResponse {
  days: number;
  ad_fees_cents: number;
  ad_fees_by_order: Record<string, number>;
  unattributed_ad_fees_cents: number;
  lines: MoneyLine[];
  totalCents: number;
}

const WINDOWS = [30, 90, 365] as const;

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.abs(cents / 100).toFixed(2)}`;
}

/**
 * `days` lets a caller that already has a reporting window drive this card
 * (US-3078 AC2: the FlipDesk overview board hands down its range picker).
 *
 * It seeds the window rather than freezing it: the seller can still pick one of
 * the three buttons below, and that pick wins until the caller's window moves.
 * On the Money page nothing passes it and the card opens at 90 days as it
 * always has.
 */
export function AdSpendCard({ days: seedDays }: { days?: number }) {
  const [days, setDays] = useState<number>(seedDays ?? 90);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["ebay_ad_spend", days],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<AdSpendResponse> => {
      const res = await edgeFetch(`/api/flipdesk/ebay/finances/ad-spend?days=${days}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't read your eBay ad spend.");
      return json as AdSpendResponse;
    },
  });

  const attributedOrders = data ? Object.keys(data.ad_fees_by_order).length : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Megaphone className="h-4 w-4" />
            What advertising cost you
          </span>
          <span className="flex gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w}
                size="sm"
                variant={w === days ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs font-normal"
                onClick={() => setDays(w)}
              >
                {w}d
              </Button>
            ))}
          </span>
        </CardTitle>
        <CardDescription>
          eBay sales and eBay costs over the last {days} days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : isError || !data ? (
          <p className="text-sm text-muted-foreground">
            Couldn't read your eBay transactions. This needs a managed-payments
            account.
          </p>
        ) : (
          <>
            <table className="w-full text-sm">
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.key} className="border-b last:border-0">
                    <td className="py-1.5">{l.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(l.cents)}</td>
                  </tr>
                ))}
                <tr className="border-t-2">
                  <td className="py-1.5 font-medium">Left over</td>
                  <td className="py-1.5 text-right font-medium tabular-nums">
                    {money(data.totalCents)}
                  </td>
                </tr>
              </tbody>
            </table>

            <p className="text-xs text-muted-foreground">
              {data.ad_fees_cents === 0
                ? "No Promoted Listings fees in this window."
                : `${money(data.ad_fees_cents)} of ad fees, ${attributedOrders} of them tied to a specific order.`}
              {data.unattributed_ad_fees_cents > 0 &&
                ` ${money(data.unattributed_ad_fees_cents)} arrived without an order id, so it is in the total but not against an item.`}
            </p>
            <p className="text-xs text-muted-foreground">
              Discounts have no line of their own. eBay bills the lower price,
              not the discount, so a sale is already inside the Sales figure.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

import { Handshake } from "lucide-react";
import { useEbayBestOffers } from "@/hooks/use-ebay";
import { deadlineLabel, isClosedCase } from "@/pages/flipdesk/post-sale-state";
import {
  StatTile,
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-3077 AC3: open Best Offers, and how long the soonest one has left.
//
// An offer is the one queue where waiting is not a deferral, it is a decline:
// eBay expires them, often in 48 hours, and nothing tells the seller afterwards
// that they lost a sale by not looking. So the sub-line is the CLOCK on the
// soonest one rather than the total value of the pile, which is the number that
// looks more impressive and answers a question nobody is asking.
//
// deadlineLabel does the wording, the same function post-sale uses, so "Under a
// day left" means exactly what it means everywhere else.

export function FlipdeskOffersWidget() {
  const { data, isLoading, isError, isFetching, refetch } = useEbayBestOffers();

  if (isLoading) return <StatTileSkeleton label="open offers" />;
  if (isError) {
    return (
      <WidgetLoadError
        what="your open offers"
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  const open = (data ?? []).filter(
    (o) => !(o.status && isClosedCase({ state: o.status })),
  );

  // The soonest real expiry. An offer eBay gave no date for is not "expiring
  // now", so it cannot win this comparison.
  let soonest: string | null = null;
  let soonestAt = Number.POSITIVE_INFINITY;
  for (const o of open) {
    const t = o.expiresAt ? Date.parse(o.expiresAt) : Number.NaN;
    if (Number.isFinite(t) && t < soonestAt) {
      soonestAt = t;
      soonest = o.expiresAt ?? null;
    }
  }
  const clock = deadlineLabel(soonest);

  return (
    <StatTile
      label="Open offers"
      icon={<Handshake className="h-5 w-5" />}
      value={open.length.toLocaleString()}
      sub={
        open.length === 0
          ? "No buyer is waiting on you"
          : (clock ?? "No expiry date from eBay")
      }
      to="/dashboard/flipdesk/offers"
    />
  );
}

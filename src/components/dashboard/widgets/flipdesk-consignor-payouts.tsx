import { Users } from "lucide-react";
import { useConsignorPayouts } from "@/hooks/use-consignors";
import { summarizeDuePayouts } from "@/lib/consignor-payouts";
import { fmtMoney } from "@/lib/flipdesk-overview-format";
import {
  StatTile,
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-3078 AC6: who is owed money, and how much of it.
//
// Read through the same useConsignorPayouts the Consignment page uses, with no
// consignor id, so it is every payout on the account. One hook, one cache key,
// one definition of "due" -- a widget that counted its own would eventually
// disagree with the page a seller opens to pay them.
//
// This widget is REMOVED from the catalog for an account with no consignors
// (the registry's omitWhen, on LayoutContext.hasConsignors). A permanent
// "0 consignors owed" on a solo seller's board is not an empty state waiting to
// fill, it is a card about a feature they do not use.

export function FlipdeskConsignorPayoutsWidget() {
  const { data, isLoading, isError, isFetching, refetch } = useConsignorPayouts();

  if (isLoading) return <StatTileSkeleton label="consignor payouts" />;
  if (isError) {
    return (
      <WidgetLoadError
        what="your consignor payouts"
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  const { consignors, payouts, totalDue } = summarizeDuePayouts(data ?? []);

  return (
    <StatTile
      label="Consignors owed"
      icon={<Users className="h-5 w-5" />}
      value={consignors.toLocaleString()}
      sub={
        consignors === 0
          ? "Everyone has been paid"
          : `${fmtMoney(totalDue)} across ${payouts} payout${payouts === 1 ? "" : "s"}`
      }
      to="/dashboard/flipdesk/consignment"
    />
  );
}

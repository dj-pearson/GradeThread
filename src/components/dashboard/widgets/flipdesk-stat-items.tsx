import { Package } from "lucide-react";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE } from "@/lib/overview-range";
import { fmtMoney } from "@/lib/flipdesk-overview-format";
import {
  MetricsUnavailable,
  StatTile,
  StatTileSkeleton,
} from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-3076: how much you own, and what it is worth.
//
// The only tile here whose numbers are a snapshot rather than a window: `total`
// counts every item the account has and `inventoryValue` prices the ones still
// on hand. Moving the range picker does not change either, which is why the
// registry marks it `rangeAware: false` and its frame says "right now".

export function FlipdeskStatItemsWidget({ range }: WidgetProps) {
  const { data: metrics, isLoading, isError, isFetching, refetch } =
    useFlipdeskOverview(range ?? DEFAULT_OVERVIEW_RANGE);

  if (isLoading) return <StatTileSkeleton label="total items" />;
  if (isError) {
    return <MetricsUnavailable onRetry={() => void refetch()} retrying={isFetching} />;
  }

  return (
    <StatTile
      label="Total items"
      icon={<Package className="h-5 w-5" />}
      value={(metrics?.total ?? 0).toLocaleString()}
      sub={`${fmtMoney(metrics?.inventoryValue)} inventory value`}
      to="/dashboard/flipdesk/items?status=all"
    />
  );
}

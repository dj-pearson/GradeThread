import { DollarSign } from "lucide-react";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE, overviewRangeDef } from "@/lib/overview-range";
import { fmtMoney, fmtMoneyShort } from "@/lib/flipdesk-overview-format";
import {
  MetricsUnavailable,
  StatTile,
  StatTileSkeleton,
} from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-3076: what the seller kept after fees and cost of goods.
//
// The second line is an average per item rather than a repeat of the headline,
// and it is only shown when something sold: dividing by zero sales produced the
// per-item number that made this tile worth splitting out in the first place.

export function FlipdeskStatNetWidget({ range }: WidgetProps) {
  const rangeId = range ?? DEFAULT_OVERVIEW_RANGE;
  const rangeDef = overviewRangeDef(rangeId);
  const { data: metrics, isLoading, isError, isFetching, refetch } =
    useFlipdeskOverview(rangeId);

  if (isLoading) return <StatTileSkeleton label="net profit" />;
  if (isError) {
    return <MetricsUnavailable onRetry={() => void refetch()} retrying={isFetching} />;
  }

  const sold = metrics?.soldInRange ?? 0;
  const net = metrics?.netInRange ?? 0;

  return (
    <StatTile
      label="Net profit"
      icon={<DollarSign className="h-5 w-5" />}
      value={fmtMoney(metrics?.netInRange)}
      sub={
        sold > 0
          ? `${fmtMoneyShort(net / sold)} avg / item`
          : `no sales ${rangeDef.phrase}`
      }
      to="/dashboard/flipdesk/items?tab=sold"
    />
  );
}

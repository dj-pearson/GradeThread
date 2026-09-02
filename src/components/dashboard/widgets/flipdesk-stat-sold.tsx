import { Tag } from "lucide-react";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE, overviewRangeDef } from "@/lib/overview-range";
import { fmtMoney } from "@/lib/flipdesk-overview-format";
import {
  MetricsUnavailable,
  StatTile,
  StatTileSkeleton,
} from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-3076: items sold in the window, and what they grossed before costs.

export function FlipdeskStatSoldWidget({ range }: WidgetProps) {
  const rangeId = range ?? DEFAULT_OVERVIEW_RANGE;
  const rangeDef = overviewRangeDef(rangeId);
  const { data: metrics, isLoading, isError, isFetching, refetch } =
    useFlipdeskOverview(rangeId);

  if (isLoading) return <StatTileSkeleton label="items sold" />;
  if (isError) {
    return <MetricsUnavailable onRetry={() => void refetch()} retrying={isFetching} />;
  }

  return (
    <StatTile
      label="Sold"
      icon={<Tag className="h-5 w-5" />}
      value={(metrics?.soldInRange ?? 0).toLocaleString()}
      sub={`${fmtMoney(metrics?.grossInRange)} gross ${rangeDef.phrase}`}
      to="/dashboard/flipdesk/items?status=sold"
    />
  );
}

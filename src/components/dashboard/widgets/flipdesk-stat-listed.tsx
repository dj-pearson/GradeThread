import { TrendingUp } from "lucide-react";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE, overviewRangeDef } from "@/lib/overview-range";
import {
  MetricsUnavailable,
  StatTile,
  StatTileSkeleton,
} from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-3076: items moved to listed in the window the seller picked.

export function FlipdeskStatListedWidget({ range }: WidgetProps) {
  const rangeId = range ?? DEFAULT_OVERVIEW_RANGE;
  const rangeDef = overviewRangeDef(rangeId);
  const { data: metrics, isLoading, isError, isFetching, isPlaceholderData, refetch } =
    useFlipdeskOverview(rangeId);

  if (isLoading) return <StatTileSkeleton label="items listed" />;
  if (isError) {
    return <MetricsUnavailable onRetry={() => void refetch()} retrying={isFetching} />;
  }

  return (
    <StatTile
      label="Listed"
      icon={<TrendingUp className="h-5 w-5" />}
      value={(metrics?.listedInRange ?? 0).toLocaleString()}
      sub={`items moved to listed ${rangeDef.phrase}`}
      to="/dashboard/flipdesk/items?status=listed"
      // The list has no list_date filter, so it cannot show only the items
      // listed in this window. Say where the link goes instead of implying
      // the list matches the number.
      cta="See all listed"
      stale={isPlaceholderData}
    />
  );
}

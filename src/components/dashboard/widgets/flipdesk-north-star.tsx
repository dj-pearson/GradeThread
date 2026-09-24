import { NorthStarCard } from "@/components/flipdesk/north-star-card";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE } from "@/lib/overview-range";
import type { WidgetProps } from "@/lib/dashboard-widgets";
import {
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-597, on the board (US-3076): items listed per week against the goal.
//
// It used to be pinned above every number on the page whether or not the seller
// cared about a weekly goal. It is a widget now, first in the shipped default
// and movable or hideable like any other.
//
// The weekly buckets and the lifetime total ride the SAME aggregate as the rest
// of the board, so this adds no query: the range is part of the key and every
// widget passes the same one, so TanStack dedupes all thirteen into one call.
// Neither figure moves with the window, which is why the frame says "right now".

export function FlipdeskNorthStarWidget({ range }: WidgetProps) {
  const { data: metrics, isLoading, isError, isFetching, refetch } =
    useFlipdeskOverview(range ?? DEFAULT_OVERVIEW_RANGE);

  // Without these the card rendered a 0-week streak while the read was in
  // flight, and the same 0 when it failed.
  if (isLoading) return <StatTileSkeleton label="listing streak" />;
  if (isError) {
    return (
      <WidgetLoadError
        what="your listing streak"
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  return (
    <NorthStarCard
      weeks={metrics?.listWeeks ?? []}
      lifetimeListed={metrics?.lifetimeListed}
    />
  );
}

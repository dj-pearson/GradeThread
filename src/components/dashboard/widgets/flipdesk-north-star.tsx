import { NorthStarCard } from "@/components/flipdesk/north-star-card";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE } from "@/lib/overview-range";
import type { WidgetProps } from "@/lib/dashboard-widgets";

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
  const { data: metrics } = useFlipdeskOverview(range ?? DEFAULT_OVERVIEW_RANGE);

  return (
    <NorthStarCard
      weeks={metrics?.listWeeks ?? []}
      lifetimeListed={metrics?.lifetimeListed}
    />
  );
}

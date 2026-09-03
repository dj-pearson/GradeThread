import { CalendarClock } from "lucide-react";
import {
  dropsDueWithin,
  DROPS_WINDOW_DAYS,
  useScheduledDrops,
} from "@/hooks/use-scheduled-drops";
import { detectTimezone, formatInZone } from "@/lib/scheduling";
import {
  StatTile,
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-3077 AC7: what publishes in the next seven days, and when the next one is.
//
// The time is rendered in the VIEWER'S zone, from the browser, and says so with
// its zone abbreviation. A drop scheduled for 7pm Eastern shown as "19:00" to a
// seller in Denver is a two-hour lie about work they cannot redo, and the drops
// calendar has always taken the zone seriously for exactly that reason.
//
// The window is fixed at seven days rather than following the overview's range
// picker: this is the only widget on the board that looks FORWARD, and
// "in the last 30 days" over a list of future publishes would be nonsense. The
// registry marks it not range-aware and gives it its own phrase.

export function FlipdeskScheduledDropsWidget() {
  const { data, isLoading, isError, isFetching, refetch } = useScheduledDrops();

  if (isLoading) return <StatTileSkeleton label="scheduled drops" />;
  if (isError) {
    return (
      <WidgetLoadError
        what="your scheduled drops"
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  const due = dropsDueWithin(data?.rows ?? []);
  const next = due[0];
  const title = next
    ? next.listing_title?.trim() || "Untitled draft"
    : null;

  return (
    <StatTile
      label="Scheduled drops"
      icon={<CalendarClock className="h-5 w-5" />}
      value={due.length.toLocaleString()}
      sub={
        next
          ? `${title} at ${formatInZone(next.scheduled_publish_at, detectTimezone())}`
          : `Nothing queued for the next ${DROPS_WINDOW_DAYS} days`
      }
      to="/dashboard/flipdesk/scheduled-drops"
    />
  );
}

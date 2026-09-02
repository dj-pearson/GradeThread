import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { FLIPDESK_PIPELINE } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE } from "@/lib/overview-range";
import { MetricsUnavailable } from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-2547, on the board (US-3076): one count per stage, each one a way in.
//
// Every tile links to the items list already narrowed to THAT stage. It used to
// promise a filter it could not apply: eight of the nine pre-listed stages went
// to a single tab showing all of them, so a tile reading "Measured 12" opened a
// list of every unlisted item. `?status=<stage>` is honoured by the destination
// now, and src/test/overview-stage-and-range.test.ts holds that shut.
//
// The counts are a snapshot of where things stand, so the frame says "right
// now": nothing here moves when the seller changes the reporting window.

export function FlipdeskPipelineWidget({ range }: WidgetProps) {
  const { data: metrics, isLoading, isError, isFetching, refetch } =
    useFlipdeskOverview(range ?? DEFAULT_OVERVIEW_RANGE);

  if (isLoading) {
    return (
      <LoadingRegion label="Loading pipeline">
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
          aria-hidden="true"
        >
          {FLIPDESK_PIPELINE.map((step) => (
            <Skeleton key={step.status} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </LoadingRegion>
    );
  }

  if (isError) {
    return <MetricsUnavailable onRetry={() => void refetch()} retrying={isFetching} />;
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {FLIPDESK_PIPELINE.map((step) => {
        const count = metrics?.byStatus?.[step.status] ?? 0;
        return (
          <Link
            key={step.status}
            to={`/dashboard/flipdesk/items?status=${step.status}`}
            className="group rounded-lg border bg-card p-3 transition-colors hover:border-brand-navy hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <div className="text-xs text-muted-foreground">{step.label}</div>
            <div className="mt-1 flex items-baseline justify-between">
              <div
                className={cn(
                  "text-2xl font-bold tabular-nums",
                  count === 0 && "text-muted-foreground/50",
                )}
              >
                {count.toLocaleString()}
              </div>
              <ArrowRight
                className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60"
                aria-hidden="true"
              />
            </div>
          </Link>
        );
      })}
    </div>
  );
}

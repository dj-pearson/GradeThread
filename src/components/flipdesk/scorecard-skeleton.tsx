import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { LoadingRegion, MetricCardSkeleton } from "@/components/ui/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A2: the scorecard's loading shape. It sits above the tab strip, so a
 * fallback of nothing made the tabs jump down once the card arrived. This
 * mirrors the real card's rows (title, lead line, five tiles in the same grid,
 * the returns split and the footnote) so the strip stays where it is.
 */
export function ScorecardSkeleton() {
  return (
    <LoadingRegion label="Loading your scorecard">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-8 w-28" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-5 w-3/4" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <MetricCardSkeleton key={i} className="rounded-xl border-0 bg-muted/50" />
            ))}
          </div>
          <Skeleton className="h-[4.5rem] w-full rounded-xl" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    </LoadingRegion>
  );
}

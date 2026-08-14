import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";

/**
 * The Suspense fallback for a lazily-loaded tab inside one of the FlipDesk hosts
 * (US-2548).
 *
 * All four hosts used a centred spinner, which tells the seller only that
 * something is happening. Every other loading surface in the app draws the shape
 * of what is arriving, so the page does not jump when it lands. This is the
 * generic version of that shape — a controls row, a couple of stat tiles and a
 * body block — because a host does not know which of its tabs is loading.
 */
export function HostViewSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <LoadingRegion label={label}>
      <div className="space-y-4" aria-hidden="true">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </LoadingRegion>
  );
}

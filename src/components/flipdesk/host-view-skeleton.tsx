import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
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

/**
 * SRC-10: a tab whose lazy chunk fails to load (a deploy swapped the hashes, a
 * flaky connection) used to throw past the host and tear the whole page down,
 * tab strip included. This catches it inside the tab, so the seller can switch
 * to another tab, retry this one, or reload.
 */
export class HostViewBoundary extends Component<
  { children: ReactNode; onRetry?: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="space-y-3 rounded-lg border p-6 text-sm">
        <p className="font-medium">This tab did not load</p>
        <p className="text-muted-foreground">
          The rest of the page is fine. Try it again, or reload if a new version
          of the app was just released.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              this.setState({ failed: false });
              this.props.onRetry?.();
            }}
          >
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}

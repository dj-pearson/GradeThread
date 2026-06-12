import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Accessible wrapper for any loading placeholder. The visual skeleton inside is
// decorative (aria-hidden), so this adds the semantics screen readers need: a
// role=status live region with aria-busy and an sr-only label that announces
// what's loading. Use it to wrap the skeleton helpers below (US-440).
export function LoadingRegion({
  label = "Loading",
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

// Generic stack of shimmer rows — the default placeholder for list/table-ish
// content that doesn't warrant the full <TableLoadingSkeleton>. Decorative.
export function SkeletonRows({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

// Table-shaped placeholder: a header row plus N shimmer rows that roughly
// match the real column count, so swapping in the data causes minimal layout
// shift. Built on the shared <Skeleton> (animate-pulse) for one consistent
// loading style app-wide. Decorative — hidden from assistive tech.
export function TableLoadingSkeleton({
  rows = 8,
  columns = 5,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div className={cn("w-full", className)} aria-hidden="true">
      <div className="flex gap-4 border-b px-4 py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b px-4 py-3">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton
              key={c}
              className={cn("h-4 flex-1", c === 0 && "max-w-[35%]")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// Stat-card placeholder: a small label bar over a larger value bar. Render
// several inside the same grid the real metric cards use.
export function MetricCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-lg border p-4", className)} aria-hidden="true">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-20" />
    </div>
  );
}

// Chart placeholder — used as the Suspense fallback while a lazily-loaded
// Recharts component (and the recharts chunk) streams in.
export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-lg border p-4", className)} aria-hidden="true">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-4 h-48 w-full" />
    </div>
  );
}

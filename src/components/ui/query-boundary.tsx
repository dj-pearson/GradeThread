import type { ReactNode } from "react";
import { ErrorState, type ErrorStateProps } from "@/components/ui/error-state";

export interface QueryBoundaryProps {
  /** Initial load in flight (TanStack Query `isLoading` / `isPending`). */
  isLoading: boolean;
  /** The fetch failed (TanStack Query `isError`). */
  isError: boolean;
  /** Success, but there's no data to show. Caller decides what "empty" means. */
  isEmpty?: boolean;
  /** Retry handler forwarded to the error state — usually `refetch()`. */
  onRetry?: () => void;
  /** A retry/refetch is in flight (TanStack Query `isFetching`). */
  isRetrying?: boolean;
  /** Skeleton/placeholder shown while loading. */
  loading?: ReactNode;
  /** Empty-state node shown when `isEmpty`. Falls through to `children` if omitted. */
  empty?: ReactNode;
  /** Override copy/props of the default <ErrorState>. */
  errorProps?: Omit<ErrorStateProps, "onRetry" | "retrying">;
  /** Success content. */
  children?: ReactNode;
}

/**
 * One place that standardizes the loading → error → empty → content branch for
 * a data surface (US-436). Precedence is deliberate: the error state wins over
 * empty so a failed fetch is never disguised as "no data yet". Wire `isError`,
 * `onRetry` (= `refetch`), and `isRetrying` (= `isFetching`) straight from a
 * `useQuery` result.
 *
 *   <QueryBoundary
 *     isLoading={isLoading}
 *     isError={isError}
 *     isEmpty={rows.length === 0}
 *     onRetry={refetch}
 *     isRetrying={isFetching}
 *     loading={<TableLoadingSkeleton />}
 *     empty={<EmptyState … />}
 *   >
 *     <Table>…</Table>
 *   </QueryBoundary>
 */
export function QueryBoundary({
  isLoading,
  isError,
  isEmpty = false,
  onRetry,
  isRetrying = false,
  loading,
  empty,
  errorProps,
  children,
}: QueryBoundaryProps) {
  // Error wins over the initial skeleton once a fetch has failed, and always
  // over the empty state — an outage must read as an error, not "no data".
  if (isError) {
    return <ErrorState {...errorProps} onRetry={onRetry} retrying={isRetrying} />;
  }
  if (isLoading) {
    return <>{loading ?? null}</>;
  }
  if (isEmpty && empty != null) {
    return <>{empty}</>;
  }
  return <>{children ?? null}</>;
}

import type { ReactNode } from "react";
import { PackageCheck } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineRetry } from "@/components/flipdesk/inline-retry";
import { Skeleton } from "@/components/ui/skeleton";

// PS-01: the body of every post-sale list card, in one place.
//
// The five cards used to read only `{ data = [], isLoading }`, so a 502 or an
// expired eBay token defaulted the list to [] and drew "No open returns." That
// is the one answer this page must never give wrongly: a seller reads it as
// "nothing is waiting on me" and stops looking. The branches run in a fixed
// order, and the empty copy is only reachable once the read has SUCCEEDED.

export interface QueueBodyProps {
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  refetch: () => unknown;
  /** No row to render for the current view (open or closed). */
  isEmpty: boolean;
  emptyText: string;
  /** What the list holds, for the error line: "returns", "cases". */
  kind: string;
  /** PS-12: "cache_stale" when eBay failed and the edge served its last copy. */
  source?: string | null;
  /** When that copy reached this page (react-query's dataUpdatedAt, ms). */
  updatedAt?: number;
  children: ReactNode;
}

function clock(ms: number | undefined): string {
  if (!ms) return "earlier";
  const d = new Date(ms);
  return Number.isNaN(d.getTime())
    ? "earlier"
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// US-2541: these lists are the ones a seller checks to confirm NOTHING is
// waiting on them, so "nothing here" has to read as an answer rather than as a
// list that failed to draw.
export function EmptyRow({ text }: { text: string }) {
  return (
    <EmptyState
      className="py-8"
      icon={PackageCheck}
      title={text}
      description="eBay cases only. GradeThread does not read your other marketplaces."
    />
  );
}

export function QueueBody({
  isLoading,
  isError,
  isSuccess,
  refetch,
  isEmpty,
  emptyText,
  kind,
  source,
  updatedAt,
  children,
}: QueueBodyProps) {
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  // PS-12: rows from a saved copy still render, because they are the best
  // answer there is, but the seller is told before pressing Refund on them.
  const stale = !isError && source === "cache_stale" ? (
    <InlineRetry
      message={`eBay didn't answer. Showing a saved copy from ${clock(updatedAt)}; deadlines may have moved.`}
      onRetry={() => void refetch()}
    />
  ) : null;
  if (isError) {
    // A background refetch can fail with rows already on screen. Keep them:
    // they are real, and hiding them would be a second wrong answer.
    return (
      <>
        <InlineRetry
          message={`Couldn't reach eBay. Your ${kind} may not be shown.`}
          onRetry={() => void refetch()}
        />
        {isEmpty ? null : children}
      </>
    );
  }
  if (isSuccess && isEmpty) {
    return (
      <>
        {stale}
        <EmptyRow text={emptyText} />
      </>
    );
  }
  return (
    <>
      {stale}
      {children}
    </>
  );
}

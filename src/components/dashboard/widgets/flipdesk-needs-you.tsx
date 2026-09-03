import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { KIND_LABEL, needsYouKey } from "@/pages/flipdesk/needs-you";
import { deadlineBucket, deadlineLabel } from "@/pages/flipdesk/post-sale-state";
import { NEEDS_YOU_HREF, useNeedsYou } from "@/hooks/use-needs-you";
import {
  EmptyList,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-3077 AC2: the ranked queue, on the overview.
//
// Same list as the Needs you card on /post-sale, same hook, same ranking:
// deadline first, then money. What is different is the destination. This
// renders on the overview, so every row is an absolute link into the queue that
// owns it rather than a hash that would scroll to nothing here.
//
// The size decides the depth. Five rows at md is a glance; ten at lg is a
// morning's work. Anything past that belongs on post-sale, which is what the
// footer link says.

/** Rows shown, by frame size. AC2 fixes both numbers. */
const ROWS_BY_SIZE = { sm: 5, md: 5, lg: 10 } as const;

function money(cents: number | null): string | null {
  return cents == null ? null : `$${(cents / 100).toFixed(2)}`;
}

export function FlipdeskNeedsYouWidget({ size }: WidgetProps) {
  const { items, isLoading, isError, isPartial, isFetching, refetch } =
    useNeedsYou();

  if (isLoading) {
    return (
      <LoadingRegion label="Loading what needs you">
        <div className="space-y-1" aria-hidden="true">
          <Skeleton className="h-12 w-full rounded-md" />
          <Skeleton className="h-12 w-full rounded-md" />
          <Skeleton className="h-12 w-full rounded-md" />
        </div>
      </LoadingRegion>
    );
  }

  if (isError) {
    return (
      <WidgetLoadError
        what="your eBay queues"
        onRetry={refetch}
        retrying={isFetching}
      />
    );
  }

  const shown = items.slice(0, ROWS_BY_SIZE[size]);

  return (
    <div>
      {isPartial && (
        <p className="mb-2 text-xs text-muted-foreground" role="status">
          One of your eBay queues did not answer, so this list may be short.{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Trying again..." : "Try again"}
          </button>
        </p>
      )}

      {shown.length === 0 ? (
        <EmptyList>Nothing waiting on you.</EmptyList>
      ) : (
        <>
          <ul className="space-y-1">
            {shown.map((it) => {
              const bucket = deadlineBucket(it.deadline);
              const label = deadlineLabel(it.deadline);
              const amount = money(it.amountCents);
              return (
                <li key={needsYouKey(it)}>
                  <Link
                    to={NEEDS_YOU_HREF[it.kind]}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm hover:bg-muted/50"
                  >
                    <Badge variant="outline" className="text-[10px]">
                      {KIND_LABEL[it.kind]}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{it.subject}</span>
                    {amount && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {amount}
                      </span>
                    )}
                    {/* Text, never colour alone, and nothing at all when we
                        cannot read a deadline, so a parse failure can't look
                        like a case already lost. */}
                    {label && (
                      <Badge
                        variant={
                          bucket === "overdue" || bucket === "imminent"
                            ? "destructive"
                            : "outline"
                        }
                        className="text-[10px]"
                      >
                        {label}
                      </Badge>
                    )}
                    <span className="w-full text-xs text-muted-foreground">
                      {it.action}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {items.length > shown.length && (
            <div className="mt-3 border-t pt-3 text-xs text-muted-foreground">
              <Link
                to="/dashboard/flipdesk/post-sale"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {items.length - shown.length} more waiting on post-sale
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}

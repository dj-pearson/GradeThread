import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AlertCircle } from "lucide-react";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import {
  useFlipdeskOverview,
  OVERVIEW_AGING_DAYS,
  type OverviewAgingRow,
} from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE } from "@/lib/overview-range";
import { PREVIEW_ROWS } from "@/lib/flipdesk-overview-format";
import {
  EmptyList,
  ListIntro,
  MetricsUnavailable,
  ShowAllToggle,
} from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";
import type { ItemStatus } from "@/types/database";

// US-2547, on the board (US-3076): items that have not moved in two weeks.
//
// A snapshot, not a window, so the frame says "right now" and the count does
// not follow the range picker. The "show all" toggle still folds back up when
// the picker moves, because the board reads as one report and half of it
// silently keeping an expanded state from the previous window is the kind of
// thing a seller notices and cannot explain.

export function FlipdeskAgingWidget({ range }: WidgetProps) {
  const { data: metrics, isLoading, isError, isFetching, refetch } =
    useFlipdeskOverview(range ?? DEFAULT_OVERVIEW_RANGE);

  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [range]);

  if (isError) {
    return <MetricsUnavailable onRetry={() => void refetch()} retrying={isFetching} />;
  }

  const rows = metrics?.agingItems ?? [];
  const count = metrics?.agingCount ?? 0;

  return (
    <div>
      <ListIntro
        note={`Stuck in the same status > ${OVERVIEW_AGING_DAYS} days`}
        count={isLoading ? undefined : count}
      />
      {rows.length === 0 ? (
        <EmptyList>
          {isLoading ? "Counting..." : "Nothing stuck. Pipeline is flowing."}
        </EmptyList>
      ) : (
        <>
          <ul className="space-y-2 text-sm">
            {(showAll ? rows : rows.slice(0, PREVIEW_ROWS)).map((row) => (
              <AgingRow key={row.id} row={row} />
            ))}
          </ul>
          <ShowAllToggle
            shown={rows.length}
            total={count || rows.length}
            expanded={showAll}
            onToggle={() => setShowAll((v) => !v)}
            noun="aging items"
          />
        </>
      )}
    </div>
  );
}

// An aging row links to its item, the same as a stale row does. They were the
// same shape of row with only one of them clickable, so the fix for a stuck
// item was one click away on one card and a search away on the other.
function AgingRow({ row }: { row: OverviewAgingRow }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border p-2 hover:bg-muted/40">
      <div className="min-w-0 flex-1">
        <Link
          to={`/dashboard/flipdesk/items/${row.id}`}
          className="block truncate font-medium hover:underline"
        >
          {row.item_title}
        </Link>
        <div className="text-xs text-muted-foreground">
          {ITEM_STATUS_LABELS[row.status as ItemStatus] ?? row.status}
          {row.brand ? ` · ${row.brand}` : ""}
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-destructive">
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        {row.days}d
      </div>
    </li>
  );
}

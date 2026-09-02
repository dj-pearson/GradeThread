import { Link } from "react-router";
import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE, overviewRangeDef } from "@/lib/overview-range";
import { fmtMoney } from "@/lib/flipdesk-overview-format";
import {
  EmptyList,
  MetricsUnavailable,
} from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-2547, on the board (US-3076): the last six items that sold in the window,
// with what each one actually netted under the price it went for.

export function FlipdeskRecentSalesWidget({ range }: WidgetProps) {
  const rangeId = range ?? DEFAULT_OVERVIEW_RANGE;
  const rangeDef = overviewRangeDef(rangeId);
  const { data: metrics, isLoading, isError, isFetching, refetch } =
    useFlipdeskOverview(rangeId);

  if (isError) {
    return <MetricsUnavailable onRetry={() => void refetch()} retrying={isFetching} />;
  }

  const sales = metrics?.recentSales ?? [];

  if (sales.length === 0) {
    return (
      <EmptyList>
        {isLoading ? "Looking..." : `No sales ${rangeDef.phrase}.`}
      </EmptyList>
    );
  }

  return (
    <ul className="divide-y">
      {sales.map((it) => (
        <li
          key={it.id}
          className="flex items-center justify-between gap-3 py-2 text-sm"
        >
          <div className="min-w-0 flex-1">
            <Link
              to={`/dashboard/flipdesk/items/${it.id}`}
              className="block truncate font-medium hover:underline"
            >
              {it.item_title}
            </Link>
            <div className="text-xs text-muted-foreground">
              {it.sale_date?.slice(0, 10)}
              {it.brand ? ` · ${it.brand}` : ""}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm tabular-nums">
              {fmtMoney(it.sale_price)}
            </div>
            {it.net_profit != null && (
              <div className="font-mono text-xs tabular-nums text-muted-foreground">
                net {fmtMoney(it.net_profit)}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

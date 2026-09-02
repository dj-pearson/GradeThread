import { useFlipdeskOverview } from "@/hooks/use-flipdesk-overview";
import { DEFAULT_OVERVIEW_RANGE, overviewRangeDef } from "@/lib/overview-range";
import { fmtMoney } from "@/lib/flipdesk-overview-format";
import {
  EmptyList,
  MetricsUnavailable,
} from "@/components/dashboard/widgets/flipdesk-shared";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-2547, on the board (US-3076): net profit per brand on items sold in the
// window. Range-aware, so the frame carries the picker's phrase and the empty
// state names the same window rather than saying "no brands" flatly.

export function FlipdeskTopBrandsWidget({ range }: WidgetProps) {
  const rangeId = range ?? DEFAULT_OVERVIEW_RANGE;
  const rangeDef = overviewRangeDef(rangeId);
  const { data: metrics, isLoading, isError, isFetching, refetch } =
    useFlipdeskOverview(rangeId);

  if (isError) {
    return <MetricsUnavailable onRetry={() => void refetch()} retrying={isFetching} />;
  }

  const brands = metrics?.topBrands ?? [];

  if (brands.length === 0) {
    return (
      <EmptyList>
        {isLoading
          ? "Adding it up..."
          : `No sold items with brand + net profit ${rangeDef.phrase}.`}
      </EmptyList>
    );
  }

  return (
    <ul className="space-y-2 text-sm">
      {brands.map((b) => (
        <li
          key={b.brand}
          className="flex items-center justify-between rounded-md border p-2 hover:bg-muted/40"
        >
          <div>
            <div className="font-medium">{b.brand}</div>
            <div className="text-xs text-muted-foreground">{b.sold} sold</div>
          </div>
          <div className="font-mono tabular-nums">{fmtMoney(b.profit)}</div>
        </li>
      ))}
    </ul>
  );
}

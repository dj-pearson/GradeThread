import { useState } from "react";
import { BarChart3 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useReturnAnalytics, type ReturnSlice } from "@/hooks/use-ebay";

// US-2936: what returns cost, sliced by things only GradeThread knows.
//
// Every marketplace shows a seller their return rate. None of them knows what
// condition the item was in when it went out, because none of them graded it.
// So the row that matters here is not "your return rate is 6%" — it is the
// disclosure comparison, which answers a question a seller can act on this
// afternoon: does saying what is wrong with a garment cost you sales, or save
// you returns?
//
// ── EVERY RATE CARRIES ITS DENOMINATOR ──────────────────────────────────────
//
// Three returns out of four sales and three out of three hundred are the same
// numerator and opposite businesses. A slice under the server's minimum shows
// "not enough sales yet" as words, never a percentage — a seller who reprices a
// brand off 1-in-2 has been misled by their own tool.

const WINDOWS = [30, 90, 180] as const;

function pct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function SliceTable({
  title,
  caption,
  slices,
  minSales,
}: {
  title: string;
  caption?: string;
  slices: ReturnSlice[];
  minSales: number;
}) {
  if (slices.length === 0) return null;
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
      </div>
      {/* Wide content scrolls inside its own container; the page body never does. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-normal">{title}</th>
              <th className="py-1.5 pr-3 font-normal">Sales</th>
              <th className="py-1.5 pr-3 font-normal">Returns</th>
              <th className="py-1.5 pr-3 font-normal">Rate</th>
              <th className="py-1.5 pr-3 font-normal">Not as described</th>
              <th className="py-1.5 font-normal">Days to settle</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => (
              <tr key={s.key} className="border-b last:border-0">
                <td className="py-1.5 pr-3">{s.key}</td>
                <td className="py-1.5 pr-3 tabular-nums">{s.sales}</td>
                <td className="py-1.5 pr-3 tabular-nums">{s.returns}</td>
                <td className="py-1.5 pr-3 tabular-nums">
                  {s.rate == null
                    ? (
                      <span className="text-xs text-muted-foreground">
                        under {minSales} sales
                      </span>
                    )
                    : pct(s.rate)}
                </td>
                <td className="py-1.5 pr-3 tabular-nums">{pct(s.snadShare)}</td>
                <td className="py-1.5 tabular-nums">
                  {s.avgDaysToResolve == null ? "—" : s.avgDaysToResolve}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ReturnAnalyticsCard() {
  const [days, setDays] = useState<number>(90);
  const { data, isLoading, isError } = useReturnAnalytics(days);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            What returns cost you
          </span>
          <span className="flex gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w}
                size="sm"
                variant={w === days ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs font-normal"
                onClick={() => setDays(w)}
              >
                {w}d
              </Button>
            ))}
          </span>
        </CardTitle>
        <CardDescription>
          Your own sales only. eBay cases, over the last {days} days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : isError ? (
          <EmptyState
            className="py-8"
            icon={BarChart3}
            title="Couldn't build the numbers."
            description="Try again in a moment."
          />
        ) : !data || data.overall.sales === 0 ? (
          <EmptyState
            className="py-8"
            icon={BarChart3}
            title="No sales in this window yet."
            description="Return rates need sales to divide by."
          />
        ) : (
          <>
            <div className="flex flex-wrap gap-6">
              <div>
                <p className="text-xs text-muted-foreground">Sales</p>
                <p className="text-lg font-semibold tabular-nums">{data.overall.sales}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Returns</p>
                <p className="text-lg font-semibold tabular-nums">{data.overall.returns}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Return rate</p>
                <p className="text-lg font-semibold tabular-nums">
                  {data.overall.rate == null
                    ? `under ${data.minSalesForRate} sales`
                    : pct(data.overall.rate)}
                </p>
              </div>
            </div>

            {data.truncated && (
              <p className="text-xs text-muted-foreground">
                This window has more sales than we read in one go, so these numbers
                cover the most recent ones only.
              </p>
            )}

            {/* First, because it is the only slice a seller can act on today. */}
            <SliceTable
              title="Disclosure"
              caption="Items where your published listing named a flaw your grade report found, against items where it named none. Items with no grade report are in neither row."
              slices={data.byDisclosure}
              minSales={data.minSalesForRate}
            />
            <SliceTable
              title="Grade"
              slices={data.byGradeBand}
              minSales={data.minSalesForRate}
            />
            <SliceTable
              title="Brand"
              slices={data.byBrand}
              minSales={data.minSalesForRate}
            />
            <SliceTable
              title="Category"
              slices={data.byCategory}
              minSales={data.minSalesForRate}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

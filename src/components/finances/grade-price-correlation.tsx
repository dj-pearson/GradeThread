import { useMemo } from "react";
import type {
  FinGradePoint,
  FinTierStat,
  FinCategoryTier,
} from "@/lib/finances-dashboard";
import { CHART_PALETTE } from "@/lib/constants";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Lightbulb, ScatterChart as ScatterIcon } from "lucide-react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

interface GradePriceCorrelationProps {
  points: FinGradePoint[];
  pointsTotal: number;
  tierStats: FinTierStat[];
  categoryTier: FinCategoryTier[];
  isLoading: boolean;
}

export function GradePriceCorrelation({
  points,
  pointsTotal,
  tierStats,
  categoryTier,
  isLoading,
}: GradePriceCorrelationProps) {
  const { activeTiers, categoryRows, insight } = useMemo(() => {
    const activeTiers = tierStats.map((t) => t.label);

    // Pivot the per-(category, tier) average prices into one row per category.
    const catMap = new Map<string, Record<string, number | null>>();
    for (const row of categoryTier) {
      const byTier = catMap.get(row.category) ?? {};
      byTier[row.tier] = row.avg_price;
      catMap.set(row.category, byTier);
    }
    const categoryRows = Array.from(catMap.entries())
      .map(([category, byTier]) => ({
        category,
        avgByTier: Object.fromEntries(
          activeTiers.map((tier) => [tier, byTier[tier] ?? null])
        ) as Record<string, number | null>,
      }))
      .sort((a, b) => a.category.localeCompare(b.category));

    // Insight: Excellent vs Good average price.
    const excellent = tierStats.find((t) => t.label === "Excellent");
    const good = tierStats.find((t) => t.label === "Good");
    let insight: string | null = null;
    if (excellent && good && good.avg_price > 0) {
      const diff = ((excellent.avg_price - good.avg_price) / good.avg_price) * 100;
      if (diff >= 0) {
        insight = `Items graded Excellent sell for ${diff.toFixed(
          0
        )}% more on average than items graded Good (${formatCurrency(
          excellent.avg_price
        )} vs ${formatCurrency(good.avg_price)}).`;
      } else {
        insight = `Items graded Excellent sell for ${Math.abs(diff).toFixed(
          0
        )}% less on average than items graded Good — worth a closer look at your pricing.`;
      }
    }

    return { activeTiers, categoryRows, insight };
  }, [tierStats, categoryTier]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (pointsTotal === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <ScatterIcon className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">
            No graded sales yet
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Sell some graded items to see how condition grades correlate with
            sale prices.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Scatter plot with fitted trendline */}
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Grade vs Sale Price</CardTitle>
            <CardDescription>
              Each point is a sold item ({pointsTotal} total
              {points.length < pointsTotal
                ? `, showing ${points.length} most recent`
                : ""}
              ); the line is a fitted price/grade trend.
            </CardDescription>
          </div>
          <ScatterIcon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 10, right: 16, bottom: 10, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                type="number"
                dataKey="grade"
                name="Grade"
                domain={[1, 10]}
                ticks={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="number"
                dataKey="price"
                name="Sale Price"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `$${v}`}
              />
              <ZAxis range={[60, 60]} />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                contentStyle={TOOLTIP_STYLE}
                formatter={(value, name) =>
                  name === "Sale Price"
                    ? [formatCurrency(Number(value)), name]
                    : [value, name]
                }
              />
              <Scatter
                name="Sold items"
                data={points}
                fill={CHART_PALETTE.navy}
                fillOpacity={0.65}
                line={{ stroke: CHART_PALETTE.red, strokeWidth: 2 }}
                lineType="fitting"
              />
            </ScatterChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Insight */}
      {insight && (
        <div className="lg:col-span-2 flex items-start gap-3 rounded-lg border bg-muted/40 p-4">
          <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-brand-red-text" />
          <p className="text-sm">{insight}</p>
        </div>
      )}

      {/* Per-tier summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">By Grade Tier</CardTitle>
          <CardDescription>
            Average sale price and profit per condition tier.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Avg Price</TableHead>
                  <TableHead className="text-right">Avg Profit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tierStats.map((t) => (
                  <TableRow key={t.label}>
                    <TableCell className="font-medium">{t.label}</TableCell>
                    <TableCell className="text-right">{t.count}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(t.avg_price)}
                    </TableCell>
                    <TableCell
                      className={
                        t.avg_profit < 0
                          ? "text-right text-red-600 dark:text-red-400"
                          : "text-right text-green-600 dark:text-green-400"
                      }
                    >
                      {formatCurrency(t.avg_profit)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Category × tier average price */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Avg Price by Category</CardTitle>
          <CardDescription>
            Average sale price per grade tier, broken down by category.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  {activeTiers.map((tier) => (
                    <TableHead key={tier} className="text-right">
                      {tier}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {categoryRows.map((row) => (
                  <TableRow key={row.category}>
                    <TableCell className="font-medium">
                      {row.category}
                    </TableCell>
                    {activeTiers.map((tier) => {
                      const value = row.avgByTier[tier];
                      return (
                        <TableCell key={tier} className="text-right">
                          {value === null || value === undefined
                            ? "—"
                            : formatCurrency(value)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

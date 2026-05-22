import { useMemo } from "react";
import type { InventoryItemRow, SaleRow } from "@/types/database";
import { computePnl } from "@/lib/pnl";
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

// Condition tiers, ordered worst → best. A grade maps to the tier whose
// floor it clears (grades round to the nearest tier integer).
const GRADE_TIERS = [
  { label: "Poor", floor: 0 },
  { label: "Fair", floor: 4.5 },
  { label: "Good", floor: 5.5 },
  { label: "Very Good", floor: 6.5 },
  { label: "Excellent", floor: 7.5 },
  { label: "NWOT", floor: 8.5 },
  { label: "NWT", floor: 9.5 },
] as const;

function tierFor(grade: number): string {
  let label: string = GRADE_TIERS[0].label;
  for (const tier of GRADE_TIERS) {
    if (grade >= tier.floor) label = tier.label;
  }
  return label;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

interface Point {
  grade: number;
  price: number;
  profit: number;
  category: string;
}

interface TierStat {
  label: string;
  count: number;
  avgPrice: number;
  avgProfit: number;
}

interface GradePriceCorrelationProps {
  items: InventoryItemRow[];
  sales: SaleRow[];
  isLoading: boolean;
}

export function GradePriceCorrelation({
  items,
  sales,
  isLoading,
}: GradePriceCorrelationProps) {
  const { points, tierStats, categoryRows, activeTiers, insight } = useMemo(() => {
    const itemById = new Map<string, InventoryItemRow>();
    for (const item of items) itemById.set(item.id, item);

    const points: Point[] = [];
    for (const sale of sales) {
      const item = itemById.get(sale.inventory_item_id);
      if (!item || item.grade_value === null || item.grade_value === undefined) {
        continue;
      }
      points.push({
        grade: item.grade_value,
        price: sale.sale_price,
        profit: computePnl(sale, item.acquired_price ?? 0).net,
        category: item.garment_category
          ? item.garment_category.charAt(0).toUpperCase() +
            item.garment_category.slice(1)
          : "Uncategorized",
      });
    }

    // ── Per-tier aggregates ──
    const tierMap = new Map<
      string,
      { count: number; price: number; profit: number }
    >();
    for (const p of points) {
      const tier = tierFor(p.grade);
      const acc = tierMap.get(tier) ?? { count: 0, price: 0, profit: 0 };
      acc.count += 1;
      acc.price += p.price;
      acc.profit += p.profit;
      tierMap.set(tier, acc);
    }
    const tierStats: TierStat[] = GRADE_TIERS.map((t) => t.label)
      .map((label) => {
        const acc = tierMap.get(label);
        return {
          label,
          count: acc?.count ?? 0,
          avgPrice: acc && acc.count > 0 ? acc.price / acc.count : 0,
          avgProfit: acc && acc.count > 0 ? acc.profit / acc.count : 0,
        };
      })
      .filter((t) => t.count > 0);

    const activeTiers = tierStats.map((t) => t.label);

    // ── Category × tier average sale price ──
    const catMap = new Map<string, Map<string, { count: number; price: number }>>();
    for (const p of points) {
      const tier = tierFor(p.grade);
      const byTier = catMap.get(p.category) ?? new Map();
      const acc = byTier.get(tier) ?? { count: 0, price: 0 };
      acc.count += 1;
      acc.price += p.price;
      byTier.set(tier, acc);
      catMap.set(p.category, byTier);
    }
    const categoryRows = Array.from(catMap.entries())
      .map(([category, byTier]) => ({
        category,
        avgByTier: Object.fromEntries(
          activeTiers.map((tier) => {
            const acc = byTier.get(tier);
            return [tier, acc && acc.count > 0 ? acc.price / acc.count : null];
          })
        ) as Record<string, number | null>,
      }))
      .sort((a, b) => a.category.localeCompare(b.category));

    // ── Insight: Excellent vs Good ──
    const excellent = tierStats.find((t) => t.label === "Excellent");
    const good = tierStats.find((t) => t.label === "Good");
    let insight: string | null = null;
    if (excellent && good && good.avgPrice > 0) {
      const diff =
        ((excellent.avgPrice - good.avgPrice) / good.avgPrice) * 100;
      if (diff >= 0) {
        insight = `Items graded Excellent sell for ${diff.toFixed(
          0
        )}% more on average than items graded Good (${formatCurrency(
          excellent.avgPrice
        )} vs ${formatCurrency(good.avgPrice)}).`;
      } else {
        insight = `Items graded Excellent sell for ${Math.abs(diff).toFixed(
          0
        )}% less on average than items graded Good — worth a closer look at your pricing.`;
      }
    }

    return { points, tierStats, categoryRows, activeTiers, insight };
  }, [items, sales]);

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

  if (points.length === 0) {
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
              Each point is a sold item ({points.length} total); the line is a
              fitted price/grade trend.
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
                fill="#0F3460"
                fillOpacity={0.65}
                line={{ stroke: "#E94560", strokeWidth: 2 }}
                lineType="fitting"
              />
            </ScatterChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Insight */}
      {insight && (
        <div className="lg:col-span-2 flex items-start gap-3 rounded-lg border bg-muted/40 p-4">
          <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-[#E94560]" />
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
                      {formatCurrency(t.avgPrice)}
                    </TableCell>
                    <TableCell
                      className={
                        t.avgProfit < 0
                          ? "text-right text-red-600"
                          : "text-right text-green-600"
                      }
                    >
                      {formatCurrency(t.avgProfit)}
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

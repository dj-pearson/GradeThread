import { useMemo } from "react";
import type { FinRoiGroup, FinItemRoi } from "@/lib/finances-dashboard";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TrendingUp, TrendingDown, PieChart } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

const BAR_COLORS = ["#0F3460", "#3b82f6", "#6366f1", "#8b5cf6", "#a78bfa"];

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

function formatRoi(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

interface RoiGroup {
  name: string;
  itemsSold: number;
  totalProfit: number;
  totalCostBasis: number;
  roiPct: number | null;
}

interface RoiAnalyticsProps {
  byBrand: FinRoiGroup[];
  byCategory: FinRoiGroup[];
  bySource: FinRoiGroup[];
  bestItems: FinItemRoi[];
  worstItems: FinItemRoi[];
  isLoading: boolean;
}

// Server returns summed profit/cost-basis per group; derive the ROI % here.
function toGroups(rows: FinRoiGroup[]): RoiGroup[] {
  return rows.map((g) => ({
    name: g.name,
    itemsSold: g.items_sold,
    totalProfit: g.total_profit,
    totalCostBasis: g.total_cost_basis,
    roiPct: g.total_cost_basis > 0 ? (g.total_profit / g.total_cost_basis) * 100 : null,
  }));
}

function RoiTable({
  groups,
  groupLabel,
}: {
  groups: RoiGroup[];
  groupLabel: string;
}) {
  const chartData = useMemo(
    () =>
      [...groups]
        .filter((g) => g.roiPct !== null)
        .sort((a, b) => (b.roiPct ?? 0) - (a.roiPct ?? 0))
        .slice(0, 8)
        .map((g) => ({
          name: g.name.length > 14 ? `${g.name.slice(0, 13)}…` : g.name,
          roi: Math.round((g.roiPct ?? 0) * 10) / 10,
        })),
    [groups]
  );

  if (groups.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No sales data for this period.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={Math.max(160, chartData.length * 36)}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 5, right: 16, bottom: 5, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              type="number"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}%`}
            />
            <YAxis
              type="category"
              dataKey="name"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={90}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value) => [`${Number(value).toFixed(1)}%`, "ROI"]}
            />
            <Bar dataKey="roi" radius={[0, 4, 4, 0]}>
              {chartData.map((entry, index) => (
                <Cell
                  key={index}
                  fill={
                    entry.roi >= 0
                      ? BAR_COLORS[index % BAR_COLORS.length]
                      : "#E94560"
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{groupLabel}</TableHead>
              <TableHead className="text-right">Items Sold</TableHead>
              <TableHead className="text-right">ROI %</TableHead>
              <TableHead className="text-right">Total Profit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <TableRow key={g.name}>
                <TableCell className="font-medium">{g.name}</TableCell>
                <TableCell className="text-right">{g.itemsSold}</TableCell>
                <TableCell
                  className={
                    g.roiPct !== null && g.roiPct < 0
                      ? "text-right text-red-600 dark:text-red-400"
                      : "text-right text-green-600 dark:text-green-400"
                  }
                >
                  {formatRoi(g.roiPct)}
                </TableCell>
                <TableCell
                  className={
                    g.totalProfit < 0
                      ? "text-right text-red-600 dark:text-red-400"
                      : "text-right"
                  }
                >
                  {formatCurrency(g.totalProfit)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ItemRoiTable({
  items,
  emptyText,
}: {
  items: FinItemRoi[];
  emptyText: string;
}) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {emptyText}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Profit</TableHead>
            <TableHead className="text-right">ROI %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <div className="font-medium">{item.title}</div>
                <div className="text-xs text-muted-foreground">
                  {item.detail}
                </div>
              </TableCell>
              <TableCell className="text-right">
                {formatCurrency(item.cost_basis)}
              </TableCell>
              <TableCell
                className={
                  item.profit < 0
                    ? "text-right text-red-600 dark:text-red-400"
                    : "text-right text-green-600 dark:text-green-400"
                }
              >
                {formatCurrency(item.profit)}
              </TableCell>
              <TableCell
                className={
                  item.roi_pct < 0
                    ? "text-right font-medium text-red-600 dark:text-red-400"
                    : "text-right font-medium text-green-600 dark:text-green-400"
                }
              >
                {formatRoi(item.roi_pct)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function RoiAnalytics({
  byBrand,
  byCategory,
  bySource,
  bestItems,
  worstItems,
  isLoading,
}: RoiAnalyticsProps) {
  const brandGroups = useMemo(() => toGroups(byBrand), [byBrand]);
  const categoryGroups = useMemo(() => toGroups(byCategory), [byCategory]);
  const sourceGroups = useMemo(() => toGroups(bySource), [bySource]);
  const hasData = byBrand.length > 0;

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

  if (!hasData) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <PieChart className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">No ROI data yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Record some sales to see which brands, categories, and sources
            yield the best returns.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">ROI Breakdown</CardTitle>
          <CardDescription>
            Return on investment by brand, category, and acquisition source.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="brand">
            <TabsList>
              <TabsTrigger value="brand">By Brand</TabsTrigger>
              <TabsTrigger value="category">By Category</TabsTrigger>
              <TabsTrigger value="source">By Source</TabsTrigger>
            </TabsList>
            <TabsContent value="brand" className="mt-4">
              <RoiTable groups={brandGroups} groupLabel="Brand" />
            </TabsContent>
            <TabsContent value="category" className="mt-4">
              <RoiTable groups={categoryGroups} groupLabel="Category" />
            </TabsContent>
            <TabsContent value="source" className="mt-4">
              <RoiTable groups={sourceGroups} groupLabel="Source" />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Best Performers</CardTitle>
            <CardDescription>Top 10 items by ROI</CardDescription>
          </div>
          <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
        </CardHeader>
        <CardContent>
          <ItemRoiTable
            items={bestItems}
            emptyText="No items with a recorded cost basis."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Worst Performers</CardTitle>
            <CardDescription>Bottom 10 items by ROI</CardDescription>
          </div>
          <TrendingDown className="h-4 w-4 text-red-600 dark:text-red-400" />
        </CardHeader>
        <CardContent>
          <ItemRoiTable
            items={worstItems}
            emptyText="No items with a recorded cost basis."
          />
        </CardContent>
      </Card>
    </div>
  );
}

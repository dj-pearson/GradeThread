import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  InventoryItemRow,
  SaleRow,
  SourceRow,
} from "@/types/database";
import { supabase } from "@/lib/supabase";
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

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface RoiGroup {
  name: string;
  itemsSold: number;
  totalProfit: number;
  totalCostBasis: number;
  roiPct: number | null;
}

interface ItemRoi {
  id: string;
  title: string;
  detail: string;
  profit: number;
  costBasis: number;
  roiPct: number;
}

interface RoiAnalyticsProps {
  items: InventoryItemRow[];
  sales: SaleRow[];
  periodStart: string | null;
  isLoading: boolean;
}

function buildGroups(
  rows: { key: string; profit: number; costBasis: number }[]
): RoiGroup[] {
  const map = new Map<string, RoiGroup>();
  for (const row of rows) {
    const group =
      map.get(row.key) ??
      ({
        name: row.key,
        itemsSold: 0,
        totalProfit: 0,
        totalCostBasis: 0,
        roiPct: null,
      } as RoiGroup);
    group.itemsSold += 1;
    group.totalProfit += row.profit;
    group.totalCostBasis += row.costBasis;
    map.set(row.key, group);
  }
  return Array.from(map.values())
    .map((g) => ({
      ...g,
      roiPct:
        g.totalCostBasis > 0
          ? (g.totalProfit / g.totalCostBasis) * 100
          : null,
    }))
    .sort((a, b) => b.totalProfit - a.totalProfit);
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
                      ? "text-right text-red-600"
                      : "text-right text-green-600"
                  }
                >
                  {formatRoi(g.roiPct)}
                </TableCell>
                <TableCell
                  className={
                    g.totalProfit < 0
                      ? "text-right text-red-600"
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
  items: ItemRoi[];
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
                {formatCurrency(item.costBasis)}
              </TableCell>
              <TableCell
                className={
                  item.profit < 0
                    ? "text-right text-red-600"
                    : "text-right text-green-600"
                }
              >
                {formatCurrency(item.profit)}
              </TableCell>
              <TableCell
                className={
                  item.roiPct < 0
                    ? "text-right font-medium text-red-600"
                    : "text-right font-medium text-green-600"
                }
              >
                {formatRoi(item.roiPct)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function RoiAnalytics({
  items,
  sales,
  periodStart,
  isLoading,
}: RoiAnalyticsProps) {
  const { data: sources } = useQuery({
    queryKey: ["roi-sources"],
    queryFn: async (): Promise<SourceRow[]> => {
      const { data, error } = await supabase.from("sources").select("*");
      if (error) throw error;
      return (data ?? []) as SourceRow[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const analysis = useMemo(() => {
    const itemById = new Map<string, InventoryItemRow>();
    for (const item of items) itemById.set(item.id, item);

    const sourceById = new Map<string, SourceRow>();
    for (const s of sources ?? []) sourceById.set(s.id, s);

    const filteredSales = periodStart
      ? sales.filter((s) => s.sale_date >= periodStart)
      : sales;

    const brandRows: { key: string; profit: number; costBasis: number }[] = [];
    const categoryRows: { key: string; profit: number; costBasis: number }[] =
      [];
    const sourceRows: { key: string; profit: number; costBasis: number }[] = [];
    const itemRoi: ItemRoi[] = [];

    for (const sale of filteredSales) {
      const item = itemById.get(sale.inventory_item_id);
      const costBasis = item?.acquired_price ?? 0;
      const profit = computePnl(sale, costBasis).net;

      const brand = item?.brand?.trim() || "Unknown";
      const category = item?.garment_category
        ? titleCase(item.garment_category)
        : "Unknown";
      const source =
        (item?.source_id && sourceById.get(item.source_id)?.name) ||
        item?.acquired_source?.trim() ||
        "Unknown";

      brandRows.push({ key: brand, profit, costBasis });
      categoryRows.push({ key: category, profit, costBasis });
      sourceRows.push({ key: source, profit, costBasis });

      if (item && costBasis > 0) {
        itemRoi.push({
          id: sale.id,
          title: item.title,
          detail: [brand, category].filter((v) => v !== "Unknown").join(" · "),
          profit,
          costBasis,
          roiPct: (profit / costBasis) * 100,
        });
      }
    }

    const ranked = [...itemRoi].sort((a, b) => b.roiPct - a.roiPct);
    const bestItems = ranked.slice(0, 10);
    const worstItems = ranked
      .slice(-10)
      .reverse()
      .filter((i) => !bestItems.includes(i));

    return {
      byBrand: buildGroups(brandRows),
      byCategory: buildGroups(categoryRows),
      bySource: buildGroups(sourceRows),
      bestItems,
      worstItems,
      hasData: filteredSales.length > 0,
    };
  }, [items, sales, sources, periodStart]);

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

  if (!analysis.hasData) {
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
              <RoiTable groups={analysis.byBrand} groupLabel="Brand" />
            </TabsContent>
            <TabsContent value="category" className="mt-4">
              <RoiTable groups={analysis.byCategory} groupLabel="Category" />
            </TabsContent>
            <TabsContent value="source" className="mt-4">
              <RoiTable groups={analysis.bySource} groupLabel="Source" />
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
          <TrendingUp className="h-4 w-4 text-green-600" />
        </CardHeader>
        <CardContent>
          <ItemRoiTable
            items={analysis.bestItems}
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
          <TrendingDown className="h-4 w-4 text-red-600" />
        </CardHeader>
        <CardContent>
          <ItemRoiTable
            items={analysis.worstItems}
            emptyText="No items with a recorded cost basis."
          />
        </CardContent>
      </Card>
    </div>
  );
}

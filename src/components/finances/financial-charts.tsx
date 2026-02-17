import { useState, useMemo } from "react";
import type { InventoryItemRow, SaleRow, ShipmentRow } from "@/types/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart3,
  TrendingUp,
  PieChart as PieChartIcon,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

type Granularity = "daily" | "weekly" | "monthly";

const CHART_COLORS = {
  revenue: "#22c55e",
  profit: "#0F3460",
  loss: "#E94560",
};

const PIE_COLORS = ["#0F3460", "#E94560", "#f59e0b", "#3b82f6", "#8b5cf6"];

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

function formatDateLabel(date: Date, granularity: Granularity): string {
  switch (granularity) {
    case "daily":
      return `${date.getMonth() + 1}/${date.getDate()}`;
    case "weekly":
      return `${date.getMonth() + 1}/${date.getDate()}`;
    case "monthly":
      return date.toLocaleString("en-US", { month: "short", year: "2-digit" });
  }
}

function getBucketKey(date: Date, granularity: Granularity): string {
  switch (granularity) {
    case "daily":
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    case "weekly": {
      // Start of week (Sunday)
      const d = new Date(date);
      d.setDate(d.getDate() - d.getDay());
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    case "monthly":
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
}

interface FinancialChartsProps {
  items: InventoryItemRow[];
  sales: SaleRow[];
  shipments: ShipmentRow[];
  periodStart: string | null;
  isLoading: boolean;
}

interface TimeSeriesPoint {
  label: string;
  sortKey: string;
  revenue: number;
  profit: number;
}

export function FinancialCharts({
  items,
  sales,
  shipments,
  periodStart,
  isLoading,
}: FinancialChartsProps) {
  const [granularity, setGranularity] = useState<Granularity>("weekly");

  const { timeSeries, costBreakdown, topBrands, topCategories, hasData } = useMemo(() => {
    if (!sales.length) {
      return { timeSeries: [], costBreakdown: [], topBrands: [], topCategories: [], hasData: false };
    }

    // Build lookup maps
    const shipmentBySaleId = new Map<string, ShipmentRow>();
    for (const s of shipments) {
      shipmentBySaleId.set(s.sale_id, s);
    }

    const itemById = new Map<string, InventoryItemRow>();
    for (const item of items) {
      itemById.set(item.id, item);
    }

    // Filter sales by period
    const filteredSales = periodStart
      ? sales.filter((s) => s.sale_date >= periodStart)
      : sales;

    if (!filteredSales.length) {
      return { timeSeries: [], costBreakdown: [], topBrands: [], topCategories: [], hasData: false };
    }

    // ── Time series: revenue & profit over time ──
    const buckets = new Map<string, { label: string; revenue: number; costs: number }>();

    for (const sale of filteredSales) {
      const saleDate = new Date(sale.sale_date);
      const key = getBucketKey(saleDate, granularity);
      const label = formatDateLabel(saleDate, granularity);

      const existing = buckets.get(key) ?? { label, revenue: 0, costs: 0 };
      existing.revenue += sale.sale_price;

      const item = itemById.get(sale.inventory_item_id);
      existing.costs += item?.acquired_price ?? 0;
      existing.costs += sale.platform_fees;

      const shipment = shipmentBySaleId.get(sale.id);
      if (shipment) {
        existing.costs += shipment.shipping_cost + shipment.label_cost;
      }

      buckets.set(key, existing);
    }

    const timeSeries: TimeSeriesPoint[] = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sortKey, bucket]) => ({
        label: bucket.label,
        sortKey,
        revenue: Math.round(bucket.revenue * 100) / 100,
        profit: Math.round((bucket.revenue - bucket.costs) * 100) / 100,
      }));

    // ── Cost breakdown pie chart ──
    let totalAcquisition = 0;
    let totalShipping = 0;
    let totalPlatformFees = 0;

    for (const sale of filteredSales) {
      const item = itemById.get(sale.inventory_item_id);
      totalAcquisition += item?.acquired_price ?? 0;
      totalPlatformFees += sale.platform_fees;

      const shipment = shipmentBySaleId.get(sale.id);
      if (shipment) {
        totalShipping += shipment.shipping_cost + shipment.label_cost;
      }
    }

    const costBreakdown = [
      { name: "Acquisition", value: Math.round(totalAcquisition * 100) / 100 },
      { name: "Shipping", value: Math.round(totalShipping * 100) / 100 },
      { name: "Platform Fees", value: Math.round(totalPlatformFees * 100) / 100 },
      { name: "Grading Fees", value: 0 },
    ].filter((c) => c.value > 0);

    // ── Top 5 brands by profit ──
    const brandProfit = new Map<string, number>();
    for (const sale of filteredSales) {
      const item = itemById.get(sale.inventory_item_id);
      const brand = item?.brand ?? "Unknown";

      let costs = (item?.acquired_price ?? 0) + sale.platform_fees;
      const shipment = shipmentBySaleId.get(sale.id);
      if (shipment) costs += shipment.shipping_cost + shipment.label_cost;

      const profit = sale.sale_price - costs;
      brandProfit.set(brand, (brandProfit.get(brand) ?? 0) + profit);
    }

    const topBrands = Array.from(brandProfit.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({
        name,
        value: Math.round(value * 100) / 100,
      }));

    // ── Top 5 categories by profit ──
    const categoryProfit = new Map<string, number>();
    for (const sale of filteredSales) {
      const item = itemById.get(sale.inventory_item_id);
      const category = item?.garment_category ?? "Unknown";
      const displayCategory = category.charAt(0).toUpperCase() + category.slice(1);

      let costs = (item?.acquired_price ?? 0) + sale.platform_fees;
      const shipment = shipmentBySaleId.get(sale.id);
      if (shipment) costs += shipment.shipping_cost + shipment.label_cost;

      const profit = sale.sale_price - costs;
      categoryProfit.set(displayCategory, (categoryProfit.get(displayCategory) ?? 0) + profit);
    }

    const topCategories = Array.from(categoryProfit.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({
        name,
        value: Math.round(value * 100) / 100,
      }));

    return { timeSeries, costBreakdown, topBrands, topCategories, hasData: true };
  }, [items, sales, shipments, periodStart, granularity]);

  if (isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className={i === 0 ? "lg:col-span-2" : ""}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-60" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-[250px] w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!hasData) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <BarChart3 className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">No chart data yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Record some sales to see your financial charts here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Revenue & Profit Over Time */}
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Revenue & Profit Over Time</CardTitle>
            <CardDescription>Revenue and profit trends for the selected period</CardDescription>
          </div>
          <div className="flex items-center gap-1">
            {(["daily", "weekly", "monthly"] as const).map((g) => (
              <Button
                key={g}
                variant={granularity === g ? "default" : "outline"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setGranularity(g)}
              >
                {g.charAt(0).toUpperCase() + g.slice(1)}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={timeSeries} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="label"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `$${v}`}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value, name) => [
                  formatCurrency(Number(value)),
                  name === "revenue" ? "Revenue" : "Profit",
                ]}
              />
              <Legend
                formatter={(value) => (value === "revenue" ? "Revenue" : "Profit")}
              />
              <Line
                type="monotone"
                dataKey="revenue"
                stroke={CHART_COLORS.revenue}
                strokeWidth={2}
                dot={{ r: 3, fill: CHART_COLORS.revenue }}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="profit"
                stroke={CHART_COLORS.profit}
                strokeWidth={2}
                dot={{ r: 3, fill: CHART_COLORS.profit }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Cost Breakdown Pie Chart */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Cost Breakdown</CardTitle>
            <CardDescription>Where your money goes</CardDescription>
          </div>
          <PieChartIcon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={costBreakdown}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={90}
                paddingAngle={2}
                dataKey="value"
                label={({ name, percent }) =>
                  `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                }
                labelLine={true}
                fontSize={11}
              >
                {costBreakdown.map((_, index) => (
                  <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value) => [formatCurrency(Number(value))]}
              />
              <Legend fontSize={12} />
            </PieChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Top 5 Brands by Profit */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Top 5 Brands by Profit</CardTitle>
            <CardDescription>Most profitable brands</CardDescription>
          </div>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={topBrands}
              layout="vertical"
              margin={{ top: 5, right: 5, bottom: 5, left: 60 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                type="number"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `$${v}`}
              />
              <YAxis
                type="category"
                dataKey="name"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={55}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value) => [formatCurrency(Number(value)), "Profit"]}
              />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {topBrands.map((_, index) => (
                  <Cell key={index} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Top 5 Categories by Profit */}
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Top 5 Categories by Profit</CardTitle>
            <CardDescription>Most profitable garment categories</CardDescription>
          </div>
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={topCategories} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="name"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `$${v}`}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value) => [formatCurrency(Number(value)), "Profit"]}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {topCategories.map((_, index) => (
                  <Cell key={index} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

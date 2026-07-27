import { useState, useMemo } from "react";
import type { FinTimePoint, FinCostBreakdown, FinNameValue } from "@/lib/finances-dashboard";
import { CHART_PALETTE } from "@/lib/constants";
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
  revenue: CHART_PALETTE.green,
  profit: CHART_PALETTE.navy,
  loss: CHART_PALETTE.red,
};

const PIE_COLORS = [
  CHART_PALETTE.navy,
  CHART_PALETTE.red,
  CHART_PALETTE.amber,
  CHART_PALETTE.blue,
  CHART_PALETTE.violet,
];

const BAR_COLORS = [
  CHART_PALETTE.navy,
  CHART_PALETTE.blue,
  CHART_PALETTE.indigo,
  CHART_PALETTE.violet,
  CHART_PALETTE.violetLight,
];

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

// Parse a 'YYYY-MM-DD' day key (returned by the RPC) as a local date.
function parseDay(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, day ?? 1);
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
      const d = new Date(date);
      d.setDate(d.getDate() - d.getDay());
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    case "monthly":
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
}

interface FinancialChartsProps {
  timeSeries: FinTimePoint[];
  costBreakdown: FinCostBreakdown | null;
  topBrands: FinNameValue[];
  topCategories: FinNameValue[];
  isLoading: boolean;
}

interface TimeSeriesPoint {
  label: string;
  sortKey: string;
  revenue: number;
  profit: number;
}

export function FinancialCharts({
  timeSeries: dailySeries,
  costBreakdown,
  topBrands,
  topCategories,
  isLoading,
}: FinancialChartsProps) {
  const [granularity, setGranularity] = useState<Granularity>("weekly");

  // Server returns daily revenue/profit; re-bucket to weekly/monthly client-side
  // (cheap — the daily series is already aggregated and small).
  const timeSeries = useMemo<TimeSeriesPoint[]>(() => {
    const buckets = new Map<string, { label: string; revenue: number; profit: number }>();
    for (const pt of dailySeries) {
      const date = parseDay(pt.d);
      const key = getBucketKey(date, granularity);
      const label = formatDateLabel(date, granularity);
      const existing = buckets.get(key) ?? { label, revenue: 0, profit: 0 };
      existing.revenue += pt.revenue;
      existing.profit += pt.profit;
      buckets.set(key, existing);
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sortKey, b]) => ({
        label: b.label,
        sortKey,
        revenue: Math.round(b.revenue * 100) / 100,
        profit: Math.round(b.profit * 100) / 100,
      }));
  }, [dailySeries, granularity]);

  const costBreakdownData = useMemo(() => {
    if (!costBreakdown) return [];
    return [
      { name: "Acquisition", value: costBreakdown.acquisition },
      { name: "Shipping", value: costBreakdown.shipping },
      { name: "Platform Fees", value: costBreakdown.platform_fees },
      { name: "Grading Fees", value: costBreakdown.grading },
    ].filter((c) => c.value > 0);
  }, [costBreakdown]);

  const hasData = dailySeries.length > 0;

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
                data={costBreakdownData}
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
                {costBreakdownData.map((_, index) => (
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

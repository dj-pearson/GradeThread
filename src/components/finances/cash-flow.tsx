import { useState, useMemo } from "react";
import type { FinCfDaily, FinCfTxn } from "@/lib/finances-dashboard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowDownLeft, ArrowUpRight, BarChart3, List } from "lucide-react";
import { cn } from "@/lib/utils";
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
  ReferenceLine,
} from "recharts";

type ViewMode = "chart" | "table";

const COLORS = {
  inflow: "#22c55e",
  outflow: "#E94560",
  balance: "#0F3460",
};

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
    minimumFractionDigits: 2,
  }).format(value);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatShortDate(dateStr: string): string {
  const [, m, day] = dateStr.split("-").map(Number);
  return `${m}/${day}`;
}

interface ChartDataPoint {
  label: string;
  sortKey: string;
  inflow: number;
  outflow: number;
  balance: number;
}

interface CashFlowProps {
  daily: FinCfDaily[];
  recent: FinCfTxn[];
  recentTotal: number;
  isLoading: boolean;
}

export function CashFlow({ daily, recent, recentTotal, isLoading }: CashFlowProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("chart");

  // Server returns daily inflow/outflow buckets; compute the running balance
  // client-side (cheap — already aggregated).
  const chartData = useMemo<ChartDataPoint[]>(() => {
    let runningBalance = 0;
    return daily.map((b) => {
      runningBalance += b.inflow - b.outflow;
      return {
        label: formatShortDate(b.d),
        sortKey: b.d,
        inflow: b.inflow,
        outflow: b.outflow,
        balance: Math.round(runningBalance * 100) / 100,
      };
    });
  }, [daily]);

  const hasData = recentTotal > 0;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-60" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[350px] w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!hasData) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <BarChart3 className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">No cash flow data yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Record acquisitions and sales to see your cash flow timeline here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">Cash Flow Timeline</CardTitle>
          <CardDescription>
            Money in (sales) and money out (acquisitions, shipping, fees) over time
          </CardDescription>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={viewMode === "chart" ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setViewMode("chart")}
          >
            <BarChart3 className="mr-1 h-3 w-3" />
            Chart
          </Button>
          <Button
            variant={viewMode === "table" ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setViewMode("table")}
          >
            <List className="mr-1 h-3 w-3" />
            Table
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {viewMode === "chart" ? (
          <ChartView data={chartData} />
        ) : (
          <TableView transactions={recent} total={recentTotal} />
        )}
      </CardContent>
    </Card>
  );
}

function ChartView({ data }: { data: ChartDataPoint[] }) {
  return (
    <div className="space-y-6">
      {/* Combined bar chart: inflows vs outflows */}
      <div>
        <h4 className="mb-2 text-sm font-medium text-muted-foreground">
          Inflows & Outflows
        </h4>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
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
                name === "inflow" ? "Money In" : "Money Out",
              ]}
              labelFormatter={(label) => `Date: ${label}`}
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Bar dataKey="inflow" fill={COLORS.inflow} name="inflow" radius={[4, 4, 0, 0]} />
            <Bar dataKey="outflow" fill={COLORS.outflow} name="outflow" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Running balance line chart */}
      <div>
        <h4 className="mb-2 text-sm font-medium text-muted-foreground">
          Cumulative Cash Position
        </h4>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
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
              formatter={(value) => [formatCurrency(Number(value)), "Balance"]}
              labelFormatter={(label) => `Date: ${label}`}
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <Line
              type="monotone"
              dataKey="balance"
              stroke={COLORS.balance}
              strokeWidth={2}
              dot={{ r: 3, fill: COLORS.balance }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TableView({ transactions, total }: { transactions: FinCfTxn[]; total: number }) {
  let runningBalance = 0;

  const rows = transactions.map((txn, index) => {
    const signedAmount = txn.type === "inflow" ? txn.amount : -txn.amount;
    runningBalance += signedAmount;
    return { ...txn, signedAmount, runningBalance, index };
  });

  return (
    <div className="space-y-2">
      <div className="max-h-[500px] overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Date</TableHead>
              <TableHead className="w-[80px]">Type</TableHead>
              <TableHead className="w-[110px]">Category</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-[110px] text-right">Amount</TableHead>
              <TableHead className="w-[110px] text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.date}-${row.category}-${row.index}`}>
                <TableCell className="text-xs">{formatDate(row.date)}</TableCell>
                <TableCell>
                  {row.type === "inflow" ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
                      <ArrowDownLeft className="h-3 w-3" />
                      In
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
                      <ArrowUpRight className="h-3 w-3" />
                      Out
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs">{row.category}</TableCell>
                <TableCell className="max-w-[200px] truncate text-xs">
                  {row.description}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right text-xs font-medium",
                    row.type === "inflow" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                  )}
                >
                  {row.type === "inflow" ? "+" : "-"}
                  {formatCurrency(row.amount)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right text-xs font-medium",
                    row.runningBalance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                  )}
                >
                  {formatCurrency(row.runningBalance)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {total > transactions.length && (
        <p className="text-xs text-muted-foreground">
          Showing the {transactions.length} most recent of {total} transactions. The
          running balance reflects only the rows shown — use Export for the full
          ledger.
        </p>
      )}
    </div>
  );
}

import { useState, useMemo } from "react";
import type { InventoryItemRow, SaleRow, ShipmentRow } from "@/types/database";
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
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface Transaction {
  date: string;
  type: "inflow" | "outflow";
  category: string;
  description: string;
  amount: number;
}

interface ChartDataPoint {
  label: string;
  sortKey: string;
  inflow: number;
  outflow: number;
  balance: number;
}

interface CashFlowProps {
  items: InventoryItemRow[];
  sales: SaleRow[];
  shipments: ShipmentRow[];
  periodStart: string | null;
  isLoading: boolean;
}

export function CashFlow({
  items,
  sales,
  shipments,
  periodStart,
  isLoading,
}: CashFlowProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("chart");

  const { transactions, chartData, hasData } = useMemo(() => {
    const txns: Transaction[] = [];

    // Build lookup maps
    const itemById = new Map<string, InventoryItemRow>();
    for (const item of items) {
      itemById.set(item.id, item);
    }

    const shipmentBySaleId = new Map<string, ShipmentRow>();
    for (const s of shipments) {
      shipmentBySaleId.set(s.sale_id, s);
    }

    // Item acquisitions (outflow)
    for (const item of items) {
      if (item.acquired_price && item.acquired_date) {
        txns.push({
          date: item.acquired_date,
          type: "outflow",
          category: "Acquisition",
          description: item.title,
          amount: item.acquired_price,
        });
      }
    }

    // Sales revenue (inflow)
    for (const sale of sales) {
      const item = itemById.get(sale.inventory_item_id);
      txns.push({
        date: sale.sale_date,
        type: "inflow",
        category: "Sale",
        description: item?.title ?? "Item sale",
        amount: sale.sale_price,
      });

      // Platform fees (outflow) — recorded at sale date
      if (sale.platform_fees > 0) {
        txns.push({
          date: sale.sale_date,
          type: "outflow",
          category: "Platform Fees",
          description: `Fees for ${item?.title ?? "item sale"}`,
          amount: sale.platform_fees,
        });
      }
    }

    // Shipping costs (outflow)
    for (const shipment of shipments) {
      const totalShipping = shipment.shipping_cost + shipment.label_cost;
      if (totalShipping > 0 && shipment.ship_date) {
        // Find the related item title through the sale
        const relatedSale = sales.find((s) => s.id === shipment.sale_id);
        const item = relatedSale ? itemById.get(relatedSale.inventory_item_id) : undefined;
        txns.push({
          date: shipment.ship_date,
          type: "outflow",
          category: "Shipping",
          description: `Shipping for ${item?.title ?? "item"}`,
          amount: totalShipping,
        });
      }
    }

    // Sort all transactions chronologically
    txns.sort((a, b) => a.date.localeCompare(b.date));

    // Filter by period
    const filteredTxns = periodStart
      ? txns.filter((t) => t.date >= periodStart)
      : txns;

    if (!filteredTxns.length) {
      return { transactions: [], chartData: [], hasData: false };
    }

    // Build chart data: aggregate by date, compute running balance
    const dailyBuckets = new Map<string, { inflow: number; outflow: number }>();

    for (const txn of filteredTxns) {
      const dateKey = txn.date.slice(0, 10); // YYYY-MM-DD
      const existing = dailyBuckets.get(dateKey) ?? { inflow: 0, outflow: 0 };
      if (txn.type === "inflow") {
        existing.inflow += txn.amount;
      } else {
        existing.outflow += txn.amount;
      }
      dailyBuckets.set(dateKey, existing);
    }

    let runningBalance = 0;
    const chartData: ChartDataPoint[] = Array.from(dailyBuckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, bucket]) => {
        runningBalance += bucket.inflow - bucket.outflow;
        return {
          label: formatShortDate(dateKey),
          sortKey: dateKey,
          inflow: Math.round(bucket.inflow * 100) / 100,
          outflow: Math.round(bucket.outflow * 100) / 100,
          balance: Math.round(runningBalance * 100) / 100,
        };
      });

    return { transactions: filteredTxns, chartData, hasData: true };
  }, [items, sales, shipments, periodStart]);

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
          <TableView transactions={transactions} />
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

function TableView({ transactions }: { transactions: Transaction[] }) {
  let runningBalance = 0;

  const rows = transactions.map((txn, index) => {
    const signedAmount = txn.type === "inflow" ? txn.amount : -txn.amount;
    runningBalance += signedAmount;
    return { ...txn, signedAmount, runningBalance, index };
  });

  return (
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
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
                    <ArrowDownLeft className="h-3 w-3" />
                    In
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
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
                  row.type === "inflow" ? "text-green-600" : "text-red-600"
                )}
              >
                {row.type === "inflow" ? "+" : "-"}
                {formatCurrency(row.amount)}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right text-xs font-medium",
                  row.runningBalance >= 0 ? "text-green-600" : "text-red-600"
                )}
              >
                {formatCurrency(row.runningBalance)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

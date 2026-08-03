import { useMemo } from "react";
import { Link } from "react-router";
import type { FinAgingBracket, FinStaleItem } from "@/lib/finances-dashboard";
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
import { AlertTriangle, Warehouse } from "lucide-react";
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

// Colours keyed by the server-provided bracket label.
const BRACKET_COLORS: Record<string, string> = {
  "0-14 days": CHART_PALETTE.green,
  "15-30 days": CHART_PALETTE.blue,
  "31-60 days": CHART_PALETTE.amber,
  "60+ days": CHART_PALETTE.red,
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
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

interface InventoryAgingProps {
  brackets: FinAgingBracket[];
  totalCount: number;
  totalValue: number;
  staleItems: FinStaleItem[];
  staleItemsTotal: number;
  isLoading: boolean;
}

export function InventoryAging({
  brackets,
  totalCount,
  totalValue,
  staleItems,
  staleItemsTotal,
  isLoading,
}: InventoryAgingProps) {
  const decorated = useMemo(
    () =>
      brackets.map((b) => ({
        label: b.label,
        color: BRACKET_COLORS[b.label] ?? CHART_PALETTE.navy,
        count: b.count,
        value: b.value,
        pctOfValue: totalValue > 0 ? (b.value / totalValue) * 100 : 0,
      })),
    [brackets, totalValue]
  );

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

  if (totalCount === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Warehouse className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">No unsold inventory</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Items you acquire will appear here, bracketed by how long you've
            held them.
          </p>
        </CardContent>
      </Card>
    );
  }

  const chartData = decorated.map((b) => ({
    name: b.label,
    value: Math.round(b.value * 100) / 100,
    color: b.color,
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Inventory value + aging chart */}
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-start justify-between pb-2">
          <div>
            <CardTitle className="text-base">Inventory Aging</CardTitle>
            <CardDescription>
              {totalCount} unsold item{totalCount === 1 ? "" : "s"} ·{" "}
              {formatCurrency(totalValue)} cost basis tied up
            </CardDescription>
          </div>
          <Warehouse className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="space-y-4">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              data={chartData}
              margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
            >
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
                formatter={(value) => [
                  formatCurrency(Number(value)),
                  "Cost basis",
                ]}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {chartData.map((entry, index) => (
                  <Cell key={index} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Age Bracket</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Total Value</TableHead>
                  <TableHead className="text-right">% of Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {decorated.map((b) => (
                  <TableRow key={b.label}>
                    <TableCell>
                      <span className="flex items-center gap-2 font-medium">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: b.color }}
                        />
                        {b.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{b.count}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(b.value)}
                    </TableCell>
                    <TableCell className="text-right">
                      {b.pctOfValue.toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Stale inventory flag */}
      {staleItemsTotal > 0 && (
        <Card className="lg:col-span-2 border-brand-red/40">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle className="text-base">Consider Repricing</CardTitle>
              <CardDescription>
                {staleItemsTotal} item{staleItemsTotal === 1 ? "" : "s"}{" "}
                held 60+ days — repricing may help them move.
              </CardDescription>
            </div>
            <AlertTriangle className="h-4 w-4 text-brand-red-text" />
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Days Held</TableHead>
                    <TableHead className="text-right">Cost Basis</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {staleItems.slice(0, 15).map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Link
                          to={`/dashboard/inventory/${item.id}`}
                          className="font-medium hover:underline"
                        >
                          {item.title}
                        </Link>
                      </TableCell>
                      <TableCell className="capitalize text-muted-foreground">
                        {item.status}
                      </TableCell>
                      <TableCell className="text-right font-medium text-brand-red-text">
                        {item.age}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(item.acquired_price)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {staleItemsTotal > 15 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the 15 oldest of {staleItemsTotal} stale items.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

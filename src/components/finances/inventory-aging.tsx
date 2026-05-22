import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { InventoryItemRow } from "@/types/database";
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

// Items in these statuses are no longer held as inventory.
const SOLD_STATUSES = new Set(["sold", "shipped", "completed"]);

const STALE_BRACKET_LABEL = "60+ days";

interface Bracket {
  label: string;
  maxDays: number; // Infinity for the open-ended last bracket.
  color: string;
}

const BRACKETS: Bracket[] = [
  { label: "0-14 days", maxDays: 14, color: "#22c55e" },
  { label: "15-30 days", maxDays: 30, color: "#3b82f6" },
  { label: "31-60 days", maxDays: 60, color: "#f59e0b" },
  { label: STALE_BRACKET_LABEL, maxDays: Infinity, color: "#E94560" },
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

function ageInDays(item: InventoryItemRow): number {
  const start = item.acquired_date ?? item.created_at;
  const ms = Date.now() - new Date(start).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

interface BracketStat {
  label: string;
  color: string;
  count: number;
  value: number;
  pctOfValue: number;
}

interface InventoryAgingProps {
  items: InventoryItemRow[];
  isLoading: boolean;
}

export function InventoryAging({ items, isLoading }: InventoryAgingProps) {
  const { brackets, totalValue, totalCount, staleItems } = useMemo(() => {
    const unsold = items.filter((i) => !SOLD_STATUSES.has(i.status));

    const stats: BracketStat[] = BRACKETS.map((b) => ({
      label: b.label,
      color: b.color,
      count: 0,
      value: 0,
      pctOfValue: 0,
    }));

    const staleItems: { item: InventoryItemRow; age: number }[] = [];
    let totalValue = 0;

    for (const item of unsold) {
      const age = ageInDays(item);
      const value = item.acquired_price ?? 0;
      totalValue += value;

      const idx = BRACKETS.findIndex((b) => age <= b.maxDays);
      const bracket = stats[idx];
      if (bracket) {
        bracket.count += 1;
        bracket.value += value;
      }
      if (BRACKETS[idx]?.label === STALE_BRACKET_LABEL) {
        staleItems.push({ item, age });
      }
    }

    for (const s of stats) {
      s.pctOfValue = totalValue > 0 ? (s.value / totalValue) * 100 : 0;
    }

    staleItems.sort((a, b) => b.age - a.age);

    return {
      brackets: stats,
      totalValue,
      totalCount: unsold.length,
      staleItems,
    };
  }, [items]);

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

  const chartData = brackets.map((b) => ({
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
                {brackets.map((b) => (
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
      {staleItems.length > 0 && (
        <Card className="lg:col-span-2 border-[#E94560]/40">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle className="text-base">Consider Repricing</CardTitle>
              <CardDescription>
                {staleItems.length} item{staleItems.length === 1 ? "" : "s"}{" "}
                held 60+ days — repricing may help them move.
              </CardDescription>
            </div>
            <AlertTriangle className="h-4 w-4 text-[#E94560]" />
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
                  {staleItems.slice(0, 15).map(({ item, age }) => (
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
                      <TableCell className="text-right font-medium text-[#E94560]">
                        {age}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(item.acquired_price ?? 0)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {staleItems.length > 15 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the 15 oldest of {staleItems.length} stale items.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

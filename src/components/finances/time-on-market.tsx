import { useNavigate } from "react-router";
import type { FinTomRow, FinTomDist, FinSlowItem } from "@/lib/finances-dashboard";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ClickableRow } from "@/components/clickable-row";
import { Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { CHART_PALETTE } from "@/lib/constants";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
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

interface TimeOnMarketProps {
  overallAvg: number;
  byType: FinTomRow[];
  byBrand: FinTomRow[];
  distribution: FinTomDist[];
  slowMoving: FinSlowItem[];
  slowMovingTotal: number;
  hasSoldData: boolean;
  isLoading: boolean;
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function TimeOnMarket({
  overallAvg,
  byType,
  byBrand,
  distribution,
  slowMoving,
  slowMovingTotal,
  hasSoldData,
  isLoading,
}: TimeOnMarketProps) {
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!hasSoldData && slowMovingTotal === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Clock className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">No time-on-market data yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            List and sell items to see time-on-market analytics.
          </p>
        </CardContent>
      </Card>
    );
  }

  const slowest = byType[0];

  return (
    <div className="space-y-4">
      {/* Summary metrics */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Overall Avg Days to Sell
            </CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {overallAvg}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                days
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Top breakdown by type (first entry) */}
        {slowest && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">
                Slowest Category
              </CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {slowest.avg_days}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  days
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {slowest.name} ({slowest.count} sold)
              </p>
            </CardContent>
          </Card>
        )}

        {/* Slow-moving count */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Slow-Moving Items
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {slowMovingTotal}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                items
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Listed 30+ days without sale
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Distribution chart + breakdown tables */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Time-to-sell distribution chart */}
        {hasSoldData && distribution.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Time-to-Sell Distribution
              </CardTitle>
              <CardDescription>
                How many items sold within each time range
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={distribution}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="range"
                      tick={{ fontSize: 12 }}
                      label={{
                        value: "Days",
                        position: "insideBottom",
                        offset: -5,
                        fontSize: 12,
                      }}
                    />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      allowDecimals={false}
                      label={{
                        value: "Items",
                        angle: -90,
                        position: "insideLeft",
                        fontSize: 12,
                      }}
                    />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Bar
                      dataKey="count"
                      name="Items Sold"
                      fill={CHART_PALETTE.navy}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Avg days by garment type */}
        {byType.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Avg Days to Sell by Category
              </CardTitle>
              <CardDescription>
                Average time-on-market by garment type
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Avg Days</TableHead>
                    <TableHead className="text-right">Items Sold</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byType.map((row) => (
                    <TableRow key={row.name}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell
                        className={cn(
                          "text-right",
                          row.avg_days >= 60
                            ? "text-red-600 font-medium dark:text-red-400"
                            : row.avg_days >= 30
                              ? "text-yellow-600 font-medium dark:text-yellow-400"
                              : ""
                        )}
                      >
                        {row.avg_days}d
                      </TableCell>
                      <TableCell className="text-right">{row.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Avg days by brand */}
      {byBrand.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Avg Days to Sell by Brand
            </CardTitle>
            <CardDescription>
              Average time-on-market by brand
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Brand</TableHead>
                  <TableHead className="text-right">Avg Days</TableHead>
                  <TableHead className="text-right">Items Sold</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byBrand.map((row) => (
                  <TableRow key={row.name}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell
                      className={cn(
                        "text-right",
                        row.avg_days >= 60
                          ? "text-red-600 font-medium dark:text-red-400"
                          : row.avg_days >= 30
                            ? "text-yellow-600 font-medium dark:text-yellow-400"
                            : ""
                      )}
                    >
                      {row.avg_days}d
                    </TableCell>
                    <TableCell className="text-right">{row.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Slow-moving inventory section */}
      {slowMoving.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
              Slow-Moving Inventory
            </CardTitle>
            <CardDescription>
              Items listed over 30 days without a sale
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Days Listed</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slowMoving.map((item) => (
                  <ClickableRow
                    key={item.id}
                    onActivate={() =>
                      navigate(`/dashboard/inventory/${item.id}`)
                    }
                    activateLabel={`View ${item.title}`}
                  >
                    <TableCell className="font-medium">
                      {item.title}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.brand ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.garment_type
                        ? formatLabel(item.garment_type)
                        : "—"}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-medium",
                        item.days_listed >= 60
                          ? "text-red-600 dark:text-red-400"
                          : "text-yellow-600 dark:text-yellow-400"
                      )}
                    >
                      {item.days_listed}d
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300">
                        {formatLabel(item.status)}
                      </Badge>
                    </TableCell>
                  </ClickableRow>
                ))}
              </TableBody>
            </Table>
            {slowMovingTotal > slowMoving.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the {slowMoving.length} slowest of {slowMovingTotal} items.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { InventoryItemRow, SaleRow, ListingRow } from "@/types/database";
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
import { Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
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
  items: InventoryItemRow[];
  sales: SaleRow[];
  listings: ListingRow[];
  periodStart: string | null;
  isLoading: boolean;
}

interface DaysToSellEntry {
  itemId: string;
  days: number;
  garmentType: string | null;
  brand: string | null;
}

interface BreakdownRow {
  name: string;
  avgDays: number;
  count: number;
}

interface DistributionBucket {
  range: string;
  count: number;
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function TimeOnMarket({
  items,
  sales,
  listings,
  periodStart,
  isLoading,
}: TimeOnMarketProps) {
  const navigate = useNavigate();

  const {
    overallAvg,
    byGarmentType,
    byBrand,
    distribution,
    slowMovingItems,
    hasData,
  } = useMemo(() => {
    if (!sales.length || !listings.length) {
      return {
        overallAvg: 0,
        byGarmentType: [] as BreakdownRow[],
        byBrand: [] as BreakdownRow[],
        distribution: [] as DistributionBucket[],
        slowMovingItems: [] as (InventoryItemRow & { daysListed: number })[],
        hasData: false,
      };
    }

    const itemById = new Map<string, InventoryItemRow>();
    for (const item of items) {
      itemById.set(item.id, item);
    }

    // Build earliest listing date per item
    const earliestListingByItem = new Map<string, string>();
    for (const l of listings) {
      const existing = earliestListingByItem.get(l.inventory_item_id);
      if (!existing || l.listed_at < existing) {
        earliestListingByItem.set(l.inventory_item_id, l.listed_at);
      }
    }

    // Filter sales by period
    const filteredSales = periodStart
      ? sales.filter((s) => s.sale_date >= periodStart)
      : sales;

    // Calculate days-to-sell for each sold item
    const daysToSellEntries: DaysToSellEntry[] = [];
    for (const sale of filteredSales) {
      const listingDate = earliestListingByItem.get(sale.inventory_item_id);
      if (!listingDate) continue;

      const days = Math.floor(
        (new Date(sale.sale_date).getTime() - new Date(listingDate).getTime()) /
          (1000 * 60 * 60 * 24)
      );
      if (days < 0) continue;

      const item = itemById.get(sale.inventory_item_id);
      daysToSellEntries.push({
        itemId: sale.inventory_item_id,
        days,
        garmentType: item?.garment_type ?? null,
        brand: item?.brand ?? null,
      });
    }

    if (!daysToSellEntries.length) {
      // Still compute slow-moving items even without sold data
      const slowMoving = computeSlowMovingItems(items, earliestListingByItem, sales);
      return {
        overallAvg: 0,
        byGarmentType: [],
        byBrand: [],
        distribution: [],
        slowMovingItems: slowMoving,
        hasData: slowMoving.length > 0,
      };
    }

    // Overall average
    const overallAvg = Math.round(
      daysToSellEntries.reduce((sum, e) => sum + e.days, 0) /
        daysToSellEntries.length
    );

    // By garment type
    const byTypeMap = new Map<string, number[]>();
    for (const e of daysToSellEntries) {
      const key = e.garmentType ?? "unknown";
      const arr = byTypeMap.get(key) ?? [];
      arr.push(e.days);
      byTypeMap.set(key, arr);
    }
    const byGarmentType: BreakdownRow[] = Array.from(byTypeMap.entries())
      .map(([name, days]) => ({
        name: formatLabel(name),
        avgDays: Math.round(days.reduce((a, b) => a + b, 0) / days.length),
        count: days.length,
      }))
      .sort((a, b) => b.avgDays - a.avgDays);

    // By brand
    const byBrandMap = new Map<string, number[]>();
    for (const e of daysToSellEntries) {
      const key = e.brand ?? "Unknown";
      const arr = byBrandMap.get(key) ?? [];
      arr.push(e.days);
      byBrandMap.set(key, arr);
    }
    const byBrand: BreakdownRow[] = Array.from(byBrandMap.entries())
      .map(([name, days]) => ({
        name,
        avgDays: Math.round(days.reduce((a, b) => a + b, 0) / days.length),
        count: days.length,
      }))
      .sort((a, b) => b.avgDays - a.avgDays);

    // Distribution histogram
    const buckets = [
      { range: "0-7", min: 0, max: 7 },
      { range: "8-14", min: 8, max: 14 },
      { range: "15-30", min: 15, max: 30 },
      { range: "31-60", min: 31, max: 60 },
      { range: "61-90", min: 61, max: 90 },
      { range: "90+", min: 91, max: Infinity },
    ];
    const distribution: DistributionBucket[] = buckets.map((b) => ({
      range: b.range,
      count: daysToSellEntries.filter(
        (e) => e.days >= b.min && e.days <= b.max
      ).length,
    }));

    // Slow-moving inventory
    const slowMoving = computeSlowMovingItems(items, earliestListingByItem, sales);

    return {
      overallAvg,
      byGarmentType,
      byBrand,
      distribution,
      slowMovingItems: slowMoving,
      hasData: true,
    };
  }, [items, sales, listings, periodStart]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!hasData) {
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
        {byGarmentType.length > 0 && (() => {
          const slowest = byGarmentType[0]!;
          return (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">
                  Slowest Category
                </CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {slowest.avgDays}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">
                    days
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {slowest.name} ({slowest.count} sold)
                </p>
              </CardContent>
            </Card>
          );
        })()}

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
              {slowMovingItems.length}
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
        {distribution.length > 0 && (
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
                      fill="#0F3460"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Avg days by garment type */}
        {byGarmentType.length > 0 && (
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
                  {byGarmentType.map((row) => (
                    <TableRow key={row.name}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell
                        className={cn(
                          "text-right",
                          row.avgDays >= 60
                            ? "text-red-600 font-medium"
                            : row.avgDays >= 30
                              ? "text-yellow-600 font-medium"
                              : ""
                        )}
                      >
                        {row.avgDays}d
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
                        row.avgDays >= 60
                          ? "text-red-600 font-medium"
                          : row.avgDays >= 30
                            ? "text-yellow-600 font-medium"
                            : ""
                      )}
                    >
                      {row.avgDays}d
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
      {slowMovingItems.length > 0 && (
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
                {slowMovingItems.map((item) => (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer"
                    onClick={() =>
                      navigate(`/dashboard/inventory/${item.id}`)
                    }
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
                        item.daysListed >= 60
                          ? "text-red-600"
                          : "text-yellow-600"
                      )}
                    >
                      {item.daysListed}d
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-yellow-200 bg-yellow-100 text-yellow-800">
                        {formatLabel(item.status)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function computeSlowMovingItems(
  items: InventoryItemRow[],
  earliestListingByItem: Map<string, string>,
  sales: SaleRow[],
): (InventoryItemRow & { daysListed: number })[] {
  // Items that haven't been sold yet
  const soldItemIds = new Set(sales.map((s) => s.inventory_item_id));
  const unsoldStatuses = new Set(["listed", "graded"]);
  const now = new Date();

  return items
    .filter(
      (item) =>
        unsoldStatuses.has(item.status) && !soldItemIds.has(item.id)
    )
    .map((item) => {
      const listingDate = earliestListingByItem.get(item.id);
      if (!listingDate) return null;

      const days = Math.floor(
        (now.getTime() - new Date(listingDate).getTime()) /
          (1000 * 60 * 60 * 24)
      );
      if (days < 30) return null;

      return { ...item, daysListed: days };
    })
    .filter(
      (item): item is InventoryItemRow & { daysListed: number } => item !== null
    )
    .sort((a, b) => b.daysListed - a.daysListed);
}

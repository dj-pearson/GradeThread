import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { InventoryItemRow, SaleRow, ShipmentRow, ListingRow } from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Percent,
  ShoppingCart,
  Clock,
  Warehouse,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ProfitTable } from "@/components/finances/profit-table";
import { FinancialCharts } from "@/components/finances/financial-charts";

type Period = "this_month" | "last_30" | "this_quarter" | "this_year" | "all_time";

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "this_month", label: "This Month" },
  { value: "last_30", label: "Last 30 Days" },
  { value: "this_quarter", label: "This Quarter" },
  { value: "this_year", label: "This Year" },
  { value: "all_time", label: "All Time" },
];

function getPeriodStartDate(period: Period): string | null {
  const now = new Date();
  switch (period) {
    case "this_month":
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    case "last_30": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d.toISOString();
    }
    case "this_quarter": {
      const quarter = Math.floor(now.getMonth() / 3);
      return new Date(now.getFullYear(), quarter * 3, 1).toISOString();
    }
    case "this_year":
      return new Date(now.getFullYear(), 0, 1).toISOString();
    case "all_time":
      return null;
  }
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

interface FinancialData {
  items: InventoryItemRow[];
  sales: SaleRow[];
  shipments: ShipmentRow[];
  listings: ListingRow[];
}

export function FinancesPage() {
  const [period, setPeriod] = useState<Period>("all_time");

  const { data, isLoading } = useQuery({
    queryKey: ["finances-data"],
    queryFn: async (): Promise<FinancialData> => {
      const [itemsRes, salesRes, shipmentsRes, listingsRes] = await Promise.all([
        supabase.from("inventory_items").select("*"),
        supabase.from("sales").select("*"),
        supabase.from("shipments").select("*"),
        supabase.from("listings").select("*"),
      ]);

      if (itemsRes.error) throw itemsRes.error;
      if (salesRes.error) throw salesRes.error;
      if (shipmentsRes.error) throw shipmentsRes.error;
      if (listingsRes.error) throw listingsRes.error;

      return {
        items: (itemsRes.data ?? []) as InventoryItemRow[],
        sales: (salesRes.data ?? []) as SaleRow[],
        shipments: (shipmentsRes.data ?? []) as ShipmentRow[],
        listings: (listingsRes.data ?? []) as ListingRow[],
      };
    },
    staleTime: 5 * 60 * 1000,
  });

  const metrics = useMemo(() => {
    if (!data) return null;

    const { items, sales, shipments } = data;
    const periodStart = getPeriodStartDate(period);

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

    // Revenue: sum of sale prices
    const totalRevenue = filteredSales.reduce((sum, s) => sum + s.sale_price, 0);

    // Costs breakdown
    let totalAcquisitionCost = 0;
    let totalShippingCost = 0;
    let totalPlatformFees = 0;
    let totalDaysToSell = 0;
    let daysToSellCount = 0;

    for (const sale of filteredSales) {
      const item = itemById.get(sale.inventory_item_id);
      if (item?.acquired_price) {
        totalAcquisitionCost += item.acquired_price;
      }
      totalPlatformFees += sale.platform_fees;

      const shipment = shipmentBySaleId.get(sale.id);
      if (shipment) {
        totalShippingCost += shipment.shipping_cost + shipment.label_cost;
      }

      // Days to sell: from acquired_date to sale_date
      if (item?.acquired_date) {
        const acquiredDate = new Date(item.acquired_date);
        const saleDate = new Date(sale.sale_date);
        const days = Math.floor(
          (saleDate.getTime() - acquiredDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (days >= 0) {
          totalDaysToSell += days;
          daysToSellCount++;
        }
      }
    }

    const totalCosts = totalAcquisitionCost + totalShippingCost + totalPlatformFees;
    const netProfit = totalRevenue - totalCosts;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
    const itemsSold = filteredSales.length;
    const avgProfitPerItem = itemsSold > 0 ? netProfit / itemsSold : 0;
    const avgDaysToSell = daysToSellCount > 0 ? Math.round(totalDaysToSell / daysToSellCount) : 0;

    // Inventory value: sum of acquired_price for unsold items
    const unsoldStatuses = new Set(["acquired", "grading", "graded", "listed"]);
    const inventoryValue = items
      .filter((item) => unsoldStatuses.has(item.status))
      .reduce((sum, item) => sum + (item.acquired_price ?? 0), 0);

    return {
      totalRevenue,
      totalCosts,
      netProfit,
      profitMargin,
      itemsSold,
      avgProfitPerItem,
      avgDaysToSell,
      inventoryValue,
    };
  }, [data, period]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Finances</h1>
        <p className="text-muted-foreground">
          Financial overview and key metrics for your reselling business.
        </p>
      </div>

      {/* Period toggle */}
      <div className="flex flex-wrap gap-2">
        {PERIOD_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            variant={period === opt.value ? "default" : "outline"}
            size="sm"
            onClick={() => setPeriod(opt.value)}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-2xl font-bold text-green-600">
                {formatCurrency(metrics?.totalRevenue ?? 0)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Costs</CardTitle>
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-2xl font-bold text-red-600">
                {formatCurrency(metrics?.totalCosts ?? 0)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Net Profit</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div
                className={cn(
                  "text-2xl font-bold",
                  (metrics?.netProfit ?? 0) >= 0 ? "text-green-600" : "text-red-600"
                )}
              >
                {formatCurrency(metrics?.netProfit ?? 0)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Profit Margin</CardTitle>
            <Percent className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div
                className={cn(
                  "text-2xl font-bold",
                  (metrics?.profitMargin ?? 0) >= 0 ? "text-green-600" : "text-red-600"
                )}
              >
                {(metrics?.profitMargin ?? 0).toFixed(1)}%
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Secondary metrics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Items Sold</CardTitle>
            <ShoppingCart className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{metrics?.itemsSold ?? 0}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Avg Profit / Item</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div
                className={cn(
                  "text-2xl font-bold",
                  (metrics?.avgProfitPerItem ?? 0) >= 0 ? "text-green-600" : "text-red-600"
                )}
              >
                {formatCurrency(metrics?.avgProfitPerItem ?? 0)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Avg Days to Sell</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">
                {metrics?.avgDaysToSell ?? 0}
                <span className="ml-1 text-sm font-normal text-muted-foreground">days</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Inventory Value</CardTitle>
            <Warehouse className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-2xl font-bold">
                {formatCurrency(metrics?.inventoryValue ?? 0)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Financial Charts */}
      <div>
        <h2 className="text-lg font-semibold">Financial Reports</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Revenue trends, cost analysis, and top performers.
        </p>
        <FinancialCharts
          items={data?.items ?? []}
          sales={data?.sales ?? []}
          shipments={data?.shipments ?? []}
          periodStart={getPeriodStartDate(period)}
          isLoading={isLoading}
        />
      </div>

      {/* Profit/Loss per Item Table */}
      <div>
        <h2 className="text-lg font-semibold">Profit / Loss per Item</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Detailed breakdown of costs and profit for each sold item.
        </p>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <ProfitTable
            items={data?.items ?? []}
            sales={data?.sales ?? []}
            shipments={data?.shipments ?? []}
            listings={data?.listings ?? []}
            periodStart={getPeriodStartDate(period)}
          />
        )}
      </div>
    </div>
  );
}

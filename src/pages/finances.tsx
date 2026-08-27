import { useState, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { AdSpendCard } from "@/components/flipdesk/ad-spend-card";
import { useAuth } from "@/hooks/use-auth";
import { fetchFinancesDashboard } from "@/lib/finances-dashboard";
import {
  fetchOperatingExpensesTotal,
  netAfterOverhead,
} from "@/lib/finances-overhead";
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
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ProfitTable } from "@/components/finances/profit-table";
import { FinancialExport } from "@/components/finances/financial-export";
import { ChartSkeleton } from "@/components/ui/skeletons";
import { ErrorState } from "@/components/ui/error-state";

// The six chart panels each pull in Recharts — lazy-load them so the page
// shell + stat cards paint first and the chart bundle streams in after.
const FinancialCharts = lazy(() =>
  import("@/components/finances/financial-charts").then((m) => ({
    default: m.FinancialCharts,
  })),
);
const CashFlow = lazy(() =>
  import("@/components/finances/cash-flow").then((m) => ({
    default: m.CashFlow,
  })),
);
const TimeOnMarket = lazy(() =>
  import("@/components/finances/time-on-market").then((m) => ({
    default: m.TimeOnMarket,
  })),
);
const RoiAnalytics = lazy(() =>
  import("@/components/finances/roi-analytics").then((m) => ({
    default: m.RoiAnalytics,
  })),
);
const InventoryAging = lazy(() =>
  import("@/components/finances/inventory-aging").then((m) => ({
    default: m.InventoryAging,
  })),
);
const GradePriceCorrelation = lazy(() =>
  import("@/components/finances/grade-price-correlation").then((m) => ({
    default: m.GradePriceCorrelation,
  })),
);

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

export function FinancesPage() {
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>("all_time");
  const periodStart = getPeriodStartDate(period);

  // One RPC round-trip per period: Postgres returns every summary metric and
  // chart series pre-aggregated (US-403). No raw tables cross the wire.
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["finances-dashboard", period, user?.id],
    queryFn: () => fetchFinancesDashboard(periodStart),
    staleTime: 5 * 60 * 1000,
  });

  // US-2226: operating expenses (overhead) live in flipdesk_expenses and are
  // NOT part of the RPC's per-item net_profit. Fetch the period total so the
  // page can show one reconciled "true net after overhead" figure instead of
  // leaving the Expenses page as a second, disconnected profit number.
  const { data: overhead = 0 } = useQuery({
    queryKey: ["finances-overhead", period, user?.id],
    queryFn: () => fetchOperatingExpensesTotal(periodStart),
    staleTime: 5 * 60 * 1000,
  });

  const summary = data?.summary;
  const trueNet = netAfterOverhead(summary?.net_profit ?? 0, overhead);

  // US-1467: a brand-new reseller (no sales AND no inventory in the period) sees
  // an all-$0 dashboard that looks broken. Once the data has loaded successfully,
  // detect the genuinely-empty case and show a "get started" EmptyState with a
  // CTA instead of zero tiles. Any sale or inventory item flips back to the
  // populated dashboard.
  const hasNoData =
    !isLoading &&
    !isError &&
    data != null &&
    (summary?.items_sold ?? 0) === 0 &&
    (data.inventory_aging?.total_count ?? 0) === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finances"
        subtitle="Financial overview and key metrics for your reselling business."
      />

      {/* Period toggle + Export */}
      <div className="flex flex-wrap items-center justify-between gap-4">
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
      </div>

      {/* Financial Export — fetches its own row-level data on demand */}
      <FinancialExport />

      {isError ? (
        <ErrorState
          title="Couldn't load financial data"
          description="Something went wrong while loading your finances. This is usually temporary."
          onRetry={() => refetch()}
          retrying={isFetching}
        />
      ) : hasNoData ? (
        <EmptyState
          icon={DollarSign}
          title="No financial data yet"
          description="Add inventory and record your first sale — your revenue, profit, ROI, and cash-flow reports will appear here."
          action={{ label: "Add inventory", to: "/dashboard/flipdesk/intake", icon: Plus }}
          secondaryAction={{ label: "View inventory", to: "/dashboard/flipdesk/inventory" }}
        />
      ) : (
        <>
      {/* US-2952: eBay's own costs, including the advertising this page used to
          leave out entirely — so the profit above was profit BEFORE ads. */}
      <AdSpendCard />

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
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                {formatCurrency(summary?.total_revenue ?? 0)}
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
              <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                {formatCurrency(summary?.total_costs ?? 0)}
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
                  (summary?.net_profit ?? 0) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                )}
              >
                {formatCurrency(summary?.net_profit ?? 0)}
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
                  (summary?.profit_margin ?? 0) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                )}
              >
                {(summary?.profit_margin ?? 0).toFixed(1)}%
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* US-2226: reconcile per-item net profit with logged operating overhead
          into one true-net figure, so the Expenses page is no longer a second,
          disconnected profit number. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Net After Overhead
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-8 w-32" />
          ) : (
            <>
              <div
                className={cn(
                  "text-2xl font-bold",
                  trueNet >= 0
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400",
                )}
              >
                {formatCurrency(trueNet)}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatCurrency(summary?.net_profit ?? 0)} net profit minus{" "}
                {formatCurrency(overhead)} operating expenses. Overhead comes
                from the Expenses page for this period.
              </p>
            </>
          )}
        </CardContent>
      </Card>

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
              <div className="text-2xl font-bold">{summary?.items_sold ?? 0}</div>
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
                  (summary?.avg_profit_per_item ?? 0) >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                )}
              >
                {formatCurrency(summary?.avg_profit_per_item ?? 0)}
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
                {summary?.avg_days_to_sell ?? 0}
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
                {formatCurrency(summary?.inventory_value ?? 0)}
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
        <Suspense fallback={<ChartSkeleton />}>
          <FinancialCharts
            timeSeries={data?.time_series ?? []}
            costBreakdown={data?.cost_breakdown ?? null}
            topBrands={data?.top_brands ?? []}
            topCategories={data?.top_categories ?? []}
            isLoading={isLoading}
          />
        </Suspense>
      </div>

      {/* ROI Analytics */}
      <div>
        <h2 className="text-lg font-semibold">ROI Analytics</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          See which brands, categories, and acquisition sources yield the best
          margins.
        </p>
        <Suspense fallback={<ChartSkeleton />}>
          <RoiAnalytics
            byBrand={data?.roi_by_brand ?? []}
            byCategory={data?.roi_by_category ?? []}
            bySource={data?.roi_by_source ?? []}
            bestItems={data?.roi_best_items ?? []}
            worstItems={data?.roi_worst_items ?? []}
            isLoading={isLoading}
          />
        </Suspense>
      </div>

      {/* Inventory Value & Aging */}
      <div>
        <h2 className="text-lg font-semibold">Inventory Value & Aging</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Capital tied up in unsold inventory, bracketed by how long it's been
          held.
        </p>
        <Suspense fallback={<ChartSkeleton />}>
          <InventoryAging
            brackets={data?.inventory_aging.brackets ?? []}
            totalCount={data?.inventory_aging.total_count ?? 0}
            totalValue={data?.inventory_aging.total_value ?? 0}
            staleItems={data?.stale_items ?? []}
            staleItemsTotal={data?.stale_items_total ?? 0}
            isLoading={isLoading}
          />
        </Suspense>
      </div>

      {/* Grade-to-Price Correlation */}
      <div>
        <h2 className="text-lg font-semibold">Grade-to-Price Correlation</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          How condition grades relate to the prices your items sell for.
        </p>
        <Suspense fallback={<ChartSkeleton />}>
          <GradePriceCorrelation
            points={data?.grade_points ?? []}
            pointsTotal={data?.grade_points_total ?? 0}
            tierStats={data?.grade_tier_stats ?? []}
            categoryTier={data?.grade_category_tier ?? []}
            isLoading={isLoading}
          />
        </Suspense>
      </div>

      {/* Cash Flow Timeline */}
      <div>
        <h2 className="text-lg font-semibold">Cash Flow</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Track money in and out with a running cash position.
        </p>
        <Suspense fallback={<ChartSkeleton />}>
          <CashFlow
            daily={data?.cash_flow_daily ?? []}
            recent={data?.cash_flow_recent ?? []}
            recentTotal={data?.cash_flow_total ?? 0}
            isLoading={isLoading}
          />
        </Suspense>
      </div>

      {/* Time on Market Analytics */}
      <div>
        <h2 className="text-lg font-semibold">Time on Market</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Track how long items stay listed and identify slow-moving inventory.
        </p>
        <Suspense fallback={<ChartSkeleton />}>
          <TimeOnMarket
            overallAvg={data?.tom_overall_avg ?? 0}
            byType={data?.tom_by_type ?? []}
            byBrand={data?.tom_by_brand ?? []}
            distribution={data?.tom_distribution ?? []}
            slowMoving={data?.tom_slow_moving ?? []}
            slowMovingTotal={data?.tom_slow_moving_total ?? 0}
            hasSoldData={data?.tom_has_sold_data ?? false}
            isLoading={isLoading}
          />
        </Suspense>
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
            rows={data?.profit_rows ?? []}
            rowsTotal={data?.profit_rows_total ?? 0}
          />
        )}
      </div>
        </>
      )}
    </div>
  );
}

import { lazy, Suspense, useMemo } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BarChart3,
  TrendingUp,
  Award,
  ShieldCheck,
  Undo2,
  Copy,
  Clock,
  Percent,
  DollarSign,
  Download,
} from "lucide-react";
import { downloadCsv } from "@/lib/csv-export";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuthStore } from "@/stores/auth-store";
import {
  MIN_BUCKET_SIZE,
  type GroupKey,
  type GradingRoiSummary,
} from "@/lib/flipdesk-analytics";
import {
  fetchSellThrough,
  fetchGradingRoi,
  fetchGradingRoiSummary,
} from "@/lib/flipdesk-analytics-server";
import { fetchFinancesDashboard } from "@/lib/finances-dashboard";
import { ShareOutcomesToggle } from "@/components/flipdesk/share-outcomes-toggle";
import { EbayAccountHealthCard } from "@/components/flipdesk/ebay-account-health-card";
import { EbayListingHealthCard } from "@/components/flipdesk/ebay-listing-health-card";
import { InventoryEquityCard } from "@/components/flipdesk/inventory-equity-card";
import {
  fetchReturnReduction,
  gradedReturnAdvantage,
  lowVsHighBandMultiplier,
  MIN_RETURN_SAMPLE,
  type ReturnStat,
} from "@/lib/flipdesk-returns-analytics";
import { ChartSkeleton, LoadingRegion } from "@/components/ui/skeletons";
import { PageHeader } from "@/components/ui/page-header";

// Lazy-load the Recharts bar chart at the chart boundary so the route-entry
// chunk stays light and the page shell + table paint before Recharts streams
// in (US-408).
const ListingPerformancePage = lazy(() =>
  import("@/pages/flipdesk/listing-performance").then((m) => ({
    default: m.FlipdeskListingPerformancePage,
  }))
);
const CommunityInsightsPage = lazy(() =>
  import("@/pages/flipdesk/community-insights").then((m) => ({
    default: m.FlipdeskCommunityInsightsPage,
  }))
);

const SellThroughChart = lazy(() =>
  import("@/components/flipdesk/sell-through-chart").then((m) => ({
    default: m.SellThroughChart,
  })),
);
const AnalyticsBarChart = lazy(() =>
  import("@/components/flipdesk/analytics-bar-chart").then((m) => ({
    default: m.AnalyticsBarChart,
  })),
);
const AnalyticsTrendChart = lazy(() =>
  import("@/components/flipdesk/analytics-trend-chart").then((m) => ({
    default: m.AnalyticsTrendChart,
  })),
);
// US-2819. Its own module rather than another report function in this file: the
// page is already the largest in FlipDesk, and the curve pulls a Recharts
// composed chart that only this tab needs.
const PriceCurveReport = lazy(() =>
  import("@/components/flipdesk/price-curve-report").then((m) => ({
    default: m.PriceCurveReport,
  })),
);
// US-2820. Lazy for the same reason: the gap RPC is a cross-seller scan, and
// the card renders nothing when the report cannot honestly produce a figure.
const PriceGapCard = lazy(() =>
  import("@/components/flipdesk/price-gap-card").then((m) => ({
    default: m.PriceGapCard,
  })),
);
// US-2822: the scorecard fronts the whole page, above the tab set.
const SellerScorecardCard = lazy(() =>
  import("@/components/flipdesk/seller-scorecard-card").then((m) => ({
    default: m.SellerScorecardCard,
  })),
);
// US-2821: the Defect Cost Ledger, on the Grading ROI tab.
const DefectCostSection = lazy(() =>
  import("@/components/flipdesk/defect-cost-section").then((m) => ({
    default: m.DefectCostSection,
  })),
);

const usd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;
const pct = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `${Math.round(n * 100)}%`;

type Preset = "all" | "30d" | "90d" | "12mo";

// Lower bound (yyyy-mm-dd) for a preset, or null for all-time. The DB RPC does
// the actual date filtering; this just translates the preset into the period
// start it expects (US-418 — aggregation moved server-side).
function presetStart(p: Preset): string | null {
  if (p === "all") return null;
  const days = p === "30d" ? 30 : p === "90d" ? 90 : 365;
  const from = new Date();
  from.setDate(from.getDate() - days);
  return from.toISOString().slice(0, 10);
}

// US-2234: persist the period preset in the URL so an analytics view is
// shareable and survives a refresh, instead of resetting to all-time.
function usePresetParam(): [Preset, (p: Preset) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("preset");
  const preset: Preset =
    raw === "30d" || raw === "90d" || raw === "12mo" ? raw : "all";
  const setPreset = (p: Preset) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (p === "all") next.delete("preset");
        else next.set("preset", p);
        return next;
      },
      { replace: true },
    );
  return [preset, setPreset];
}

// US-2234: the sell-through grouping (category/brand/source) also lives in the
// URL so the whole view is deep-linkable.
function useGroupKeyParam(): [GroupKey, (k: GroupKey) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("group");
  const groupKey: GroupKey =
    raw === "brand" || raw === "source" ? raw : "category";
  const setGroupKey = (k: GroupKey) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (k === "category") next.delete("group");
        else next.set("group", k);
        return next;
      },
      { replace: true },
    );
  return [groupKey, setGroupKey];
}

const csvDate = (): string => new Date().toISOString().slice(0, 10);

// US-2548: ONE date-range control for the page.
//
// Three of the five tabs drew their own copy of this Select. They already
// shared the value — usePresetParam keeps it in ?preset= (US-2234) — so the
// duplication was not three states, it was three controls onto one state, each
// with a different aria-label (the Grading ROI copy was labelled "Sell-through
// date range"). What actually broke the carry-across was the tab navigation:
// it pushed a bare pathname and dropped the whole query string, so the range a
// seller had just set vanished on the next tab.
const RANGE_TABS = new Set([
  "sell-through",
  "grading-roi",
  "price-curve",
  "returns",
]);

function RangeSelect() {
  const [preset, setPreset] = usePresetParam();
  return (
    <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
      <SelectTrigger className="w-44" aria-label="Date range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All time</SelectItem>
        <SelectItem value="30d">Last 30 days</SelectItem>
        <SelectItem value="90d">Last 90 days</SelectItem>
        <SelectItem value="12mo">Last 12 months</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function FlipdeskAnalyticsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // US-2161: Listing Performance and Community Insights were their own sidebar
  // entries; they are analytics, so they fold into this tab set. Path-based like
  // the existing tabs (not ?tab=) so every deep link stays a real URL.
  const tab = location.pathname.endsWith("/grading-roi")
    ? "grading-roi"
    : location.pathname.endsWith("/price-curve")
      ? "price-curve"
      : location.pathname.endsWith("/returns")
        ? "returns"
        : location.pathname.endsWith("/performance")
          ? "performance"
          : location.pathname.endsWith("/community")
            ? "community"
            : "sell-through";

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BarChart3}
        title="Analytics"
        subtitle="What sells, what doesn't, and whether grading pays off."
        actions={RANGE_TABS.has(tab) ? <RangeSelect /> : null}
      />

      {/* US-2822: one diagnosis above five tabs of numbers. */}
      <Suspense fallback={null}>
        <ScorecardHost />
      </Suspense>

      <Tabs
        value={tab}
        onValueChange={(v) =>
          // location.search rides along: the range, the grouping and any other
          // deep-link state live in the query string, and a bare pathname would
          // throw all of it away on every tab click.
          navigate(
            (v === "grading-roi"
              ? "/dashboard/flipdesk/analytics/grading-roi"
              : v === "price-curve"
                ? "/dashboard/flipdesk/analytics/price-curve"
                : v === "returns"
                  ? "/dashboard/flipdesk/analytics/returns"
                  : v === "performance"
                    ? "/dashboard/flipdesk/analytics/performance"
                    : v === "community"
                      ? "/dashboard/flipdesk/analytics/community"
                      : "/dashboard/flipdesk/analytics") + location.search,
          )
        }
      >
        <TabsList>
          <TabsTrigger value="sell-through">Sell-through</TabsTrigger>
          <TabsTrigger value="grading-roi">Grading ROI</TabsTrigger>
          <TabsTrigger value="price-curve">Price curve</TabsTrigger>
          <TabsTrigger value="returns">Return reduction</TabsTrigger>
          <TabsTrigger value="performance">Listing performance</TabsTrigger>
          <TabsTrigger value="community">Community</TabsTrigger>
        </TabsList>

        <TabsContent value="sell-through" className="mt-6">
          <SellThroughReport />
        </TabsContent>

        <TabsContent value="grading-roi" className="mt-6">
          <GradingRoiReport />
        </TabsContent>

        {/* Lazy + mounted only when active: the curve is a cross-seller
            aggregate, and firing it on every Analytics visit would cost every
            seller a cohort scan they did not ask for. */}
        <TabsContent value="price-curve" className="mt-6">
          {tab === "price-curve" && (
            <Suspense fallback={<Loading />}>
              <PriceCurveTab />
            </Suspense>
          )}
        </TabsContent>

        <TabsContent value="returns" className="mt-6">
          <ReturnReductionReport />
        </TabsContent>

        {/* Lazy + mounted only when active: both run their own queries, and
            firing them on every Analytics visit would cost every seller a sync
            probe and a cohort read they didn't ask for. `embedded` drops their
            duplicate titles while keeping their controls. */}
        <TabsContent value="performance" className="mt-6">
          {tab === "performance" && (
            <Suspense fallback={<Loading />}>
              <ListingPerformancePage embedded />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="community" className="mt-6">
          {tab === "community" && (
            <Suspense fallback={<Loading />}>
              <CommunityInsightsPage embedded />
            </Suspense>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// The range preset lives in the URL and is read by every tab that windows its
// data; the curve reads it here so its module never has to know about presets.
// Reads the shared range preset so the scorecard windows with everything else.
function ScorecardHost() {
  const [preset] = usePresetParam();
  const periodStart = useMemo(() => presetStart(preset), [preset]);
  return <SellerScorecardCard periodStart={periodStart} />;
}

function PriceCurveTab() {
  const [preset] = usePresetParam();
  const periodStart = useMemo(() => presetStart(preset), [preset]);
  return <PriceCurveReport periodStart={periodStart} />;
}

function Loading() {
  return (
    <LoadingRegion label="Loading report" className="py-4">
      <ChartSkeleton />
    </LoadingRegion>
  );
}

function SellThroughReport() {
  const user = useAuthStore((s) => s.user);
  const [preset] = usePresetParam();
  const [groupKey, setGroupKey] = useGroupKeyParam();

  const periodStart = useMemo(() => presetStart(preset), [preset]);
  const { data: rows = [], isLoading } = useQuery({
    // Kept under the "items_full" prefix so the same mutation invalidations that
    // refresh the pipeline/listings caches also refresh these aggregates.
    queryKey: ["items_full", "analytics", "sell-through", user?.id, groupKey, preset],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchSellThrough(groupKey, periodStart),
  });

  // US-2234 (AC1): revenue + net-profit trend over the selected period. Reuses
  // the finances_dashboard RPC's time_series (the only server-side time series we
  // have) rather than adding a second one; shares the same cache key prefix.
  const { data: trend = [] } = useQuery({
    queryKey: ["items_full", "analytics", "trend", user?.id, preset],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const dash = await fetchFinancesDashboard(periodStart);
      return dash.time_series ?? [];
    },
  });

  if (isLoading) return <Loading />;

  const chartData = rows.slice(0, 12).map((r) => ({
    name: r.group,
    rate: r.sellThrough != null ? Math.round(r.sellThrough * 100) : 0,
    sold: r.sold,
    listed: r.listed,
  }));

  function exportCsv() {
    downloadCsv(
      `flipdesk-sell-through-by-${groupKey}-${csvDate()}.csv`,
      [
        groupKey,
        "Listed",
        "Sold",
        "Sell-through %",
        "Avg net profit",
        "Median days to sell",
      ],
      rows.map((r) => [
        r.group,
        r.listed,
        r.sold,
        r.sellThrough != null ? Math.round(r.sellThrough * 100) : "",
        r.avgNetProfit ?? "",
        r.medianDaysToSell != null ? Math.round(r.medianDaysToSell) : "",
      ]),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={groupKey} onValueChange={(v) => setGroupKey(v as GroupKey)}>
          <SelectTrigger className="w-44" aria-label="Group profit by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="category">By category</SelectItem>
            <SelectItem value="brand">By brand</SelectItem>
            <SelectItem value="source">By source</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={rows.length === 0}
          onClick={exportCsv}
        >
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* US-2820: the one dollar figure, above the charts that explain it. */}
      <Suspense fallback={null}>
        <PriceGapCard periodStart={periodStart} />
      </Suspense>

      {trend.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4" />
              Revenue &amp; net profit over time
            </CardTitle>
            <CardDescription>
              Daily revenue and net profit for the selected period.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<ChartSkeleton />}>
              <AnalyticsTrendChart data={trend} />
            </Suspense>
          </CardContent>
        </Card>
      )}

      {/* US-1473/US-1422: eBay account + listing health. Self-gate on connection. */}
      <div className="grid gap-4 md:grid-cols-2">
        <EbayAccountHealthCard />
        <EbayListingHealthCard />
      </div>

      {/* US-1870: Inventory Equity — estimated liquidation value of graded stock.
          Self-gates (renders nothing when the kill-switch is off). */}
      <InventoryEquityCard />

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No listed or sold items in this range yet.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4" />
                Sell-through rate by {groupKey}
              </CardTitle>
              <CardDescription>
                Sold ÷ listed, for items with a list date in range. Top 12
                shown.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Suspense fallback={<ChartSkeleton />}>
                <SellThroughChart data={chartData} />
              </Suspense>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detail</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="capitalize">{groupKey}</TableHead>
                    <TableHead className="text-right">Listed</TableHead>
                    <TableHead className="text-right">Sold</TableHead>
                    <TableHead className="text-right">Sell-through</TableHead>
                    <TableHead className="text-right">Avg net profit</TableHead>
                    <TableHead className="text-right">
                      Median days to sell
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.group}>
                      <TableCell className="font-medium">{r.group}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.listed}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.sold}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {pct(r.sellThrough)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {usd(r.avgNetProfit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.medianDaysToSell != null
                          ? `${Math.round(r.medianDaysToSell)}d`
                          : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function GradingRoiReport() {
  const user = useAuthStore((s) => s.user);
  // US-2234 (AC3): honour the same period presets as the sibling tabs. The RPCs
  // now take p_period_start (migration 00505); periodStart flows into both.
  const [preset] = usePresetParam();
  const periodStart = useMemo(() => presetStart(preset), [preset]);
  const { data: buckets = [], isLoading } = useQuery({
    queryKey: ["items_full", "analytics", "grading-roi", user?.id, preset],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchGradingRoi(periodStart),
  });
  const { data: summary = null, isLoading: summaryLoading } = useQuery({
    queryKey: ["items_full", "analytics", "grading-roi-summary", user?.id, preset],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchGradingRoiSummary(periodStart),
  });

  if (isLoading || summaryLoading) return <Loading />;

  const meaningful = buckets.filter((b) => b.meaningful);
  const callouts = meaningful
    .filter((b) => b.netProfitLift != null && b.netProfitLift > 0)
    .sort((a, b) => (b.netProfitLift ?? 0) - (a.netProfitLift ?? 0));

  // US-2234: chart the profit lift for the meaningful buckets (top 12 by lift).
  const liftChart = meaningful
    .filter((b) => b.netProfitLift != null)
    .sort((a, b) => (b.netProfitLift ?? 0) - (a.netProfitLift ?? 0))
    .slice(0, 12)
    .map((b) => ({
      name: `${b.category} · ${b.band}`,
      value: Math.round(b.netProfitLift ?? 0),
    }));

  function exportCsv() {
    downloadCsv(
      `flipdesk-grading-roi-${csvDate()}.csv`,
      [
        "Category",
        "Price band",
        "Graded n",
        "Graded avg profit",
        "Ungraded n",
        "Ungraded avg profit",
        "Profit lift",
        "Days faster",
        "Meaningful",
      ],
      buckets.map((b) => {
        const faster =
          b.graded.medianDaysToSell != null && b.ungraded.medianDaysToSell != null
            ? b.ungraded.medianDaysToSell - b.graded.medianDaysToSell
            : null;
        return [
          b.category,
          b.band,
          b.graded.count,
          b.graded.avgNetProfit ?? "",
          b.ungraded.count,
          b.ungraded.avgNetProfit ?? "",
          b.netProfitLift ?? "",
          faster != null ? Math.round(faster) : "",
          b.meaningful ? "yes" : "no",
        ];
      }),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={buckets.length === 0}
          onClick={exportCsv}
        >
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>
      <RoiHeadline summary={summary} />

      {/* US-2821: what each flaw costs, measured within its own grade band. */}
      <Suspense fallback={null}>
        <DefectCostSection periodStart={periodStart} />
      </Suspense>

      <Card>
        <CardContent className="pt-6">
          <ShareOutcomesToggle />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Award className="h-4 w-4" />
            Where grading lifts profit most
          </CardTitle>
          <CardDescription>
            Graded vs ungraded sold items, bucketed by category and sale-price
            band. Buckets with fewer than {MIN_BUCKET_SIZE} items on either side
            are shown but not counted — too small to trust.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {callouts.length > 0 ? (
            <ul className="space-y-2">
              {callouts.map((b) => (
                <li
                  key={`${b.category}-${b.band}`}
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
                >
                  Graded items sell for{" "}
                  <span className="font-bold text-emerald-700 dark:text-emerald-300">
                    {usd(b.netProfitLift)} more
                  </span>{" "}
                  net profit on average in{" "}
                  <span className="font-medium">{b.category}</span> /{" "}
                  <span className="font-medium">{b.band}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    ({b.graded.count} graded vs {b.ungraded.count} ungraded)
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {meaningful.length === 0
                ? `Not enough sold items yet — need ${MIN_BUCKET_SIZE}+ graded and ${MIN_BUCKET_SIZE}+ ungraded within a single category and price band.`
                : "No bucket shows a positive grading lift yet."}
            </p>
          )}
        </CardContent>
      </Card>

      {liftChart.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Net profit lift by bucket</CardTitle>
            <CardDescription>
              How much more (or less) graded items net than ungraded, per
              category and price band. Top 12 by lift.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<ChartSkeleton />}>
              <AnalyticsBarChart data={liftChart} unit="$" label="Profit lift" />
            </Suspense>
          </CardContent>
        </Card>
      )}

      {buckets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">All buckets</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Price band</TableHead>
                  <TableHead className="text-right">Graded n</TableHead>
                  <TableHead className="text-right">
                    Graded avg profit
                  </TableHead>
                  <TableHead className="text-right">Ungraded n</TableHead>
                  <TableHead className="text-right">
                    Ungraded avg profit
                  </TableHead>
                  <TableHead className="text-right">Profit lift</TableHead>
                  <TableHead className="text-right">Days faster</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buckets.map((b) => (
                  <TableRow
                    key={`${b.category}-${b.band}`}
                    className={b.meaningful ? "" : "opacity-50"}
                  >
                    <TableCell className="font-medium">
                      {b.category}
                      {!b.meaningful && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          low n
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{b.band}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.graded.count}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {usd(b.graded.avgNetProfit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.ungraded.count}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {usd(b.ungraded.avgNetProfit)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono tabular-nums ${
                        b.netProfitLift != null && b.netProfitLift > 0
                          ? "text-emerald-700 dark:text-emerald-300"
                          : b.netProfitLift != null && b.netProfitLift < 0
                            ? "text-destructive"
                            : ""
                      }`}
                    >
                      {b.netProfitLift != null
                        ? `${b.netProfitLift > 0 ? "+" : ""}${usd(b.netProfitLift)}`
                        : "—"}
                    </TableCell>
                    {(() => {
                      const faster =
                        b.graded.medianDaysToSell != null &&
                        b.ungraded.medianDaysToSell != null
                          ? b.ungraded.medianDaysToSell -
                            b.graded.medianDaysToSell
                          : null;
                      return (
                        <TableCell
                          className={`text-right tabular-nums ${
                            faster != null && faster > 0
                              ? "text-emerald-700 dark:text-emerald-300"
                              : faster != null && faster < 0
                                ? "text-destructive"
                                : ""
                          }`}
                        >
                          {faster != null
                            ? `${faster > 0 ? "+" : ""}${Math.round(faster)}d`
                            : "—"}
                        </TableCell>
                      );
                    })()}
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

// US-858: the first thing a seller sees on the Grading-ROI tab — the overall
// graded-vs-ungraded proof (sell-through %, median days-to-sell, net-profit
// lift) computed server-side over the whole account. Headlined only when the
// sample is statistically meaningful (>= MIN_BUCKET_SIZE realized sales each
// side); otherwise the numbers are shown muted with a "too early to call" note
// so nothing is overstated on thin data.
function RoiHeadline({ summary }: { summary: GradingRoiSummary | null }) {
  const s = summary;
  const hasAny =
    !!s && (s.graded.sold > 0 || s.ungraded.sold > 0);

  // Build the lead sentence only from signals the data actually supports.
  const parts: string[] = [];
  if (s?.meaningful) {
    if (s.daysFaster != null && Math.round(s.daysFaster) >= 1) {
      parts.push(`sell ${Math.round(s.daysFaster)} day${
        Math.round(s.daysFaster) === 1 ? "" : "s"
      } faster`);
    }
    if (s.netProfitLift != null && s.netProfitLift > 0) {
      parts.push(`net ${usd(s.netProfitLift)} more`);
    }
    if (s.sellThroughLift != null && s.sellThroughLift > 0) {
      parts.push(`sell through ${pct(s.sellThroughLift)} more often`);
    }
  }
  const lead = parts.length > 0 ? parts.join(", ") : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Award className="h-4 w-4" />
          Does grading pay off?
        </CardTitle>
        <CardDescription>
          Your graded items vs your ungraded items across every sale. We only
          headline the lift once both sides have at least {MIN_BUCKET_SIZE}{" "}
          sales — too small to trust otherwise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasAny ? (
          <p className="py-2 text-center text-sm text-muted-foreground">
            No sales yet. Once graded and ungraded items start selling, we&apos;ll
            show whether grading lifts your sell-through, speed, and profit.
          </p>
        ) : (
          <>
            {lead ? (
              <p className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                Your graded items <span className="font-bold text-emerald-700 dark:text-emerald-300">{lead}</span>{" "}
                than your ungraded items.
              </p>
            ) : (
              <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                {s?.meaningful
                  ? "Across your sales so far, graded items haven't shown a measurable edge yet."
                  : `Too early to call — need ${MIN_BUCKET_SIZE}+ graded and ${MIN_BUCKET_SIZE}+ ungraded sales to compare reliably (${
                      s?.graded.sold ?? 0
                    } graded, ${s?.ungraded.sold ?? 0} ungraded so far).`}
              </p>
            )}

            <div
              className={`grid gap-3 sm:grid-cols-3 ${
                s?.meaningful ? "" : "opacity-60"
              }`}
            >
              <RoiStatTile
                icon={Percent}
                label="Sell-through"
                graded={pct(s?.graded.sellThrough)}
                ungraded={pct(s?.ungraded.sellThrough)}
              />
              <RoiStatTile
                icon={Clock}
                label="Median days to sell"
                graded={
                  s?.graded.medianDaysToSell != null
                    ? `${Math.round(s.graded.medianDaysToSell)}d`
                    : "—"
                }
                ungraded={
                  s?.ungraded.medianDaysToSell != null
                    ? `${Math.round(s.ungraded.medianDaysToSell)}d`
                    : "—"
                }
              />
              <RoiStatTile
                icon={DollarSign}
                label="Avg net profit"
                graded={usd(s?.graded.avgNetProfit)}
                ungraded={usd(s?.ungraded.avgNetProfit)}
              />
            </div>

            {!s?.meaningful && (
              <p className="text-center text-xs text-muted-foreground">
                Shown for reference — not yet a large enough sample to headline.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RoiStatTile({
  icon: Icon,
  label,
  graded,
  ungraded,
}: {
  icon: typeof Percent;
  label: string;
  graded: string;
  ungraded: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </p>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Graded
          </p>
          <p className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
            {graded}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Ungraded
          </p>
          <p className="text-lg font-semibold tabular-nums text-muted-foreground">
            {ungraded}
          </p>
        </div>
      </div>
    </div>
  );
}

// US-595: returns tied back to grade. The "items graded <=6 return Nx more"
// headline + a grade-backed condition-guarantee surface the seller can copy
// into their listings. Return rate = refunded ÷ fulfilled (shipped) sales.
function ReturnReductionReport() {
  const user = useAuthStore((s) => s.user);
  const [preset] = usePresetParam();

  const periodStart = useMemo(() => presetStart(preset), [preset]);
  const { data, isLoading } = useQuery({
    queryKey: ["items_full", "analytics", "returns", user?.id, preset],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchReturnReduction(periodStart),
  });

  if (isLoading) return <Loading />;

  const summary = data ?? {
    overall: { sold: 0, returns: 0, returnRate: null } as ReturnStat,
    graded: { sold: 0, returns: 0, returnRate: null } as ReturnStat,
    ungraded: { sold: 0, returns: 0, returnRate: null } as ReturnStat,
    bands: [],
  };

  const advantage = gradedReturnAdvantage(summary);
  const lowVsHigh = lowVsHighBandMultiplier(summary);
  const highBand = summary.bands.find((b) => b.key === "high");

  function exportCsv() {
    downloadCsv(
      `flipdesk-returns-by-grade-${csvDate()}.csv`,
      ["Grade band", "Shipped", "Returns", "Return rate %"],
      [
        ...summary.bands.map((b) => [
          b.label,
          b.sold,
          b.returns,
          b.returnRate != null ? Math.round(b.returnRate * 100) : "",
        ]),
        [
          "All shipped sales",
          summary.overall.sold,
          summary.overall.returns,
          summary.overall.returnRate != null
            ? Math.round(summary.overall.returnRate * 100)
            : "",
        ],
      ],
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={summary.overall.sold === 0}
          onClick={exportCsv}
        >
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {summary.overall.sold === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No shipped sales in this range yet. Once you have completed and
            refunded sales, we&apos;ll show how returns track with grade.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Undo2 className="h-4 w-4" />
                Do lower grades come back more often?
              </CardTitle>
              <CardDescription>
                Return rate = refunded ÷ shipped (completed + refunded) sales,
                across your history. Bands with fewer than {MIN_RETURN_SAMPLE}{" "}
                shipped sales are shown but kept out of the headlines — too small
                to trust.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {lowVsHigh ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  Items{" "}
                  <span className="font-medium">{lowVsHigh.low.label}</span>{" "}
                  come back{" "}
                  <span className="font-bold text-destructive">
                    {lowVsHigh.multiplier.toFixed(1)}× more often
                  </span>{" "}
                  than your{" "}
                  <span className="font-medium">{lowVsHigh.high.label}</span>{" "}
                  items ({pct(lowVsHigh.low.returnRate)} vs{" "}
                  {pct(lowVsHigh.high.returnRate)}).
                </p>
              ) : null}
              {advantage ? (
                <p className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                  Your graded items return{" "}
                  <span className="font-bold text-emerald-700 dark:text-emerald-300">
                    {advantage.toFixed(1)}× less often
                  </span>{" "}
                  than ungraded ({pct(summary.graded.returnRate)} vs{" "}
                  {pct(summary.ungraded.returnRate)}).
                </p>
              ) : null}
              {!lowVsHigh && !advantage ? (
                <p className="py-2 text-center text-sm text-muted-foreground">
                  Not enough shipped sales yet to call a reliable difference —
                  need {MIN_RETURN_SAMPLE}+ on each side you&apos;re comparing.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {(() => {
            const bandChart = summary.bands
              .filter((b) => b.sold > 0 && b.returnRate != null)
              .map((b) => ({
                name: b.label,
                value: Math.round((b.returnRate ?? 0) * 100),
              }));
            return bandChart.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Return rate by grade band
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Suspense fallback={<ChartSkeleton />}>
                    <AnalyticsBarChart
                      data={bandChart}
                      unit="%"
                      color="#E94560"
                      label="Return rate"
                      domain={[0, "auto"]}
                    />
                  </Suspense>
                </CardContent>
              </Card>
            ) : null;
          })()}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detail</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Grade band</TableHead>
                    <TableHead className="text-right">Shipped</TableHead>
                    <TableHead className="text-right">Returns</TableHead>
                    <TableHead className="text-right">Return rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.bands.map((b) => {
                    const lowN = b.sold > 0 && b.sold < MIN_RETURN_SAMPLE;
                    return (
                      <TableRow
                        key={b.key}
                        className={b.sold === 0 ? "opacity-50" : ""}
                      >
                        <TableCell className="font-medium">
                          {b.label}
                          {lowN && (
                            <Badge
                              variant="outline"
                              className="ml-2 text-[10px]"
                            >
                              low n
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {b.sold}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {b.returns}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {pct(b.returnRate)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="border-t-2 font-medium">
                    <TableCell>All shipped sales</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {summary.overall.sold}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {summary.overall.returns}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {pct(summary.overall.returnRate)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <ConditionGuaranteeCard highBand={highBand} />
        </>
      )}
    </div>
  );
}

// AC #2: an OPTIONAL grade-backed "condition guarantee" surface that targets
// return reduction. Only meaningful once the seller has a trustworthy
// high-grade track record; we build the guarantee blurb from their own numbers
// (no fabricated claims) and let them copy it straight into a listing.
function ConditionGuaranteeCard({
  highBand,
}: {
  highBand:
    | { sold: number; returns: number; returnRate: number | null }
    | undefined;
}) {
  const ready =
    !!highBand &&
    highBand.sold >= MIN_RETURN_SAMPLE &&
    highBand.returnRate != null;

  const keptRate =
    highBand && highBand.returnRate != null ? 1 - highBand.returnRate : null;

  const blurb = ready
    ? `Condition guarantee: this item is independently graded 8.5–10.0. Across ${
        highBand!.sold
      } graded sales at this tier, ${pct(
        keptRate,
      )} shipped return-free. If it arrives in worse condition than its grade certificate states, return it for a full refund.`
    : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          Grade-backed condition guarantee
        </CardTitle>
        <CardDescription>
          Offering a guarantee on your highest-graded items signals confidence
          and pulls returns down further. We only generate it from your real
          track record.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ready ? (
          <>
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              {blurb}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                navigator.clipboard
                  .writeText(blurb)
                  .then(() => toast.success("Guarantee text copied"))
                  .catch(() => toast.error("Couldn't copy to clipboard"));
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy guarantee text
            </Button>
          </>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">
            Need {MIN_RETURN_SAMPLE}+ shipped sales graded 8.5–10.0 before we
            can back a guarantee with your own numbers. Keep grading your best
            items and check back.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

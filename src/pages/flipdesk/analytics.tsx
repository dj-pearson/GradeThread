import { lazy, Suspense, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BarChart3,
  TrendingUp,
  Award,
  ShieldCheck,
  Undo2,
  Copy,
} from "lucide-react";
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
import { MIN_BUCKET_SIZE, type GroupKey } from "@/lib/flipdesk-analytics";
import {
  fetchSellThrough,
  fetchGradingRoi,
} from "@/lib/flipdesk-analytics-server";
import {
  fetchReturnReduction,
  gradedReturnAdvantage,
  lowVsHighBandMultiplier,
  MIN_RETURN_SAMPLE,
  type ReturnStat,
} from "@/lib/flipdesk-returns-analytics";
import { ChartSkeleton, LoadingRegion } from "@/components/ui/skeletons";

// Lazy-load the Recharts bar chart at the chart boundary so the route-entry
// chunk stays light and the page shell + table paint before Recharts streams
// in (US-408).
const SellThroughChart = lazy(() =>
  import("@/components/flipdesk/sell-through-chart").then((m) => ({
    default: m.SellThroughChart,
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

export function FlipdeskAnalyticsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = location.pathname.endsWith("/grading-roi")
    ? "grading-roi"
    : location.pathname.endsWith("/returns")
      ? "returns"
      : "sell-through";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
          <BarChart3 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            What sells, what doesn&apos;t, and whether grading pays off.
          </p>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) =>
          navigate(
            v === "grading-roi"
              ? "/dashboard/flipdesk/analytics/grading-roi"
              : v === "returns"
                ? "/dashboard/flipdesk/analytics/returns"
                : "/dashboard/flipdesk/analytics",
          )
        }
      >
        <TabsList>
          <TabsTrigger value="sell-through">Sell-through</TabsTrigger>
          <TabsTrigger value="grading-roi">Grading ROI</TabsTrigger>
          <TabsTrigger value="returns">Return reduction</TabsTrigger>
        </TabsList>

        <TabsContent value="sell-through" className="mt-6">
          <SellThroughReport />
        </TabsContent>

        <TabsContent value="grading-roi" className="mt-6">
          <GradingRoiReport />
        </TabsContent>

        <TabsContent value="returns" className="mt-6">
          <ReturnReductionReport />
        </TabsContent>
      </Tabs>
    </div>
  );
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
  const [preset, setPreset] = useState<Preset>("all");
  const [groupKey, setGroupKey] = useState<GroupKey>("category");

  const periodStart = useMemo(() => presetStart(preset), [preset]);
  const { data: rows = [], isLoading } = useQuery({
    // Kept under the "items_full" prefix so the same mutation invalidations that
    // refresh the pipeline/listings caches also refresh these aggregates.
    queryKey: ["items_full", "analytics", "sell-through", user?.id, groupKey, preset],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchSellThrough(groupKey, periodStart),
  });

  if (isLoading) return <Loading />;

  const chartData = rows.slice(0, 12).map((r) => ({
    name: r.group,
    rate: r.sellThrough != null ? Math.round(r.sellThrough * 100) : 0,
    sold: r.sold,
    listed: r.listed,
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={groupKey} onValueChange={(v) => setGroupKey(v as GroupKey)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="category">By category</SelectItem>
            <SelectItem value="brand">By brand</SelectItem>
            <SelectItem value="source">By source</SelectItem>
          </SelectContent>
        </Select>
        <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
            <SelectItem value="12mo">Last 12 months</SelectItem>
          </SelectContent>
        </Select>
      </div>

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
  const { data: buckets = [], isLoading } = useQuery({
    queryKey: ["items_full", "analytics", "grading-roi", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchGradingRoi(),
  });

  if (isLoading) return <Loading />;

  const meaningful = buckets.filter((b) => b.meaningful);
  const callouts = meaningful
    .filter((b) => b.netProfitLift != null && b.netProfitLift > 0)
    .sort((a, b) => (b.netProfitLift ?? 0) - (a.netProfitLift ?? 0));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Award className="h-4 w-4" />
            Does grading lift profit?
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
                  <TableHead className="text-right">Lift</TableHead>
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

// US-595: returns tied back to grade. The "items graded <=6 return Nx more"
// headline + a grade-backed condition-guarantee surface the seller can copy
// into their listings. Return rate = refunded ÷ fulfilled (shipped) sales.
function ReturnReductionReport() {
  const user = useAuthStore((s) => s.user);
  const [preset, setPreset] = useState<Preset>("all");

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
            <SelectItem value="12mo">Last 12 months</SelectItem>
          </SelectContent>
        </Select>
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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Return rate by grade band</CardTitle>
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

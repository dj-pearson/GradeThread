import { lazy, Suspense, useMemo } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Download, LineChart, Lock, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { ChartSkeleton, LoadingRegion } from "@/components/ui/skeletons";
import { downloadCsv } from "@/lib/csv-export";
import { useAuthStore } from "@/stores/auth-store";
import { fetchSellThrough } from "@/lib/flipdesk-analytics-server";
import {
  curveHeadline,
  effectivePrice,
  EMPTY_CURVE,
  fetchConditionPriceCurve,
  isCurveEmpty,
  MIN_CURVE_SAMPLE,
  suppressedBuckets,
  type ConditionPriceCurve,
} from "@/lib/condition-price-curve";
import type { CurveDatum } from "@/components/flipdesk/condition-curve-chart";

// US-2819: the Condition Price Curve tab.
//
// Every other grade report in FlipDesk buckets to grade_tier, which is 7 steps.
// This one keeps all 19 half points, because the question a seller actually has
// is "8.5 or 8.0", and the tier answer to that is "Excellent either way".
//
// The tab owns no aggregation: condition_price_curve() (00651) returns the
// buckets already suppressed, and src/lib/condition-price-curve.ts owns the
// reading rules. What lives here is the picker, the chart shape and the copy.

const ConditionCurveChart = lazy(() =>
  import("@/components/flipdesk/condition-curve-chart").then((m) => ({
    default: m.ConditionCurveChart,
  })),
);
// US-2820: the item-level detail behind the "money left on the table" figure
// lives here, beside the curve that produced it.
const PriceGapDetail = lazy(() =>
  import("@/components/flipdesk/price-gap-card").then((m) => ({
    default: m.PriceGapDetail,
  })),
);

const ALL = "__all__";

const usd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;

const csvDate = (): string => new Date().toISOString().slice(0, 10);

/** Brand / category filter, in the URL so a curve is a shareable link. */
function useCurveFilters(): {
  brand: string | null;
  category: string | null;
  setBrand: (v: string | null) => void;
  setCategory: (v: string | null) => void;
} {
  const [sp, setSp] = useSearchParams();
  const set = (key: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(key, v);
    else next.delete(key);
    setSp(next, { replace: true });
  };
  return {
    brand: sp.get("brand"),
    category: sp.get("category"),
    setBrand: (v) => set("brand", v),
    setCategory: (v) => set("category", v),
  };
}

export function PriceCurveReport({
  periodStart,
}: {
  periodStart: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const { brand, category, setBrand, setCategory } = useCurveFilters();

  // The picker options are the seller's OWN brands and categories, read from
  // the sell-through RPC that the neighbouring tab already caches. A dedicated
  // "distinct brands" endpoint would be a second round trip for a list this
  // page can have for free.
  const { data: brandRows = [] } = useQuery({
    queryKey: ["items_full", "analytics", "sell-through", user?.id, "brand", "all"],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchSellThrough("brand", null),
  });
  const { data: categoryRows = [] } = useQuery({
    queryKey: ["items_full", "analytics", "sell-through", user?.id, "category", "all"],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchSellThrough("category", null),
  });

  const { data: curve = EMPTY_CURVE, isLoading } = useQuery<ConditionPriceCurve>({
    queryKey: [
      "items_full",
      "analytics",
      "price-curve",
      user?.id,
      brand,
      category,
      periodStart,
    ],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchConditionPriceCurve({ brand, category, periodStart }),
  });

  // Only buckets with something on either side reach the chart. A numeric x
  // axis then spaces a missing 8.0 correctly instead of the chart implying a
  // reading it does not have.
  const chartData: CurveDatum[] = useMemo(
    () =>
      curve.buckets
        .filter((b) => b.ownCount > 0 || b.cohortCount > 0)
        .map((b) => ({
          grade: b.grade,
          band:
            b.cohortP25Price != null && b.cohortP75Price != null
              ? ([b.cohortP25Price, b.cohortP75Price] as [number, number])
              : null,
          cohort: b.cohortMedianPrice,
          own: b.ownMedianPrice,
        })),
    [curve],
  );

  const headline = useMemo(() => curveHeadline(curve), [curve]);
  const suppressed = useMemo(() => suppressedBuckets(curve), [curve]);
  const scopeLabel = brand ?? category ?? "all graded items";

  function exportCsv() {
    downloadCsv(
      `flipdesk-condition-price-curve-${csvDate()}.csv`,
      [
        "Grade",
        "Your sales",
        "Your median price",
        "Your median days",
        "Cohort sales",
        "Cohort sellers",
        "Cohort median price",
        "Cohort p25",
        "Cohort p75",
        "Cohort median days",
        "Cohort suppressed",
      ],
      curve.buckets
        .filter((b) => b.ownCount > 0 || b.cohortCount > 0)
        .map((b) => [
          b.grade.toFixed(1),
          b.ownCount,
          b.ownMedianPrice ?? "",
          b.ownMedianDays ?? "",
          b.cohortCount,
          b.cohortSellers,
          b.cohortMedianPrice ?? "",
          b.cohortP25Price ?? "",
          b.cohortP75Price ?? "",
          b.cohortMedianDays ?? "",
          b.cohortSuppressed ? "yes" : "no",
        ]),
    );
  }

  if (isLoading) {
    return (
      <LoadingRegion label="Loading the price curve">
        <ChartSkeleton />
      </LoadingRegion>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={brand ?? ALL}
          onValueChange={(v) => setBrand(v === ALL ? null : v)}
        >
          <SelectTrigger className="w-52" aria-label="Filter the curve by brand">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All brands</SelectItem>
            {brandRows.map((r) => (
              <SelectItem key={r.group} value={r.group}>
                {r.group}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={category ?? ALL}
          onValueChange={(v) => setCategory(v === ALL ? null : v)}
        >
          <SelectTrigger className="w-52" aria-label="Filter the curve by category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {categoryRows.map((r) => (
              <SelectItem key={r.group} value={r.group}>
                {r.group}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={chartData.length === 0}
          onClick={exportCsv}
        >
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {isCurveEmpty(curve) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No sales to draw yet</CardTitle>
            <CardDescription>
              The curve is built from graded items that actually sold. Once
              {brand || category ? ` ${scopeLabel} has` : " your account has"} a
              few, this fills in.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {headline && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="h-4 w-4" />
                  What a half grade point is worth
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-2xl font-bold">
                  {usd(headline.perHalfPoint)}{" "}
                  <span className="text-base font-normal text-muted-foreground">
                    per half point
                  </span>
                </p>
                <p className="text-sm text-muted-foreground">
                  For {scopeLabel}, a {headline.lowGrade.toFixed(1)} clears{" "}
                  {usd(headline.lowPrice)} and a {headline.highGrade.toFixed(1)}{" "}
                  clears {usd(headline.highPrice)}. That is an estimate from{" "}
                  {headline.source === "cohort"
                    ? "seller cohort medians"
                    : "your own sales, because the cohort was too small to quote"}
                  .
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <LineChart className="h-4 w-4" />
                Price by grade
              </CardTitle>
              <CardDescription>
                Median realized sale price at each half grade point. The shaded
                band is the middle half of cohort sales.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Suspense fallback={<ChartSkeleton />}>
                <ConditionCurveChart data={chartData} />
              </Suspense>
            </CardContent>
          </Card>

          {suppressed.length > 0 && (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {suppressed.length}{" "}
                {suppressed.length === 1 ? "grade has" : "grades have"} cohort
                sales but fewer than {curve.minSellers} sellers behind them, so
                no cohort price is shown for{" "}
                {suppressed.map((b) => b.grade.toFixed(1)).join(", ")}. Counts
                are shown in the table so a hidden figure never reads as a
                missing market.
              </span>
            </p>
          )}

          <Suspense fallback={null}>
            <PriceGapDetail periodStart={periodStart} />
          </Suspense>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Every grade</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Grade</TableHead>
                    <TableHead className="text-right">Your sales</TableHead>
                    <TableHead className="text-right">Your median</TableHead>
                    <TableHead className="text-right">Cohort sales</TableHead>
                    <TableHead className="text-right">Cohort median</TableHead>
                    <TableHead className="text-right">Cohort range</TableHead>
                    <TableHead className="pr-6 text-right">Days to sell</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {curve.buckets
                    .filter((b) => b.ownCount > 0 || b.cohortCount > 0)
                    .map((b) => {
                      const eff = effectivePrice(b);
                      const thin =
                        eff.price != null && eff.count < MIN_CURVE_SAMPLE;
                      return (
                        <TableRow key={b.grade}>
                          <TableCell className="pl-6 font-medium">
                            {b.grade.toFixed(1)}
                            {thin && (
                              <Badge variant="outline" className="ml-2">
                                thin
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {b.ownCount}
                          </TableCell>
                          <TableCell className="text-right">
                            {usd(b.ownMedianPrice)}
                          </TableCell>
                          <TableCell className="text-right">
                            {b.cohortCount}
                          </TableCell>
                          <TableCell className="text-right">
                            {b.cohortSuppressed ? (
                              <span className="text-muted-foreground">
                                {b.cohortSellers} of {curve.minSellers} sellers
                              </span>
                            ) : (
                              usd(b.cohortMedianPrice)
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {b.cohortP25Price != null && b.cohortP75Price != null
                              ? `${usd(b.cohortP25Price)} – ${usd(b.cohortP75Price)}`
                              : "—"}
                          </TableCell>
                          <TableCell className="pr-6 text-right">
                            {b.cohortMedianDays != null
                              ? `${Math.round(b.cohortMedianDays)}d`
                              : b.ownMedianDays != null
                                ? `${Math.round(b.ownMedianDays)}d`
                                : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

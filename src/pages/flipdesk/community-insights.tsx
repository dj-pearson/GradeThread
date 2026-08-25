import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Users,
  TrendingUp,
  Award,
  Lock,
  ArrowUpRight,
  ArrowDownRight,
  Lightbulb,
  Percent,
  Clock,
  BarChart3,
  Tags,
  Download,
} from "lucide-react";
import { downloadCsv } from "@/lib/csv-export";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
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
import { TableLoadingSkeleton } from "@/components/ui/skeletons";
import {
  fetchCommunityBenchmarks,
  hasActiveFilters,
  normalizeBenchmarkFilters,
  type CommunityBenchmarkFilters,
  MIN_COHORT_SELLERS,
} from "@/lib/community-benchmarks";
import { deriveRecommendations } from "@/lib/community-recommendations";
import { RecommendationRow } from "@/components/flipdesk/community-insights-widget";

const pct = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `${Math.round(n * 100)}%`;
const usd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;
const days = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n)
    ? "—"
    : `${n % 1 === 0 ? n : n.toFixed(1)} ${n === 1 ? "day" : "days"}`;
/** Month key "YYYY-MM" → short label e.g. "Jun". */
const monthLabel = (key: string): string => {
  const [, m] = key.split("-");
  const idx = Number(m) - 1;
  const names = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return names[idx] ?? key;
};

type Preset = "all" | "90d" | "12mo";

function presetStart(p: Preset): string | null {
  if (p === "all") return null;
  const days = p === "90d" ? 90 : 365;
  const from = new Date();
  from.setDate(from.getDate() - days);
  return from.toISOString().slice(0, 10);
}

// US-2235: dismissed recommendations persist across refreshes (keyed by rec id,
// which is stable for a given cohort signal). Best-effort — a storage failure
// just means nothing is remembered, never a crash.
const DISMISSED_RECS_KEY = "flipdesk.community.dismissedRecs";
const RECS_PREVIEW_COUNT = 6;

function loadDismissedRecs(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_RECS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveDismissedRecs(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_RECS_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore — dismissal simply won't persist
  }
}

/** US-2161: `embedded` — see FlipdeskListingPerformancePage for the contract. */
export function FlipdeskCommunityInsightsPage(
  { embedded = false }: { embedded?: boolean } = {},
) {
  const [preset, setPreset] = useState<Preset>("12mo");
  const periodStart = useMemo(() => presetStart(preset), [preset]);
  // US-2235 AC1. Two pieces of state, not one, and the split is the point: the
  // DRAFT is what the inputs hold while someone is typing, and `filters` is what
  // has actually been submitted. Firing the query per keystroke would re-run a
  // platform-wide aggregate over every reseller's inventory on every character.
  const [draft, setDraft] = useState<CommunityBenchmarkFilters>({});
  const [filters, setFilters] = useState<CommunityBenchmarkFilters>({});
  // US-2235: recommendations are dismissible + expandable beyond the preview.
  const [dismissedRecs, setDismissedRecs] = useState<Set<string>>(loadDismissedRecs);
  const [showAllRecs, setShowAllRecs] = useState(false);

  function dismissRec(id: string) {
    setDismissedRecs((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedRecs(next);
      return next;
    });
  }

  // Normalized into the key as well as the call, so "Nike" and " nike " are one
  // cache entry rather than two identical queries.
  const activeFilters = useMemo(() => normalizeBenchmarkFilters(filters), [filters]);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["community-benchmarks", periodStart, activeFilters],
    queryFn: () => fetchCommunityBenchmarks(periodStart, activeFilters),
    staleTime: 5 * 60 * 1000,
  });

  // US-2829 AC1/AC6: the two TABLES on this page, exportable with the same
  // headers they show.
  //
  // ⚠ THIS PAGE IS NOT THE SELLER'S OWN DATA, which changes what a safe export
  // means. Community Insights is a cross-seller aggregate, and every figure on
  // it has already passed the k-anonymity floor — a brand or category below
  // `meta.minSellers` is not rendered at all, and the per-cohort
  // medianRealization / medianDaysToSell arrive null when their own sub-cohort
  // is too thin. So the rule here is simple and strict: write EXACTLY what the
  // table shows and nothing the table withheld. A null stays empty rather than
  // becoming a zero, because zero is a claim and blank is an absence.
  //
  // Only the two tables export. The rest of the page is distributions and
  // sparklines whose on-screen form has no columns to match, and inventing
  // headers for them would be the decoder AC6 exists to avoid.
  const csvDate = () => new Date().toISOString().slice(0, 10);

  function exportBrandsCsv() {
    if (!data) return;
    downloadCsv(
      `gradethread-community-brands-${csvDate()}.csv`,
      [
        "Brand",
        "Sell-through",
        "Avg sale",
        "Realization",
        "Days to sell",
        "Sellers",
      ],
      data.topBrands.map((b) => [
        b.brand,
        b.sellThrough ?? "",
        b.avgSalePrice ?? "",
        b.medianRealization ?? "",
        b.medianDaysToSell ?? "",
        b.sellers,
      ]),
    );
  }

  function exportCategoriesCsv() {
    if (!data) return;
    downloadCsv(
      `gradethread-community-categories-${csvDate()}.csv`,
      [
        "Category",
        "Sell-through",
        "Avg sale",
        "Realization",
        "Days to sell",
        "Sellers",
      ],
      data.categories.map((c) => [
        c.category,
        c.sellThrough ?? "",
        c.avgSalePrice ?? "",
        c.medianRealization ?? "",
        c.medianDaysToSell ?? "",
        c.sellers,
      ]),
    );
  }

  const filtersActive = hasActiveFilters(activeFilters);
  function applyFilters() {
    setFilters(draft);
  }
  function clearFilters() {
    setDraft({});
    setFilters({});
  }

  return (
    <div className="space-y-6">
      {/* US-2161: the period Select is kept in both modes — see
          FlipdeskListingPerformancePage for the contract. */}
      {(() => {
        const actions = (
          <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
            <SelectTrigger className="w-[160px]" aria-label="Time period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All time</SelectItem>
              <SelectItem value="12mo">Last 12 months</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        );
        return embedded ? (
          <div className="flex justify-end">{actions}</div>
        ) : (
          <PageHeader
            icon={Users}
            title="Community Insights"
            subtitle="What is selling, gathered from every GradeThread seller. No names, no individual accounts."
            actions={actions}
          />
        );
      })()}

      {/* US-2235 AC1: the filters. Submitted rather than live — see the state
          split above. Every one of them narrows the cohort SERVER-side; there is
          deliberately no client-side row filtering here, because hiding rows
          would leave the medians computed over everyone. */}
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1.5">
            <Label htmlFor="ci-brand" className="text-xs">Brand</Label>
            <Input
              id="ci-brand"
              placeholder="Any brand"
              value={draft.brand ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, brand: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ci-category" className="text-xs">Category</Label>
            <Input
              id="ci-category"
              placeholder="Any category"
              value={draft.category ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ci-size" className="text-xs">Size</Label>
            <Input
              id="ci-size"
              placeholder="Any size"
              value={draft.size ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, size: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ci-price-min" className="text-xs">List price</Label>
            <div className="flex items-center gap-2">
              <Input
                id="ci-price-min"
                type="number"
                inputMode="decimal"
                min={0}
                placeholder="Min"
                value={draft.priceMin ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    priceMin: e.target.value === "" ? null : Number(e.target.value),
                  }))}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                aria-label="Maximum list price"
                type="number"
                inputMode="decimal"
                min={0}
                placeholder="Max"
                value={draft.priceMax ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    priceMax: e.target.value === "" ? null : Number(e.target.value),
                  }))}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <Button onClick={applyFilters} className="flex-1">Apply</Button>
            {filtersActive ? (
              <Button variant="ghost" onClick={clearFilters}>Clear</Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* US-2235 AC2: how many sellers are behind these numbers. The page showed
          medians and percentiles with no sense of scale, so a figure from six
          sellers read exactly like one from six hundred. */}
      {(() => {
        const cov = data?.meta.coverage;
        const minSellers = data?.meta.minSellers ?? MIN_COHORT_SELLERS;
        if (!cov) return null;
        if (cov.belowFloor) {
          return (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              <Users className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Fewer than {minSellers} sellers match this view, so the community
                figures below are hidden. Widen the filters to see them.
                {cov.totalSellers ? ` ${cov.totalSellers.toLocaleString()} sellers feed the full community view.` : ""}
              </p>
            </div>
          );
        }
        return (
          <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Users className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {filtersActive && cov.cohortSellers != null && cov.totalSellers != null
                ? `${cov.cohortSellers.toLocaleString()} of ${cov.totalSellers.toLocaleString()} sellers match this view.`
                : `${(cov.cohortSellers ?? cov.totalSellers ?? 0).toLocaleString()} sellers feed these numbers.`}
            </p>
          </div>
        );
      })()}

      {(() => {
        const minSellers = data?.meta.minSellers ?? MIN_COHORT_SELLERS;
        return (
          <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Every number here is aggregated across at least {minSellers} sellers — no
              individual seller&apos;s data is ever shown. Cohorts with fewer than{" "}
              {minSellers} sellers are hidden to protect privacy. Your own numbers are
              always shown.
            </p>
          </div>
        );
      })()}

      {isError ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            Couldn&apos;t load community insights
            {error instanceof Error ? `: ${error.message}` : "."}
          </CardContent>
        </Card>
      ) : isLoading || !data ? (
        <TableLoadingSkeleton rows={6} />
      ) : (
        <>
          {/* Recommendations (US-1064): actionable sourcing/pricing suggestions
              derived from the benchmarks below, each with confidence + cohort. */}
          {(() => {
            const all = deriveRecommendations(data).filter(
              (r) => !dismissedRecs.has(r.id),
            );
            if (all.length === 0) return null;
            const shown = showAllRecs ? all : all.slice(0, RECS_PREVIEW_COUNT);
            const hiddenCount = all.length - shown.length;
            return (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Lightbulb className="h-4 w-4" /> Recommendations for you
                  </CardTitle>
                  <CardDescription>
                    What to source and how to price, ranked by signal strength.
                    Each shows its confidence and the cohort size behind it.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {shown.map((rec) => (
                      <RecommendationRow key={rec.id} rec={rec} onDismiss={dismissRec} />
                    ))}
                  </ul>
                  {(hiddenCount > 0 || showAllRecs) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2"
                      onClick={() => setShowAllRecs((v) => !v)}
                    >
                      {showAllRecs
                        ? "Show fewer"
                        : `See all ${all.length} recommendations`}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })()}

          {/* You vs similar sellers */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4" /> Your sell-through vs similar sellers
              </CardTitle>
              <CardDescription>
                How your listed-to-sold rate compares to other resellers in the same window.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                const you = data.you;
                const cmp = you.peerComparison;
                return (
                  <div className="grid gap-6 sm:grid-cols-3">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Your sell-through
                      </p>
                      <p className="text-3xl font-bold">{pct(you.sellThrough)}</p>
                      <p className="text-xs text-muted-foreground">
                        {you.sold} sold / {you.listed} listed
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Community median
                      </p>
                      {cmp ? (
                        <>
                          <p className="text-3xl font-bold">
                            {pct(cmp.peerMedianSellThrough)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            across {cmp.peerCount} sellers
                          </p>
                        </>
                      ) : (
                        // US-2235 AC3: too few peers LIKE YOU for a k-anon cohort
                        // median — fall back to the community-wide activity signal
                        // that IS available, instead of a dead "not enough data".
                        (() => {
                          const w =
                            data.trends.windows.d365 ??
                            data.trends.windows.d90 ??
                            data.trends.windows.d30;
                          return w ? (
                            <>
                              <p className="text-lg font-semibold">Community-wide</p>
                              <p className="text-xs text-muted-foreground">
                                {w.sellers} sellers · {w.sold} sold this window
                              </p>
                            </>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              not enough community data yet
                            </p>
                          );
                        })()
                      )}
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Your percentile
                      </p>
                      {cmp && cmp.percentile != null ? (
                        <>
                          <p className="text-3xl font-bold">
                            {Math.round(cmp.percentile * 100)}
                            <span className="text-base font-medium text-muted-foreground">
                              {ordinalSuffix(Math.round(cmp.percentile * 100))}
                            </span>
                          </p>
                          <div className="mt-2 space-y-1">
                            <Progress value={cmp.percentile * 100} className="h-2" />
                            <p className="text-xs text-muted-foreground">
                              {cmp.percentile >= 0.5 ? (
                                <span className="inline-flex items-center gap-1 text-emerald-600">
                                  <ArrowUpRight className="h-3 w-3" /> ahead of{" "}
                                  {Math.round(cmp.percentile * 100)}% of peers
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-amber-600">
                                  <ArrowDownRight className="h-3 w-3" /> room to grow
                                </span>
                              )}
                            </p>
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          List a few more items to unlock your ranking.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          {/* Price realization + time-to-sell (community vs you) */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Percent className="h-4 w-4" /> Price realization
                </CardTitle>
                <CardDescription>
                  How much of the list price sellers actually capture at sale.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.priceRealization == null ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Not enough community sales with list prices yet.
                  </p>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Community median (sale ÷ list)
                      </p>
                      <p className="text-3xl font-bold">
                        {pct(data.priceRealization.medianRatio)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        middle 50% {pct(data.priceRealization.p25Ratio)}–
                        {pct(data.priceRealization.p75Ratio)} · across{" "}
                        {data.priceRealization.sellers} sellers
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-4 border-t pt-3">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">
                          Median list
                        </p>
                        <p className="text-lg font-semibold">
                          {usd(data.priceRealization.medianListPrice)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">
                          Median sale
                        </p>
                        <p className="text-lg font-semibold">
                          {usd(data.priceRealization.medianSalePrice)}
                        </p>
                      </div>
                    </div>
                    {data.you.medianRealization != null && (
                      <p className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                        You capture a median of{" "}
                        <span className="font-semibold text-foreground">
                          {pct(data.you.medianRealization)}
                        </span>{" "}
                        of your list prices.
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="h-4 w-4" /> Time to sell
                </CardTitle>
                <CardDescription>
                  How long items sit listed before they sell, across the community.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.timeToSell == null ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Not enough community sales with listing dates yet.
                  </p>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Median time to sell
                      </p>
                      <p className="text-3xl font-bold">{days(data.timeToSell.p50)}</p>
                      <p className="text-xs text-muted-foreground">
                        across {data.timeToSell.sellers} sellers
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-3 border-t pt-3 text-center">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">
                          Fast (p25)
                        </p>
                        <p className="text-lg font-semibold">{days(data.timeToSell.p25)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">
                          Slow (p75)
                        </p>
                        <p className="text-lg font-semibold">{days(data.timeToSell.p75)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">
                          Long tail (p90)
                        </p>
                        <p className="text-lg font-semibold">{days(data.timeToSell.p90)}</p>
                      </div>
                    </div>
                    {data.you.medianDaysToSell != null && (
                      <p className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                        Your median time to sell is{" "}
                        <span className="font-semibold text-foreground">
                          {days(data.you.medianDaysToSell)}
                        </span>
                        .
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Sales trend (community-wide) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="h-4 w-4" /> Community sales trend
              </CardTitle>
              <CardDescription>
                Items sold across the community over the last 12 months, with
                rolling 30 / 90 / 365-day totals.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-3 gap-4">
                {(
                  [
                    ["Last 30 days", data.trends.windows.d30],
                    ["Last 90 days", data.trends.windows.d90],
                    ["Last 365 days", data.trends.windows.d365],
                  ] as const
                ).map(([label, w]) => (
                  <div key={label}>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      {label}
                    </p>
                    <p className="text-2xl font-bold">
                      {w ? w.sold.toLocaleString() : "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {w ? `${usd(w.gmv)} GMV · ${w.sellers} sellers` : "not enough data"}
                    </p>
                  </div>
                ))}
              </div>
              {(() => {
                const series = data.trends.monthly;
                const max = Math.max(1, ...series.map((m) => m.sold ?? 0));
                if (series.every((m) => m.sold == null)) {
                  return (
                    <p className="py-2 text-center text-sm text-muted-foreground">
                      Not enough monthly community sales to chart a trend yet.
                    </p>
                  );
                }
                return (
                  <div className="flex items-end gap-1.5" style={{ height: 120 }}>
                    {series.map((m) => {
                      const h = m.sold == null ? 0 : Math.round((m.sold / max) * 100);
                      return (
                        <div
                          key={m.month}
                          className="flex flex-1 flex-col items-center gap-1"
                          title={
                            m.sold == null
                              ? `${monthLabel(m.month)}: hidden (below privacy threshold)`
                              : `${monthLabel(m.month)}: ${m.sold} sold · ${usd(m.gmv)} GMV`
                          }
                        >
                          <div className="flex h-[100px] w-full items-end">
                            <div
                              className="w-full rounded-t bg-brand-navy/80"
                              style={{ height: `${h}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            {monthLabel(m.month)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          {/* Top brands by sell-through */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Award className="h-4 w-4" /> Top brands by sell-through
                  </CardTitle>
                  <CardDescription>
                    Brands moving fastest across the community — your sourcing
                    shortlist.
                  </CardDescription>
                </div>
                {data.topBrands.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportBrandsCsv}
                    aria-label="Export the community top brands table as CSV"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export CSV
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {data.topBrands.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Not enough community data yet for this window.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Brand</TableHead>
                      <TableHead className="text-right">Sell-through</TableHead>
                      <TableHead className="text-right">Avg sale</TableHead>
                      <TableHead className="text-right">Realization</TableHead>
                      <TableHead className="text-right">Days to sell</TableHead>
                      <TableHead className="text-right">Sellers</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.topBrands.map((b) => (
                      <TableRow key={b.brand}>
                        <TableCell className="font-medium">{b.brand}</TableCell>
                        <TableCell className="text-right">
                          <span className="font-semibold">{pct(b.sellThrough)}</span>
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({b.sold}/{b.listed})
                          </span>
                        </TableCell>
                        <TableCell className="text-right">{usd(b.avgSalePrice)}</TableCell>
                        <TableCell className="text-right">{pct(b.medianRealization)}</TableCell>
                        <TableCell className="text-right">{days(b.medianDaysToSell)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {b.sellers}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Top categories by sell-through (deep-dive) */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Tags className="h-4 w-4" /> Top categories by sell-through
                  </CardTitle>
                  <CardDescription>
                    Which garment categories move fastest and at what
                    realization.
                  </CardDescription>
                </div>
                {data.categories.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportCategoriesCsv}
                    aria-label="Export the community top categories table as CSV"
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Export CSV
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {data.categories.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Not enough community data yet for this window.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Sell-through</TableHead>
                      <TableHead className="text-right">Avg sale</TableHead>
                      <TableHead className="text-right">Realization</TableHead>
                      <TableHead className="text-right">Days to sell</TableHead>
                      <TableHead className="text-right">Sellers</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.categories.map((c) => (
                      <TableRow key={c.category}>
                        <TableCell className="font-medium capitalize">
                          {c.category}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="font-semibold">{pct(c.sellThrough)}</span>
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({c.sold}/{c.listed})
                          </span>
                        </TableCell>
                        <TableCell className="text-right">{usd(c.avgSalePrice)}</TableCell>
                        <TableCell className="text-right">{pct(c.medianRealization)}</TableCell>
                        <TableCell className="text-right">{days(c.medianDaysToSell)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {c.sellers}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Trending categories */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4" /> Trending categories
              </CardTitle>
              <CardDescription>
                Sales momentum over the last 30 days vs the prior 30 days.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.trendingCategories.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Not enough recent community sales to spot trends yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Sold (30d)</TableHead>
                      <TableHead className="text-right">Prior 30d</TableHead>
                      <TableHead className="text-right">Trend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.trendingCategories.map((c) => (
                      <TableRow key={c.category}>
                        <TableCell className="font-medium capitalize">{c.category}</TableCell>
                        <TableCell className="text-right">{c.soldRecent}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {c.soldPrevious}
                        </TableCell>
                        <TableCell className="text-right">
                          {c.growth == null ? (
                            <Badge variant="secondary">new</Badge>
                          ) : c.growth >= 0 ? (
                            <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                              <ArrowUpRight className="mr-0.5 h-3 w-3" />
                              {Math.round(c.growth * 100)}%
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-amber-700">
                              <ArrowDownRight className="mr-0.5 h-3 w-3" />
                              {Math.round(c.growth * 100)}%
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ordinalSuffix(n: number): string {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

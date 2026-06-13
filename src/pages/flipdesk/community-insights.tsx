import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, TrendingUp, Award, Lock, ArrowUpRight, ArrowDownRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  MIN_COHORT_SELLERS,
} from "@/lib/community-benchmarks";

const pct = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `${Math.round(n * 100)}%`;
const usd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;

type Preset = "all" | "90d" | "12mo";

function presetStart(p: Preset): string | null {
  if (p === "all") return null;
  const days = p === "90d" ? 90 : 365;
  const from = new Date();
  from.setDate(from.getDate() - days);
  return from.toISOString().slice(0, 10);
}

export function FlipdeskCommunityInsightsPage() {
  const [preset, setPreset] = useState<Preset>("12mo");
  const periodStart = useMemo(() => presetStart(preset), [preset]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["community-benchmarks", periodStart],
    queryFn: () => fetchCommunityBenchmarks(periodStart),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Community Insights</h1>
            <p className="text-sm text-muted-foreground">
              Anonymized market signal from across the GradeThread reseller community.
            </p>
          </div>
        </div>
        <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="12mo">Last 12 months</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
        <Lock className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Every number here is aggregated across at least {MIN_COHORT_SELLERS} sellers — no
          individual seller&apos;s data is ever shown. Cohorts with fewer than{" "}
          {MIN_COHORT_SELLERS} sellers are hidden to protect privacy.
        </p>
      </div>

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
                      <p className="text-3xl font-bold">
                        {pct(cmp?.peerMedianSellThrough)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {cmp ? `across ${cmp.peerCount} sellers` : "not enough peers yet"}
                      </p>
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

          {/* Top brands by sell-through */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Award className="h-4 w-4" /> Top brands by sell-through
              </CardTitle>
              <CardDescription>
                Brands moving fastest across the community — your sourcing shortlist.
              </CardDescription>
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

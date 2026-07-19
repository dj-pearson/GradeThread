import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Scale,
  ArrowRight,
  Info,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
} from "lucide-react";

// ── API payload types (mirror the ai_profitability RPC, migration 00240) ──

type PeriodKey = "today" | "7d" | "30d" | "90d";

interface FeatureRow {
  feature: string;
  label: string;
  currentModel: string | null;
  recommendedModel: string | null;
  qualityNote: string | null;
  actionUnit: "submission" | "call";
  revenueBasis: "per_action" | "subscription" | "none";
  costUsd: number;
  calls: number;
  actions: number;
  inputTokens: number;
  outputTokens: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  costPerCallUsd: number | null;
  costPerActionUsd: number | null;
  revenuePerActionUsd: number | null;
  subscriptionRefUsd: number | null;
  grossMarginPerActionUsd: number | null;
  grossMarginPct: number | null;
  costRevenueRatio: number | null;
  monthlyProjectedCostUsd: number;
  breakEvenActionsPerMonth: number | null;
  flag: "healthy" | "watch" | "at_risk" | "subscription" | "tracked" | "no_data";
}

interface ScenarioFeatureLine {
  feature: string;
  label: string;
  monthlyActions: number;
  costPerActionUsd: number;
  costSource: "observed" | "modeled";
  monthlySpendUsd: number;
}

interface ScenarioRow {
  key: string;
  label: string;
  description: string;
  monthlyRevenueUsd: number;
  monthlySpendUsd: number;
  monthlyMarginUsd: number;
  monthlyMarginPct: number | null;
  perFeature: ScenarioFeatureLine[];
}

interface ProfitabilityReport {
  period: PeriodKey;
  windowStart: string;
  generatedAt: string;
  pricedFrom: string;
  projectionBasis: string;
  features: FeatureRow[];
  totals: { costUsd: number; calls: number; monthlyProjectedCostUsd: number };
  scenarios: ScenarioRow[];
}

interface ProfitabilityResponse {
  report: ProfitabilityReport;
}

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
];

const usd = (dollars: number | null | undefined) =>
  (dollars ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(dollars ?? 0) < 1 ? 4 : 2,
  });

const num = (n: number | null | undefined) => (n ?? 0).toLocaleString();

const shortModel = (m: string | null) =>
  (m ?? "—")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");

const FLAG_META: Record<
  FeatureRow["flag"],
  { label: string; className: string }
> = {
  healthy: {
    label: "Healthy",
    className:
      "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300",
  },
  watch: {
    label: "Watch",
    className:
      "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  },
  at_risk: {
    label: "At risk",
    className:
      "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
  },
  subscription: {
    label: "Subscription",
    className:
      "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  },
  tracked: {
    label: "Tracked",
    className: "border-border bg-muted/50 text-muted-foreground",
  },
  no_data: {
    label: "No data",
    className: "border-border bg-muted/40 text-muted-foreground",
  },
};

export function AdminAiProfitabilityPage() {
  const [period, setPeriod] = useState<PeriodKey>("30d");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-ai-profitability", period],
    queryFn: async (): Promise<ProfitabilityReport> => {
      const res = await edgeFetch(`/api/admin/ai/profitability?period=${period}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as ProfitabilityResponse;
      return body.report;
    },
    staleTime: 60 * 1000,
  });

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? period;
  const atRisk = (data?.features ?? []).filter((f) => f.flag === "at_risk");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Scale className="h-6 w-6 text-brand-red-text" />
          <div>
            <h1 className="text-2xl font-bold">AI Profitability</h1>
            <p className="text-sm text-muted-foreground">
              Cost-per-action, gross margin and model-routing per AI feature —
              with modeled monthly spend vs revenue.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {PERIODS.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={period === p.key ? "default" : "outline"}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      {isError && (
        <Card className="border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40">
          <CardContent className="pt-4 text-sm text-red-700 dark:text-red-300">
            Failed to load AI profitability. Try again shortly.
          </CardContent>
        </Card>
      )}

      {/* At-risk callout — any per-action feature whose AI cost nears revenue */}
      {atRisk.length > 0 && (
        <Card className="border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40">
          <CardHeader className="flex flex-row items-center gap-2 pb-2">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
            <CardTitle className="text-sm font-medium text-red-700 dark:text-red-300">
              {atRisk.length} feature{atRisk.length > 1 ? "s" : ""} where AI cost
              is approaching revenue
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-red-700 dark:text-red-300">
            {atRisk
              .map(
                (f) =>
                  `${f.label} (${usd(f.costPerActionUsd)}/action vs ${usd(
                    f.revenuePerActionUsd,
                  )})`,
              )
              .join(" · ")}
          </CardContent>
        </Card>
      )}

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Spend ({periodLabel})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <p className="text-2xl font-bold tabular-nums">
                {usd(data?.totals.costUsd ?? 0)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Projected monthly AI spend
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <>
                <p className="text-2xl font-bold tabular-nums">
                  {usd(data?.totals.monthlyProjectedCostUsd ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Run-rate from {periodLabel.toLowerCase()}
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">AI calls</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <p className="text-2xl font-bold tabular-nums">
                {num(data?.totals.calls ?? 0)}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-feature profitability table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">
            Per-feature economics
          </CardTitle>
          <CardDescription>
            Cost-per-action and gross margin over {periodLabel.toLowerCase()},
            with the current → recommended model tier.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (data?.features.length ?? 0) === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No AI features configured.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feature</TableHead>
                  <TableHead>Model (cur → rec)</TableHead>
                  <TableHead className="text-right">Cost / action</TableHead>
                  <TableHead className="text-right">Revenue / action</TableHead>
                  <TableHead className="text-right">Gross margin</TableHead>
                  <TableHead className="text-right">Proj. monthly</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.features.map((f) => {
                  const flag = FLAG_META[f.flag];
                  const modelChanged =
                    f.recommendedModel &&
                    f.currentModel &&
                    f.recommendedModel !== f.currentModel;
                  return (
                    <TableRow key={f.feature}>
                      <TableCell>
                        <div className="font-medium">{f.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {num(f.actions)} {f.actionUnit}
                          {f.actions === 1 ? "" : "s"}
                          {f.breakEvenActionsPerMonth != null && (
                            <>
                              {" · break-even "}
                              {num(f.breakEvenActionsPerMonth)}/mo
                            </>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-xs">
                          <span>{shortModel(f.currentModel)}</span>
                          {modelChanged && (
                            <>
                              <ArrowRight className="h-3 w-3 text-muted-foreground" />
                              <span className="font-medium text-brand-red-text">
                                {shortModel(f.recommendedModel)}
                              </span>
                            </>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.costPerActionUsd != null ? usd(f.costPerActionUsd) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.revenueBasis === "per_action"
                          ? usd(f.revenuePerActionUsd)
                          : f.revenueBasis === "subscription"
                            ? `${usd(f.subscriptionRefUsd)}/mo plan`
                            : "indirect"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.grossMarginPct != null ? (
                          <span className="inline-flex items-center gap-1">
                            {f.grossMarginPct >= 0 ? (
                              <TrendingUp className="h-3 w-3 text-green-600 dark:text-green-400" />
                            ) : (
                              <TrendingDown className="h-3 w-3 text-red-600 dark:text-red-400" />
                            )}
                            {f.grossMarginPct.toFixed(1)}%
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {usd(f.monthlyProjectedCostUsd)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="outline"
                          className={flag.className}
                        >
                          {flag.label}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Model recommendations / quality notes */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">
            Model-routing recommendations
          </CardTitle>
          <CardDescription>
            Expected quality impact of each per-feature tier.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            (data?.features ?? [])
              .filter((f) => f.qualityNote)
              .map((f) => (
                <div key={f.feature} className="rounded-lg border p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {f.label}
                    <span className="text-xs font-normal text-muted-foreground">
                      {shortModel(f.currentModel)} → {shortModel(f.recommendedModel)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {f.qualityNote}
                  </p>
                </div>
              ))
          )}
        </CardContent>
      </Card>

      {/* Modeled scenarios — monthly spend vs revenue */}
      <div className="grid gap-4 md:grid-cols-2">
        {isLoading
          ? Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-48 w-full" />
            ))
          : (data?.scenarios ?? []).map((s) => {
              const positive = s.monthlyMarginUsd >= 0;
              return (
                <Card key={s.key}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">{s.label}</CardTitle>
                    <CardDescription>{s.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-xs text-muted-foreground">Revenue</p>
                        <p className="text-sm font-bold tabular-nums">
                          {usd(s.monthlyRevenueUsd)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">AI spend</p>
                        <p className="text-sm font-bold tabular-nums">
                          {usd(s.monthlySpendUsd)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Margin</p>
                        <p
                          className={`text-sm font-bold tabular-nums ${
                            positive
                              ? "text-green-600 dark:text-green-400"
                              : "text-red-600 dark:text-red-400"
                          }`}
                        >
                          {s.monthlyMarginPct != null
                            ? `${s.monthlyMarginPct.toFixed(1)}%`
                            : usd(s.monthlyMarginUsd)}
                        </p>
                      </div>
                    </div>
                    <div className="space-y-1">
                      {s.perFeature.map((line) => (
                        <div
                          key={line.feature}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-muted-foreground">
                            {line.label}
                            <span className="ml-1 opacity-60">
                              ({num(line.monthlyActions)} ×{" "}
                              {usd(line.costPerActionUsd)}
                              {line.costSource === "modeled" ? "*" : ""})
                            </span>
                          </span>
                          <span className="tabular-nums">
                            {usd(line.monthlySpendUsd)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* Methodology note */}
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Per-action cost is re-priced at query time from{" "}
          <code>system_settings.ai_model_prices</code>; economics and scenarios
          are config-driven (<code>ai_feature_economics</code>,{" "}
          <code>ai_usage_scenarios</code>) — edit them in the Settings Registry,
          no deploy. Scenario lines marked <code>*</code> use a modeled
          per-action cost because the ledger has no data for that feature yet.
          Full write-up in <code>vault/50-business/ai-profitability.md</code>.
        </p>
      </div>
    </div>
  );
}

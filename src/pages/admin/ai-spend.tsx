import { useMemo, useState } from "react";
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
  Coins,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Cpu,
  Flame,
  Info,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { AiBudgetsCard } from "@/components/admin/ai-budgets-card";

// ── API payload types (mirror the ai_spend RPC, migration 00218) ──

interface SpendRow {
  key: string;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface DailyPoint {
  day: string;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface FeatureToday {
  feature: string;
  costUsd: number;
  calls: number;
}

interface AiSpendSummary {
  period: PeriodKey;
  groupBy: GroupByKey;
  windowStart: string;
  generatedAt: string;
  pricedFrom: string;
  totals: {
    costUsd: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  rows: SpendRow[];
  daily: DailyPoint[];
  topFeaturesToday: FeatureToday[];
  todayCostUsd: number;
  yesterdayCostUsd: number;
}

interface AiSpendResponse {
  summary: AiSpendSummary;
}

type PeriodKey = "today" | "7d" | "30d" | "90d";
type GroupByKey = "feature" | "model" | "day";

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
];

const GROUP_BYS: Array<{ key: GroupByKey; label: string }> = [
  { key: "feature", label: "By feature" },
  { key: "model", label: "By model" },
  { key: "day", label: "By day" },
];

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

// The RPC returns USD as a numeric (dollars, fractional), not cents.
const usd = (dollars: number) =>
  (dollars ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: dollars < 1 ? 4 : 2,
  });

const num = (n: number) => (n ?? 0).toLocaleString();

// Friendlier labels for the known feature slugs.
const FEATURE_LABELS: Record<string, string> = {
  grading: "Grading",
  autolister: "AutoLister / Listings",
  content: "Content",
  reconcile: "Photo reconcile",
  catalog_extract: "Catalog extract",
  tag_ocr: "Tag OCR",
  photo_qa: "Photo QA",
  photo_roles: "Photo roles",
  authenticity: "Authenticity",
  unknown: "Unattributed",
};

const featureLabel = (slug: string) => FEATURE_LABELS[slug] ?? slug;

export function AdminAiSpendPage() {
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [groupBy, setGroupBy] = useState<GroupByKey>("feature");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-ai-spend", period, groupBy],
    queryFn: async (): Promise<AiSpendSummary> => {
      const res = await edgeFetch(
        `/api/admin/ai/spend?period=${period}&groupBy=${groupBy}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as AiSpendResponse;
      return body.summary;
    },
    staleTime: 60 * 1000,
  });

  const deltaPct = useMemo(() => {
    if (!data) return null;
    const { todayCostUsd, yesterdayCostUsd } = data;
    if (yesterdayCostUsd <= 0) {
      return todayCostUsd > 0 ? Infinity : 0;
    }
    return ((todayCostUsd - yesterdayCostUsd) / yesterdayCostUsd) * 100;
  }, [data]);

  const dailyChart = useMemo(
    () =>
      (data?.daily ?? []).map((d) => ({
        day: d.day.slice(5), // MM-DD
        cost: Number(d.costUsd.toFixed(4)),
        calls: d.calls,
      })),
    [data],
  );

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? period;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Coins className="h-6 w-6 text-brand-red-text" />
          <div>
            <h1 className="text-2xl font-bold">AI Spend</h1>
            <p className="text-sm text-muted-foreground">
              Token usage &amp; estimated Claude cost by model, feature and day.
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
            Failed to load AI spend. Try again shortly.
          </CardContent>
        </Card>
      )}

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Spend ({periodLabel})
            </CardTitle>
            <Coins className="h-4 w-4 text-brand-red-text" />
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
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Calls</CardTitle>
            <Activity className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <p className="text-2xl font-bold tabular-nums">
                  {num(data?.totals.calls ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {num(data?.totals.inputTokens ?? 0)} in /{" "}
                  {num(data?.totals.outputTokens ?? 0)} out tokens
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Today</CardTitle>
            <Cpu className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <p className="text-2xl font-bold tabular-nums">
                {usd(data?.todayCostUsd ?? 0)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">vs Yesterday</CardTitle>
            {deltaPct !== null && deltaPct > 0 ? (
              <ArrowUpRight className="h-4 w-4 text-red-600 dark:text-red-400" />
            ) : (
              <ArrowDownRight className="h-4 w-4 text-green-600 dark:text-green-400" />
            )}
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <p
                  className={`text-2xl font-bold tabular-nums ${
                    deltaPct !== null && deltaPct > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-green-600 dark:text-green-400"
                  }`}
                >
                  {deltaPct === null
                    ? "—"
                    : deltaPct === Infinity
                      ? "New spend"
                      : `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(0)}%`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Yesterday {usd(data?.yesterdayCostUsd ?? 0)}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* US-895: budget guardrails — caps, breaches, one-click re-enable */}
      <AiBudgetsCard />

      {/* Top spending features today */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-orange-500" />
            <CardTitle className="text-sm font-medium">
              Top spending features today
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (data?.topFeaturesToday.length ?? 0) === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No AI spend recorded yet today.
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {data!.topFeaturesToday.map((f) => (
                <div
                  key={f.feature}
                  className="rounded-lg border bg-muted/40 px-4 py-3"
                >
                  <p className="text-xs text-muted-foreground">
                    {featureLabel(f.feature)}
                  </p>
                  <p className="text-lg font-bold tabular-nums">
                    {usd(f.costUsd)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {num(f.calls)} calls
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Daily cost chart */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Daily cost</CardTitle>
          <CardDescription>Estimated USD per day over {periodLabel}.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[260px] w-full" />
          ) : (
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyChart} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value: unknown, name: unknown) =>
                      String(name) === "cost"
                        ? [usd(Number(value)), "Cost"]
                        : [num(Number(value)), "Calls"]
                    }
                  />
                  <Bar dataKey="cost" name="cost" fill="#E94560" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Breakdown table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">Breakdown</CardTitle>
            <div className="flex gap-2">
              {GROUP_BYS.map((g) => (
                <Button
                  key={g.key}
                  size="sm"
                  variant={groupBy === g.key ? "default" : "outline"}
                  onClick={() => setGroupBy(g.key)}
                >
                  {g.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (data?.rows.length ?? 0) === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No AI usage recorded in this period.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {groupBy === "model"
                      ? "Model"
                      : groupBy === "day"
                        ? "Day"
                        : "Feature"}
                  </TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Input tok</TableHead>
                  <TableHead className="text-right">Output tok</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">
                      {groupBy === "feature" ? (
                        <Badge variant="secondary">{featureLabel(r.key)}</Badge>
                      ) : (
                        r.key
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(r.costUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(r.calls)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(r.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(r.outputTokens)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* US-1531: extraction correction rates — which fields the AI gets wrong. */}
      <ExtractionAccuracyCard />

      {/* Methodology note */}
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Costs are list-price estimates, re-priced at query time from the
          configurable model price table (<code>system_settings.ai_model_prices</code>)
          — edit it in the Settings Registry to update rates without a deploy.
          Streaming calls are excluded.
        </p>
      </div>
    </div>
  );
}

// ── US-1531: per-field extraction accuracy ──────────────────────────────────

interface ExtractionAccuracyField {
  field: string;
  accepted: number;
  corrected: number;
  correctionRate: number;
}

interface ExtractionAccuracyResponse {
  fields: ExtractionAccuracyField[];
  sample_size: number;
  truncated: boolean;
  days: number;
}

function ExtractionAccuracyCard() {
  const [days, setDays] = useState(30);
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");

  const params = new URLSearchParams({ days: String(days) });
  if (brand.trim()) params.set("brand", brand.trim());
  if (category.trim()) params.set("category", category.trim());

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-extraction-accuracy", days, brand.trim(), category.trim()],
    queryFn: async (): Promise<ExtractionAccuracyResponse> => {
      const res = await edgeFetch(
        `/api/admin/ai/extraction-accuracy?${params.toString()}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string })?.error ?? `HTTP ${res.status}`,
        );
      }
      return (await res.json()) as ExtractionAccuracyResponse;
    },
    staleTime: 60 * 1000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Extraction accuracy</CardTitle>
        <p className="text-sm text-muted-foreground">
          How often users correct each AI-suggested field (worst first) — the
          prompt-fix priority list. Corrections are captured from the review
          flows (US-1531).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {[7, 30, 90].map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? "default" : "outline"}
              onClick={() => setDays(d)}
            >
              {d}d
            </Button>
          ))}
          <input
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="Filter brand…"
            className="h-8 rounded-md border bg-background px-2 text-sm"
          />
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="item_category…"
            className="h-8 rounded-md border bg-background px-2 text-sm"
          />
          {data && (
            <span className="text-xs text-muted-foreground">
              {data.sample_size} extractions{data.truncated ? " (capped)" : ""}
            </span>
          )}
        </div>
        {isError && (
          <p className="text-sm text-destructive">
            Failed to load extraction accuracy.
          </p>
        )}
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {data && data.fields.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No accepted extractions in this window yet.
          </p>
        )}
        {data && data.fields.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead className="text-right">Corrected</TableHead>
                <TableHead className="text-right">Correction rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.fields.map((f) => (
                <TableRow key={f.field}>
                  <TableCell className="font-medium">{f.field}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {f.accepted}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {f.corrected}
                  </TableCell>
                  <TableCell
                    className={
                      "text-right tabular-nums " +
                      (f.correctionRate >= 0.4
                        ? "text-red-600 dark:text-red-400"
                        : f.correctionRate >= 0.2
                          ? "text-amber-600 dark:text-amber-400"
                          : "")
                    }
                  >
                    {(f.correctionRate * 100).toFixed(0)}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

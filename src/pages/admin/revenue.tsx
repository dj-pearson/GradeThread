import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DollarSign,
  TrendingUp,
  Users,
  CreditCard,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  Loader2,
  Sparkles,
  Info,
} from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { PageHeader } from "@/components/ui/page-header";

// ── API payload types (mirror the revenue_dashboard RPC, migration 00215) ──

interface RevenueByPlan {
  plan: string;
  interval: string;
  count: number;
  mrrCents: number;
}

interface RevenueSummary {
  period: { start: string; end: string; granularity: "day" | "week" };
  current: {
    mrrCents: number;
    arrCents: number;
    activePaid: number;
    trialing: number;
    pastDue: number;
    arpuCents: number;
    byPlan: RevenueByPlan[];
  };
  movement: {
    newCount: number;
    newMrrCents: number;
    churnedCount: number;
    churnedMrrCents: number;
    expansionMrrCents: number;
    contractionMrrCents: number;
  };
  trial: { startedInPeriod: number; convertedFromCohort: number };
  credits: { packRevenueCents: number; packCount: number };
  timeSeries: Array<{
    start: string;
    newCount: number;
    churnedCount: number;
    packRevenueCents: number;
    packCount: number;
  }>;
}

interface RevenueResponse {
  window: { period: string; start: string; end: string; granularity: "day" | "week" };
  summary: RevenueSummary;
  stripeSourceOfTruth: boolean;
}

type PeriodKey = "mtd" | "qtd" | "ytd" | "custom";

const PERIOD_LABELS: Array<{ key: PeriodKey; label: string }> = [
  { key: "mtd", label: "Month to date" },
  { key: "qtd", label: "Quarter to date" },
  { key: "ytd", label: "Year to date" },
  { key: "custom", label: "Custom" },
];

const PLAN_COLORS: Record<string, string> = {
  starter: "#0F3460",
  pro: "#E94560",
  business: "#16a34a",
  free: "#94a3b8",
};

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

// ── Formatting helpers (server sends cents; the client only formats) ──

const usd = (cents: number) =>
  (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

const usd2 = (cents: number) =>
  (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const DAY_LABEL = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── KPI card ──

function KpiCard({
  title,
  value,
  icon: Icon,
  description,
  valueClass,
}: {
  title: string;
  value: string;
  icon: React.ElementType;
  description?: string;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${valueClass ?? ""}`}>{value}</div>
        {description && <CardDescription>{description}</CardDescription>}
      </CardContent>
    </Card>
  );
}

export function AdminRevenuePage() {
  const [period, setPeriod] = useState<PeriodKey>("mtd");
  // Default custom range: last 30 days (UTC, date-only inputs).
  const today = new Date();
  const isoDate = (d: Date) => d.toISOString().slice(0, 10);
  const [customStart, setCustomStart] = useState(
    isoDate(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)),
  );
  const [customEnd, setCustomEnd] = useState(isoDate(today));

  const queryParams = useMemo(() => {
    const p = new URLSearchParams({ period });
    if (period === "custom") {
      p.set("start", `${customStart}T00:00:00.000Z`);
      p.set("end", `${customEnd}T23:59:59.999Z`);
    }
    return p.toString();
  }, [period, customStart, customEnd]);

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["admin-revenue", queryParams],
    queryFn: async (): Promise<RevenueResponse> => {
      const res = await edgeFetch(`/api/admin/revenue/summary?${queryParams}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to load revenue summary");
      }
      return json as RevenueResponse;
    },
    staleTime: 60 * 1000,
  });

  const s = data?.summary;

  const netNewMrrCents = s
    ? s.movement.newMrrCents +
      s.movement.expansionMrrCents -
      s.movement.churnedMrrCents -
      s.movement.contractionMrrCents
    : 0;

  const trialRate =
    s && s.trial.startedInPeriod > 0
      ? Math.round((s.trial.convertedFromCohort / s.trial.startedInPeriod) * 1000) / 10
      : 0;

  // Plan mix (sum across intervals) for the pie.
  const planMix = useMemo(() => {
    if (!s) return [];
    const agg: Record<string, number> = {};
    for (const row of s.current.byPlan) {
      agg[row.plan] = (agg[row.plan] ?? 0) + row.count;
    }
    return Object.entries(agg).map(([plan, count]) => ({
      name: titleCase(plan),
      value: count,
      color: PLAN_COLORS[plan] ?? "#94a3b8",
    }));
  }, [s]);

  // MRR per plan (sum across intervals), in dollars, for the bar chart.
  const mrrByPlan = useMemo(() => {
    if (!s) return [];
    const agg: Record<string, number> = {};
    for (const row of s.current.byPlan) {
      agg[row.plan] = (agg[row.plan] ?? 0) + row.mrrCents;
    }
    return Object.entries(agg).map(([plan, cents]) => ({
      plan: titleCase(plan),
      mrr: Math.round(cents / 100),
      color: PLAN_COLORS[plan] ?? "#94a3b8",
    }));
  }, [s]);

  const series = useMemo(
    () =>
      (s?.timeSeries ?? []).map((p) => ({
        label: DAY_LABEL(p.start),
        newCount: p.newCount,
        churnedCount: p.churnedCount,
        packRevenue: Math.round(p.packRevenueCents / 100),
      })),
    [s],
  );

  return (
    <div className="space-y-6">
      {/* Header + period selector */}
      <PageHeader
        title="Revenue &amp; MRR"
        subtitle="Recurring revenue, plan mix, MRR movement, and credit-pack sales."
        icon={DollarSign}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {PERIOD_LABELS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={period === p.key ? "default" : "outline"}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </Button>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              {isFetching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        }
      />

      {period === "custom" && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-4 pt-6">
            <div className="space-y-1.5">
              <Label htmlFor="rev-start">Start</Label>
              <Input
                id="rev-start"
                type="date"
                value={customStart}
                max={customEnd}
                onChange={(e) => setCustomStart(e.target.value)}
                className="w-auto"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rev-end">End</Label>
              <Input
                id="rev-end"
                type="date"
                value={customEnd}
                min={customStart}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="w-auto"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Reconciliation note (AC4) */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <p>
          Figures are aggregated from our subscription records and audit events and
          are <strong>directional operating metrics</strong>. <strong>Stripe remains
          the source of truth</strong> for cash collected: MRR movement uses each
          plan&apos;s monthly list price (the billing interval isn&apos;t recorded per
          event), and credit-pack revenue is gross of refunds. Reconcile actuals
          against Stripe.
        </p>
      </div>

      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-red-600 dark:text-red-400">
            {error instanceof Error ? error.message : "Failed to load revenue summary"}
          </CardContent>
        </Card>
      )}

      {/* KPI cards */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : s ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            title="MRR"
            value={usd(s.current.mrrCents)}
            icon={DollarSign}
            description="Monthly recurring revenue"
            valueClass="text-green-600 dark:text-green-400"
          />
          <KpiCard
            title="ARR"
            value={usd(s.current.arrCents)}
            icon={TrendingUp}
            description="Annual run rate (MRR × 12)"
          />
          <KpiCard
            title="Active Subscribers"
            value={s.current.activePaid.toLocaleString()}
            icon={Users}
            description={
              s.current.trialing > 0
                ? `Paying · ${s.current.trialing} trialing`
                : "Paying (active / past-due)"
            }
          />
          <KpiCard
            title="ARPU"
            value={usd2(s.current.arpuCents)}
            icon={CreditCard}
            description="Avg revenue per paid user"
          />
          <KpiCard
            title="Net New MRR"
            value={`${netNewMrrCents >= 0 ? "+" : "-"}${usd(Math.abs(netNewMrrCents))}`}
            icon={netNewMrrCents >= 0 ? ArrowUpRight : ArrowDownRight}
            description={`${s.movement.newCount} new · ${s.movement.churnedCount} churned`}
            valueClass={
              netNewMrrCents >= 0
                ? "text-green-600 dark:text-green-400"
                : "text-red-600 dark:text-red-400"
            }
          />
          <KpiCard
            title="Churned MRR"
            value={`-${usd(s.movement.churnedMrrCents)}`}
            icon={ArrowDownRight}
            description={`${s.movement.churnedCount} cancellations`}
            valueClass={s.movement.churnedMrrCents > 0 ? "text-red-600 dark:text-red-400" : ""}
          />
          <KpiCard
            title="Trial Conversion"
            value={`${trialRate}%`}
            icon={Sparkles}
            description={`${s.trial.convertedFromCohort}/${s.trial.startedInPeriod} cohort → paid`}
          />
          <KpiCard
            title="Credit-Pack Revenue"
            value={usd(s.credits.packRevenueCents)}
            icon={CreditCard}
            description={`${s.credits.packCount} packs · one-time`}
          />
        </div>
      ) : null}

      {/* Plan distribution + MRR by plan */}
      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-40" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-[250px] w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : s ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Plan Distribution</CardTitle>
              <CardDescription>Active subscribers by FlipDesk plan</CardDescription>
            </CardHeader>
            <CardContent>
              {planMix.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  No active paid subscriptions yet.
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie
                      data={planMix}
                      cx="50%"
                      cy="50%"
                      outerRadius={90}
                      dataKey="value"
                      label={(p: { name?: string | number; percent?: number }) => {
                        const pct = p.percent ?? 0;
                        if (pct < 0.05) return null;
                        return `${String(p.name ?? "")} ${(pct * 100).toFixed(0)}%`;
                      }}
                      labelLine={false}
                    >
                      {planMix.map((entry, idx) => (
                        <Cell key={idx} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(value) => [Number(value), "Subscribers"]}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">MRR by Plan</CardTitle>
              <CardDescription>Monthly recurring revenue per tier</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={mrrByPlan} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="plan" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${Number(v)}`}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value) => [`$${Number(value).toLocaleString()}`, "MRR"]}
                  />
                  <Bar dataKey="mrr" radius={[4, 4, 0, 0]}>
                    {mrrByPlan.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Time series: new vs churned subscriptions + credit-pack revenue */}
      {isLoading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[250px] w-full" />
          </CardContent>
        </Card>
      ) : s ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">New vs Churned Subscriptions</CardTitle>
              <CardDescription>
                Per {s.period.granularity} over the selected period
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={series} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="label"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value, name) => [
                      Number(value),
                      name === "newCount" ? "New" : "Churned",
                    ]}
                  />
                  <Legend />
                  <Bar dataKey="newCount" fill="#16a34a" name="New" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="churnedCount" fill="#E94560" name="Churned" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Credit-Pack Revenue</CardTitle>
              <CardDescription>
                One-time pack sales per {s.period.granularity}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={series} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="label"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${Number(v)}`}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value) => [`$${Number(value).toLocaleString()}`, "Pack revenue"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="packRevenue"
                    stroke="#0F3460"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: "#0F3460" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

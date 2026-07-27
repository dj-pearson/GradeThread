import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { CHART_PALETTE } from "@/lib/constants";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  Filter,
  Users,
  Percent,
  Timer,
  DollarSign,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Trophy,
  Info,
} from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// ── API payload types (mirror the drip_analytics RPC, migration 00253) ──

interface FunnelStep {
  step: number;
  phase: "in_trial" | "win_back";
  sent: number;
  opened: number;
  clicked: number;
  converted: number;
  unsub: number;
  dropOff: number;
  mrrCents: number;
}

interface DripAnalytics {
  campaign: string;
  window: { start: string; end: string };
  overall: {
    enrolled: number;
    converted: number;
    conversionRate: number;
    medianDaysToConvert: number | null;
    attributedMrrCents: number;
    reconciledCount: number;
    reconciliationRate: number | null;
    reconciliationTolerancePct: number;
  };
  funnel: FunnelStep[];
  phaseSplit: {
    inTrial: { converted: number; mrrCents: number };
    winBack: { converted: number; mrrCents: number };
  };
  incentiveSplit: {
    on: { enrolled: number; converted: number; conversionRate: number };
    off: { enrolled: number; converted: number; conversionRate: number };
    liftPts: number;
  };
  cohorts: Array<{
    week: string;
    enrolled: number;
    converted: number;
    conversionRate: number;
  }>;
  variants: Array<{
    variant: string;
    enrolled: number;
    converted: number;
    conversionRate: number;
  }>;
  flags: Array<{
    step: number;
    phase: "in_trial" | "win_back";
    reason: "high_unsub" | "high_dropoff";
    dropOffRate: number;
    unsubRate: number;
  }>;
}

interface DripResponse {
  period: string;
  campaign: string;
  window: { start: string; end: string };
  analytics: DripAnalytics;
  stripeSourceOfTruth: boolean;
}

type PeriodKey = "30d" | "90d" | "180d" | "365d";

const PERIOD_LABELS: Array<{ key: PeriodKey; label: string }> = [
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "180d", label: "180 days" },
  { key: "365d", label: "365 days" },
];

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

// ── Formatting helpers (server sends cents + ratios; the client only formats) ──

const usd = (cents: number) =>
  (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

const pct = (ratio: number | null | undefined) =>
  ratio == null ? "—" : `${(ratio * 100).toFixed(1)}%`;

const WEEK_LABEL = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

const phaseLabel = (phase: string) =>
  phase === "win_back" ? "Win-back" : "In-trial";

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

export function AdminDripAnalyticsPage() {
  const [period, setPeriod] = useState<PeriodKey>("90d");

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["admin-drip-analytics", period],
    queryFn: async (): Promise<DripResponse> => {
      const res = await edgeFetch(
        `/api/admin/drip/analytics?campaign=trial_conversion&period=${period}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to load drip analytics");
      }
      return json as DripResponse;
    },
    staleTime: 60 * 1000,
  });

  const a = data?.analytics;

  // Funnel bars: sent → opened → clicked → converted per step.
  const funnelSeries = useMemo(
    () =>
      (a?.funnel ?? []).map((f) => ({
        label: `#${f.step}`,
        phase: f.phase,
        sent: f.sent,
        opened: f.opened,
        clicked: f.clicked,
        converted: f.converted,
      })),
    [a],
  );

  const cohortSeries = useMemo(
    () =>
      (a?.cohorts ?? []).map((c) => ({
        label: WEEK_LABEL(c.week),
        enrolled: c.enrolled,
        converted: c.converted,
        rate: Math.round(c.conversionRate * 1000) / 10,
      })),
    [a],
  );

  const winningVariant = useMemo(() => {
    if (!a || a.variants.length === 0) return null;
    // Server already orders by conversionRate desc; require a meaningful cohort.
    const top = a.variants.find((v) => v.enrolled > 0);
    return top ?? null;
  }, [a]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trial Conversion"
        subtitle="Drip funnel, time-to-convert, attributed MRR, and signup-week cohorts."
        icon={Filter}
        actions={
          <>
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
          </>
        }
      />

      {/* Reconciliation note (AC5) */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <p>
          Conversions and attributed MRR are aggregated from the drip attribution
          ledger. <strong>Stripe remains the source of truth</strong> for realized
          conversions — the ledger reconciles against Stripe within{" "}
          <strong>
            ±{a?.overall.reconciliationTolerancePct ?? 2}%
          </strong>
          {a && a.overall.reconciliationRate != null && (
            <>
              {" "}
              ({pct(a.overall.reconciliationRate)} of conversions confirmed
              against Stripe)
            </>
          )}
          . Time-to-convert is measured from trial start to the observed
          subscription.created event.
        </p>
      </div>

      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-red-600 dark:text-red-400">
            {error instanceof Error
              ? error.message
              : "Failed to load drip analytics"}
          </CardContent>
        </Card>
      )}

      {/* KPI cards */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
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
      ) : a ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            title="Enrolled"
            value={a.overall.enrolled.toLocaleString()}
            icon={Users}
            description="Trialists in the drip (in-window)"
          />
          <KpiCard
            title="Trial → Paid"
            value={pct(a.overall.conversionRate)}
            icon={Percent}
            description={`${a.overall.converted.toLocaleString()} converted`}
            valueClass="text-green-600 dark:text-green-400"
          />
          <KpiCard
            title="Median Time-to-Convert"
            value={
              a.overall.medianDaysToConvert != null
                ? `${a.overall.medianDaysToConvert.toFixed(1)}d`
                : "—"
            }
            icon={Timer}
            description="From trial start to paid"
          />
          <KpiCard
            title="Attributed MRR"
            value={usd(a.overall.attributedMrrCents)}
            icon={DollarSign}
            description={`${a.overall.reconciledCount} reconciled w/ Stripe`}
            valueClass="text-green-600 dark:text-green-400"
          />
        </div>
      ) : null}

      {/* Attention flags (AC4) */}
      {a && a.flags.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader className="flex flex-row items-center gap-2 pb-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <CardTitle className="text-base">Steps needing attention</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {a.flags.map((f) => (
              <div
                key={`${f.step}-${f.reason}`}
                className="flex items-center justify-between rounded-md bg-amber-50 px-3 py-1.5 dark:bg-amber-950/40"
              >
                <span className="font-medium">
                  Step #{f.step} · {phaseLabel(f.phase)}
                </span>
                <span className="text-muted-foreground">
                  {f.reason === "high_unsub"
                    ? `High unsubscribe (${pct(f.unsubRate)})`
                    : `High drop-off (${pct(f.dropOffRate)})`}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Per-step funnel */}
      {isLoading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[280px] w-full" />
          </CardContent>
        </Card>
      ) : a ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step Funnel</CardTitle>
            <CardDescription>
              Sent → opened → clicked → converted, per drip step
            </CardDescription>
          </CardHeader>
          <CardContent>
            {funnelSeries.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                No drip sends in this period yet.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={funnelSeries}
                  margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="label"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend />
                  <Bar dataKey="sent" fill={CHART_PALETTE.navy} name="Sent" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="opened" fill={CHART_PALETTE.blue} name="Opened" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="clicked" fill={CHART_PALETTE.amber} name="Clicked" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="converted" fill={CHART_PALETTE.emerald} name="Converted" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Cohort conversion curve + phase/incentive splits */}
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
      ) : a ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cohort Conversion</CardTitle>
              <CardDescription>Trial → paid rate by signup week</CardDescription>
            </CardHeader>
            <CardContent>
              {cohortSeries.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  No signup-week cohorts yet.
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart
                    data={cohortSeries}
                    margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
                  >
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
                      tickFormatter={(v) => `${Number(v)}%`}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(value) => [`${Number(value)}%`, "Conversion"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="rate"
                      stroke={CHART_PALETTE.red}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: CHART_PALETTE.red }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Contribution &amp; Lift
              </CardTitle>
              <CardDescription>
                In-trial vs win-back, incentive on vs off, A/B winner
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {/* Phase split */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">In-trial</p>
                  <p className="text-lg font-bold">
                    {a.phaseSplit.inTrial.converted.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {usd(a.phaseSplit.inTrial.mrrCents)} MRR
                  </p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">Win-back</p>
                  <p className="text-lg font-bold">
                    {a.phaseSplit.winBack.converted.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {usd(a.phaseSplit.winBack.mrrCents)} MRR
                  </p>
                </div>
              </div>

              {/* Incentive lift */}
              <div className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    Incentive on → {pct(a.incentiveSplit.on.conversionRate)}
                  </span>
                  <span className="text-muted-foreground">
                    off → {pct(a.incentiveSplit.off.conversionRate)}
                  </span>
                </div>
                <p
                  className={`mt-1 text-base font-semibold ${
                    a.incentiveSplit.liftPts >= 0
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {a.incentiveSplit.liftPts >= 0 ? "+" : ""}
                  {(a.incentiveSplit.liftPts * 100).toFixed(1)} pts lift
                </p>
              </div>

              {/* A/B winner */}
              {winningVariant && (
                <div className="flex items-center gap-2 rounded-md bg-muted/50 p-3">
                  <Trophy className="h-4 w-4 text-amber-500" />
                  <span>
                    Winning variant{" "}
                    <strong>{winningVariant.variant}</strong> —{" "}
                    {pct(winningVariant.conversionRate)} (
                    {winningVariant.converted}/{winningVariant.enrolled})
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

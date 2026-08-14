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
import { Meter } from "@/components/ui/meter";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BarChart3,
  RefreshCw,
  Loader2,
  Info,
  TrendingDown,
} from "lucide-react";

// ── API payload types (mirror the funnel_metrics / retention_cohorts RPCs,
//    migration 00229) ──

interface FunnelStep {
  key: string;
  label: string;
  description: string;
  count: number;
}

interface FunnelResponse {
  window: { period: string; start: string; end: string; granularity: string };
  funnel: {
    period: { start: string; end: string };
    steps: FunnelStep[];
  };
}

interface RetentionCohort {
  cohortWeek: string;
  size: number;
  // retained[i] = users active in week-offset i; null = week not started yet.
  retained: Array<number | null>;
}

interface RetentionResponse {
  retention: {
    generatedAt: string;
    maxOffset: number;
    activitySignal: string;
    cohorts: RetentionCohort[];
  };
}

// US-2101 AC5: first-touch UTM channel attribution (channel_attribution RPC).
interface ChannelRow {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  users: number;
}

interface ChannelsResponse {
  channels: ChannelRow[];
}

type PeriodKey = "mtd" | "qtd" | "ytd" | "custom";

const PERIOD_LABELS: Array<{ key: PeriodKey; label: string }> = [
  { key: "mtd", label: "Month to date" },
  { key: "qtd", label: "Quarter to date" },
  { key: "ytd", label: "Year to date" },
  { key: "custom", label: "Custom" },
];

const WEEK_LABEL = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

const pct = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : 0;

// Map a retention % to a heat-map background. Brand navy, opacity by intensity.
function heatStyle(rate: number | null): React.CSSProperties {
  if (rate === null) return { backgroundColor: "transparent" };
  const alpha = 0.08 + (Math.min(rate, 100) / 100) * 0.72;
  return {
    backgroundColor: `rgba(15, 52, 96, ${alpha})`,
    color: rate >= 45 ? "white" : "inherit",
  };
}

export function AdminAnalyticsPage() {
  const [period, setPeriod] = useState<PeriodKey>("mtd");
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

  const funnelQuery = useQuery({
    queryKey: ["admin-funnel", queryParams],
    queryFn: async (): Promise<FunnelResponse> => {
      const res = await edgeFetch(`/api/admin/analytics/funnel?${queryParams}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load funnel metrics");
      return json as FunnelResponse;
    },
    staleTime: 60 * 1000,
  });

  const retentionQuery = useQuery({
    queryKey: ["admin-retention"],
    queryFn: async (): Promise<RetentionResponse> => {
      const res = await edgeFetch(`/api/admin/analytics/retention`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load retention cohorts");
      return json as RetentionResponse;
    },
    staleTime: 60 * 1000,
  });

  const channelsQuery = useQuery({
    queryKey: ["admin-channels"],
    queryFn: async (): Promise<ChannelsResponse> => {
      const res = await edgeFetch(`/api/admin/analytics/channels`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load channel attribution");
      return json as ChannelsResponse;
    },
    staleTime: 60 * 1000,
  });

  const steps = funnelQuery.data?.funnel.steps ?? [];
  const topCount = steps[0]?.count ?? 0;
  const isFetching =
    funnelQuery.isFetching || retentionQuery.isFetching ||
    channelsQuery.isFetching;

  const refetchAll = () => {
    void funnelQuery.refetch();
    void retentionQuery.refetch();
    void channelsQuery.refetch();
  };

  const channels = channelsQuery.data?.channels ?? [];

  const cohorts = retentionQuery.data?.retention.cohorts ?? [];
  const maxOffset = retentionQuery.data?.retention.maxOffset ?? 8;
  const offsets = Array.from({ length: maxOffset + 1 }, (_, i) => i);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BarChart3}
        title="Funnel & Retention"
        subtitle="Activation funnel and weekly cohort retention from our own data."
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
              onClick={refetchAll}
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

      {period === "custom" && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-4 pt-6">
            <div className="space-y-1.5">
              <Label htmlFor="fn-start">Start</Label>
              <Input
                id="fn-start"
                type="date"
                value={customStart}
                max={customEnd}
                onChange={(e) => setCustomStart(e.target.value)}
                className="w-auto"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fn-end">End</Label>
              <Input
                id="fn-end"
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

      {/* Methodology note (AC4 + AC5): definitions + PostHog complement. */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <p>
          Numbers are aggregated <strong>server-side from our own records</strong>{" "}
          (users, submissions, grade reports, subscriptions) and are read-only.
          Each funnel step is a <strong>strict subset of the previous one</strong>,
          so a step&apos;s percentage is the share of the prior step that advanced
          — making the drop-offs comparable. This complements, and does not
          replace, the event-level product analytics in PostHog.
        </p>
      </div>

      {/* ── Activation funnel ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activation Funnel</CardTitle>
          <CardDescription>
            Of users who signed up in this period, how many advanced to each
            milestone (measured to-date).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {funnelQuery.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : funnelQuery.error ? (
            <p className="py-4 text-sm text-red-600 dark:text-red-400">
              {funnelQuery.error instanceof Error
                ? funnelQuery.error.message
                : "Failed to load funnel metrics"}
            </p>
          ) : topCount === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No signups in the selected period.
            </p>
          ) : (
            <div className="space-y-3">
              {steps.map((step, idx) => {
                const prev = idx > 0 ? steps[idx - 1] : undefined;
                const ofPrev = prev ? pct(step.count, prev.count) : 100;
                const ofTop = pct(step.count, topCount);
                const dropped = prev ? prev.count - step.count : 0;
                return (
                  <div key={step.key}>
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold">{step.label}</span>
                        <span className="text-xs text-muted-foreground">
                          {step.description}
                        </span>
                      </div>
                      <div className="flex items-baseline gap-3 text-sm">
                        <span className="font-bold tabular-nums">
                          {step.count.toLocaleString()}
                        </span>
                        {idx > 0 && (
                          <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
                            {ofPrev}% of prev
                          </span>
                        )}
                      </div>
                    </div>
                    <Meter
                      value={Math.max(ofTop, 2)}
                      className="h-7 w-full overflow-hidden rounded bg-muted"
                      barClassName="flex items-center rounded bg-brand-navy px-2 text-xs font-medium text-white transition-all"
                      aria-label={`${step.label}: ${ofTop}% of top of funnel`}
                    >
                      {ofTop >= 8 ? `${ofTop}%` : ""}
                    </Meter>
                    {idx > 0 && dropped > 0 && (
                      <div className="mt-1 flex items-center gap-1 text-xs text-brand-red-text">
                        <TrendingDown className="h-3 w-3" />
                        {dropped.toLocaleString()} dropped off (
                        {pct(dropped, prev!.count)}%)
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Weekly cohort retention ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weekly Cohort Retention</CardTitle>
          <CardDescription>
            Each row is a signup week (last 12). Cells show the share of that
            cohort that was active (created a submission) that many weeks later.
            W0 is the signup week itself; blank cells are weeks that haven&apos;t
            happened yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {retentionQuery.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : retentionQuery.error ? (
            <p className="py-4 text-sm text-red-600 dark:text-red-400">
              {retentionQuery.error instanceof Error
                ? retentionQuery.error.message
                : "Failed to load retention cohorts"}
            </p>
          ) : cohorts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No signup cohorts in the last 12 weeks.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-1 text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-2 py-1 text-left font-medium">Cohort</th>
                    <th className="px-2 py-1 text-right font-medium">Users</th>
                    {offsets.map((o) => (
                      <th key={o} className="px-2 py-1 text-center font-medium">
                        W{o}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cohorts.map((row) => (
                    <tr key={row.cohortWeek}>
                      <td className="whitespace-nowrap px-2 py-1 font-medium tabular-nums">
                        {WEEK_LABEL(row.cohortWeek)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                        {row.size.toLocaleString()}
                      </td>
                      {offsets.map((o) => {
                        const cnt = row.retained[o] ?? null;
                        const rate = cnt === null ? null : pct(cnt, row.size);
                        return (
                          <td
                            key={o}
                            className="rounded px-2 py-1 text-center tabular-nums"
                            style={heatStyle(rate)}
                            title={
                              cnt === null
                                ? "Not yet"
                                : `${cnt}/${row.size} active`
                            }
                          >
                            {rate === null ? "" : `${rate}%`}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── US-2101 AC5: channel attribution ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Channel Attribution</CardTitle>
          <CardDescription>
            First-touch UTM channel per converting user — how organic, email,
            social and content acquired the accounts we have. Captured on landing
            (consent-gated) and persisted at signup.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {channelsQuery.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : channelsQuery.error ? (
            <p className="py-4 text-sm text-red-600 dark:text-red-400">
              {channelsQuery.error instanceof Error
                ? channelsQuery.error.message
                : "Failed to load channel attribution"}
            </p>
          ) : channels.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No UTM-tagged signups yet. Tagged inbound links populate this once
              they start converting.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-1 text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-2 py-1 text-left font-medium">Source</th>
                    <th className="px-2 py-1 text-left font-medium">Medium</th>
                    <th className="px-2 py-1 text-left font-medium">Campaign</th>
                    <th className="px-2 py-1 text-right font-medium">Users</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((row, i) => (
                    <tr key={`${row.utm_source}-${row.utm_medium}-${row.utm_campaign}-${i}`}>
                      <td className="px-2 py-1 font-medium">
                        {row.utm_source ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {row.utm_medium ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {row.utm_campaign ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-bold tabular-nums">
                        {row.users.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

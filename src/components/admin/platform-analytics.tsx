import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AiEnrichmentLogRow } from "@/types/database";
import type { FlipdeskPlanKey } from "@/lib/constants";
import { FLIPDESK_PLANS } from "@/lib/constants";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Legend,
  ResponsiveContainer,
} from "recharts";

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

// US-2398: the LIVE flipdesk_plan tiers. These used to be the legacy user_plan
// vocabulary, and 00525 switched the RPC to report the real one — so every
// lookup below was keyed 'professional' against a payload saying 'pro' and
// silently resolved to 0 / undefined. The plan-distribution bars read zero and
// the revenue slices lost their fill.
const PLAN_ORDER: FlipdeskPlanKey[] = ["free", "starter", "pro", "business"];
const PLAN_COLORS: Record<FlipdeskPlanKey, string> = {
  free: "#94a3b8",
  starter: "#3b82f6",
  pro: "#0F3460",
  business: "#E94560",
};
const RETENTION_COLUMNS = 6;

/** "2026-06" -> "Jun 26". The server keys cohorts by month; labelling is ours. */
function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return key;
  return new Date(year, month - 1, 1).toLocaleString("en-US", {
    month: "short",
    year: "2-digit",
  });
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

interface FunnelStage {
  label: string;
  count: number;
}

interface CohortRow {
  label: string;
  size: number;
  retention: (number | null)[];
}

/**
 * US-2390: the server-aggregated analytics document.
 *
 * This component used to receive ROWS — every user and every submission — and
 * aggregate them here. That was wrong in a way nothing showed: PostgREST caps
 * any response at `db-max-rows` and reports it only in a header supabase-js does
 * not surface, so the funnel, the cohorts and the top-users table were computed
 * over whatever fraction came back, and rendered as if they covered everything.
 * The aggregation is SQL now (migration 00513), and these are the answers.
 */
export interface PlatformAnalyticsData {
  funnel: {
    signedUp: number;
    firstSubmission: number;
    completedGrade: number;
    subscribed: number;
  };
  /** Plan slug -> user count. Absent plans mean zero, not missing. */
  planDistribution: Record<string, number>;
  topUsers: Array<{ id: string; name: string; plan: string; count: number }>;
  /** `month` is "YYYY-MM"; a null retention cell is a month not yet reached. */
  cohorts: Array<{ month: string; size: number; retention: (number | null)[] }>;
  gradeVolume: Array<{ label: string; count: number }>;
}

interface PlatformAnalyticsProps {
  analytics: PlatformAnalyticsData | undefined;
}

export function PlatformAnalytics({
  analytics: data,
}: PlatformAnalyticsProps) {
  const analytics = useMemo(() => {
    // ── User funnel ── (counts of DISTINCT users, computed server-side)
    const funnel: FunnelStage[] = [
      { label: "Signed Up", count: data?.funnel.signedUp ?? 0 },
      { label: "First Submission", count: data?.funnel.firstSubmission ?? 0 },
      { label: "Completed Grade", count: data?.funnel.completedGrade ?? 0 },
      { label: "Subscribed", count: data?.funnel.subscribed ?? 0 },
    ];

    // ── Plan distribution ──
    const planCounts = new Map<FlipdeskPlanKey, number>();
    for (const plan of PLAN_ORDER) {
      planCounts.set(plan, data?.planDistribution[plan] ?? 0);
    }
    const planDistribution = PLAN_ORDER.map((plan) => ({
      plan,
      label: FLIPDESK_PLANS[plan].name,
      count: planCounts.get(plan) ?? 0,
    }));

    // ── Revenue breakdown (monthly recurring, by plan) ──
    const revenueByPlan = PLAN_ORDER.filter((p) => p !== "free")
      .map((plan) => {
        // US-2365: cents on the current source; the legacy shim divided by 100
        // for us. Doing it here keeps the one conversion visible instead of
        // buried in a deprecated derivation.
        const flip = FLIPDESK_PLANS[plan];
        const price = flip.priceMonthlyCents / 100;
        return {
          name: flip.name,
          plan,
          value: price * (planCounts.get(plan) ?? 0),
        };
      })
      .filter((slice) => slice.value > 0);
    const totalMrr = revenueByPlan.reduce((sum, s) => sum + s.value, 0);

    // ── Grade volume trend, top users, cohort retention ──
    // All three arrive aggregated. The bucket labels are built alongside the
    // counts on the server, so a bucket and its label can no longer disagree.
    const volumeBuckets = data?.gradeVolume ?? [];
    const topUsers = data?.topUsers ?? [];
    const cohorts: CohortRow[] = (data?.cohorts ?? []).map((c) => ({
      label: monthLabel(c.month),
      size: c.size,
      // Pad to the rendered width so a short row can't misalign the columns.
      retention: Array.from(
        { length: RETENTION_COLUMNS },
        (_, i) => c.retention[i] ?? null,
      ),
    }));

    return {
      funnel,
      planDistribution,
      revenueByPlan,
      totalMrr,
      volumeBuckets,
      topUsers,
      cohorts,
    };
  }, [data]);

  const funnelMax = analytics.funnel[0]?.count || 1;

  // AI enrichment acceptance — suggested vs accepted fields (US-167).
  const { data: aiLogs } = useQuery({
    queryKey: ["admin-ai-acceptance"],
    queryFn: async (): Promise<{
      logs: AiEnrichmentLogRow[];
      truncated: boolean;
    }> => {
      // US-1565: through the edge boundary instead of a direct table read.
      const res = await edgeFetch("/api/admin/dashboard/enrichment-log");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load enrichment log.");
      // US-2390: this endpoint is capped, and it now says so. Every other number
      // on this page is an exact aggregate, which is exactly why the one capped
      // number has to be labelled — otherwise it inherits their credibility.
      return {
        logs: (json.logs ?? []) as AiEnrichmentLogRow[],
        truncated: json.truncated === true,
      };
    },
    staleTime: 60 * 1000,
  });

  const aiAcceptance = useMemo(() => {
    const logs = aiLogs?.logs ?? [];
    const byField = new Map<string, { suggested: number; accepted: number }>();
    let totalSuggested = 0;
    let totalAccepted = 0;
    for (const log of logs) {
      const suggested = log.suggested_fields ?? {};
      const accepted = log.accepted_fields ?? {};
      for (const field of Object.keys(suggested)) {
        const row = byField.get(field) ?? { suggested: 0, accepted: 0 };
        row.suggested += 1;
        totalSuggested += 1;
        if (field in accepted) {
          row.accepted += 1;
          totalAccepted += 1;
        }
        byField.set(field, row);
      }
    }
    const fields = Array.from(byField.entries())
      .map(([field, v]) => ({
        field,
        suggested: v.suggested,
        accepted: v.accepted,
        rate: v.suggested > 0 ? (v.accepted / v.suggested) * 100 : 0,
      }))
      .sort((a, b) => b.suggested - a.suggested);
    return {
      fields,
      totalSuggested,
      totalAccepted,
      overallRate:
        totalSuggested > 0 ? (totalAccepted / totalSuggested) * 100 : 0,
      logCount: logs.length,
      truncated: aiLogs?.truncated === true,
    };
  }, [aiLogs]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* User funnel */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">User Funnel</CardTitle>
          <CardDescription>
            Conversion from signup through to a paid subscription.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {analytics.funnel.map((stage, i) => {
            const prev = analytics.funnel[i - 1];
            const conversion =
              prev && prev.count > 0
                ? (stage.count / prev.count) * 100
                : null;
            return (
              <div key={stage.label} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{stage.label}</span>
                  <span className="text-muted-foreground">
                    {stage.count.toLocaleString()}
                    {conversion !== null && (
                      <span className="ml-2 text-xs">
                        ({conversion.toFixed(0)}%)
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-6 w-full rounded bg-muted">
                  <div
                    className="h-6 rounded bg-brand-navy"
                    style={{
                      width: `${Math.max(
                        2,
                        (stage.count / funnelMax) * 100
                      )}%`,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Revenue breakdown */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Revenue Breakdown</CardTitle>
          <CardDescription>
            Monthly recurring revenue by plan ·{" "}
            {formatCurrency(analytics.totalMrr)} total
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analytics.revenueByPlan.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No subscription revenue yet.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={analytics.revenueByPlan}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={85}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, percent }) =>
                    `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                  }
                  fontSize={11}
                >
                  {analytics.revenueByPlan.map((slice) => (
                    <Cell
                      key={slice.plan}
                      fill={PLAN_COLORS[slice.plan]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value) => [formatCurrency(Number(value))]}
                />
                <Legend fontSize={12} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Grade volume trend */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Grade Volume Trend</CardTitle>
          <CardDescription>
            Grades processed daily over the last 90 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart
              data={analytics.volumeBuckets}
              margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="label"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={28}
              />
              <YAxis
                fontSize={11}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value) => [Number(value), "Grades"]}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#0F3460"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "#0F3460" }}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Plan distribution */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Plan Distribution</CardTitle>
          <CardDescription>Users on each plan tier.</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              data={analytics.planDistribution}
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
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value) => [Number(value), "Users"]}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {analytics.planDistribution.map((entry) => (
                  <Cell key={entry.plan} fill={PLAN_COLORS[entry.plan]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Top users by submissions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Top Users by Submissions</CardTitle>
          <CardDescription>Most active accounts.</CardDescription>
        </CardHeader>
        <CardContent>
          {analytics.topUsers.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No submissions yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Submissions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics.topUsers.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="max-w-[180px] truncate font-medium">
                        {u.name}
                      </TableCell>
                      <TableCell className="capitalize text-muted-foreground">
                        {u.plan}
                      </TableCell>
                      <TableCell className="text-right">{u.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cohort retention */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Cohort Retention</CardTitle>
          <CardDescription>
            Share of each monthly signup cohort still submitting in later
            months.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analytics.cohorts.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Not enough signup history yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cohort</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    {Array.from({ length: RETENTION_COLUMNS }).map((_, i) => (
                      <TableHead key={i} className="text-right">
                        Mo {i}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics.cohorts.map((cohort) => (
                    <TableRow key={cohort.label}>
                      <TableCell className="font-medium">
                        {cohort.label}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {cohort.size}
                      </TableCell>
                      {cohort.retention.map((pct, i) => (
                        <TableCell
                          key={i}
                          className="text-right text-xs"
                          style={
                            pct === null
                              ? undefined
                              : {
                                  backgroundColor: `rgba(15, 52, 96, ${
                                    (pct / 100) * 0.85
                                  })`,
                                  color: pct > 55 ? "#fff" : undefined,
                                }
                          }
                        >
                          {pct === null ? "" : `${pct.toFixed(0)}%`}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* AI enrichment acceptance (US-167) */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            AI Enrichment Acceptance
          </CardTitle>
          <CardDescription>
            How often AI field suggestions are kept — the signal for tuning
            prompts. {aiAcceptance.totalAccepted} of{" "}
            {aiAcceptance.totalSuggested} suggested fields accepted (
            {aiAcceptance.overallRate.toFixed(0)}% overall) across{" "}
            {aiAcceptance.logCount.toLocaleString()}{" "}
            {aiAcceptance.truncated ? "most recent" : ""} extraction calls.
            {aiAcceptance.truncated && (
              <>
                {" "}
                Older calls exist beyond this window — unlike the other panels
                here, these rates are measured over a sample.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {aiAcceptance.fields.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No AI enrichment activity yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead className="text-right">Suggested</TableHead>
                    <TableHead className="text-right">Accepted</TableHead>
                    <TableHead className="text-right">Accept rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aiAcceptance.fields.map((f) => (
                    <TableRow key={f.field}>
                      <TableCell className="font-medium">{f.field}</TableCell>
                      <TableCell className="text-right">
                        {f.suggested}
                      </TableCell>
                      <TableCell className="text-right">
                        {f.accepted}
                      </TableCell>
                      <TableCell
                        className={
                          f.rate < 50
                            ? "text-right text-red-600 dark:text-red-400"
                            : "text-right text-green-600 dark:text-green-400"
                        }
                      >
                        {f.rate.toFixed(0)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

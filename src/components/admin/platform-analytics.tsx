import { useMemo } from "react";
import type {
  UserRow,
  SubmissionRow,
  GradeReportRow,
  UserPlan,
} from "@/types/database";
import { PLANS } from "@/lib/constants";
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

const PLAN_ORDER: UserPlan[] = ["free", "starter", "professional", "enterprise"];
const PLAN_COLORS: Record<UserPlan, string> = {
  free: "#94a3b8",
  starter: "#3b82f6",
  professional: "#0F3460",
  enterprise: "#E94560",
};
const RETENTION_COLUMNS = 6;

function monthIndex(iso: string): number {
  const d = new Date(iso);
  return d.getFullYear() * 12 + d.getMonth();
}

function monthLabel(idx: number): string {
  const year = Math.floor(idx / 12);
  const month = idx % 12;
  return new Date(year, month, 1).toLocaleString("en-US", {
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

interface PlatformAnalyticsProps {
  users: UserRow[];
  submissions: SubmissionRow[];
  gradeReports: GradeReportRow[];
}

export function PlatformAnalytics({
  users,
  submissions,
  gradeReports,
}: PlatformAnalyticsProps) {
  const analytics = useMemo(() => {
    // ── User funnel ──
    const submitterIds = new Set(submissions.map((s) => s.user_id));
    const completedUserIds = new Set(
      submissions
        .filter((s) => s.status === "completed")
        .map((s) => s.user_id)
    );
    const subscribedUserIds = new Set(
      users.filter((u) => u.plan !== "free").map((u) => u.id)
    );
    const funnel: FunnelStage[] = [
      { label: "Signed Up", count: users.length },
      { label: "First Submission", count: submitterIds.size },
      { label: "Completed Grade", count: completedUserIds.size },
      { label: "Subscribed", count: subscribedUserIds.size },
    ];

    // ── Plan distribution ──
    const planCounts = new Map<UserPlan, number>();
    for (const plan of PLAN_ORDER) planCounts.set(plan, 0);
    for (const u of users) {
      planCounts.set(u.plan, (planCounts.get(u.plan) ?? 0) + 1);
    }
    const planDistribution = PLAN_ORDER.map((plan) => ({
      plan,
      label: PLANS[plan].name,
      count: planCounts.get(plan) ?? 0,
    }));

    // ── Revenue breakdown (monthly recurring, by plan) ──
    const revenueByPlan = PLAN_ORDER.filter((p) => p !== "free")
      .map((plan) => {
        const price = PLANS[plan].priceMonthly ?? 0;
        return {
          name: PLANS[plan].name,
          plan,
          value: price * (planCounts.get(plan) ?? 0),
        };
      })
      .filter((slice) => slice.value > 0);
    const totalMrr = revenueByPlan.reduce((sum, s) => sum + s.value, 0);

    // ── Grade volume trend (last 90 days) ──
    const now = new Date();
    const volumeBuckets: { label: string; key: string; count: number }[] = [];
    const keyToIdx = new Map<string, number>();
    for (let i = 89; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      keyToIdx.set(key, volumeBuckets.length);
      volumeBuckets.push({
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        key,
        count: 0,
      });
    }
    for (const report of gradeReports) {
      const d = new Date(report.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const idx = keyToIdx.get(key);
      if (idx !== undefined) volumeBuckets[idx]!.count += 1;
    }

    // ── Top users by submissions ──
    const subCountByUser = new Map<string, number>();
    for (const s of submissions) {
      subCountByUser.set(s.user_id, (subCountByUser.get(s.user_id) ?? 0) + 1);
    }
    const userById = new Map(users.map((u) => [u.id, u]));
    const topUsers = Array.from(subCountByUser.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userId, count]) => {
        const u = userById.get(userId);
        return {
          id: userId,
          name: u?.full_name || u?.email || "Unknown user",
          plan: u?.plan ?? "free",
          count,
        };
      });

    // ── Cohort retention (monthly) ──
    // A user is "active" in a month if they created a submission that month.
    const activityByUser = new Map<string, Set<number>>();
    for (const s of submissions) {
      const set = activityByUser.get(s.user_id) ?? new Set<number>();
      set.add(monthIndex(s.created_at));
      activityByUser.set(s.user_id, set);
    }

    const cohortMembers = new Map<number, string[]>();
    for (const u of users) {
      const idx = monthIndex(u.created_at);
      const list = cohortMembers.get(idx) ?? [];
      list.push(u.id);
      cohortMembers.set(idx, list);
    }
    const cohortIndices = Array.from(cohortMembers.keys())
      .sort((a, b) => a - b)
      .slice(-RETENTION_COLUMNS);
    const cohorts: CohortRow[] = cohortIndices.map((cohortIdx) => {
      const members = cohortMembers.get(cohortIdx) ?? [];
      const retention: (number | null)[] = [];
      for (let offset = 0; offset < RETENTION_COLUMNS; offset++) {
        const targetMonth = cohortIdx + offset;
        if (targetMonth > monthIndex(now.toISOString())) {
          retention.push(null);
          continue;
        }
        const active = members.filter((id) =>
          activityByUser.get(id)?.has(targetMonth)
        ).length;
        retention.push(
          members.length > 0 ? (active / members.length) * 100 : 0
        );
      }
      return {
        label: monthLabel(cohortIdx),
        size: members.length,
        retention,
      };
    });

    return {
      funnel,
      planDistribution,
      revenueByPlan,
      totalMrr,
      volumeBuckets,
      topUsers,
      cohorts,
    };
  }, [users, submissions, gradeReports]);

  const funnelMax = analytics.funnel[0]?.count || 1;

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
    </div>
  );
}

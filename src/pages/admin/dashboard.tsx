import { useQuery } from "@tanstack/react-query";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { edgeFetch } from "@/lib/edge-fetch";
import { CHART_PALETTE } from "@/lib/constants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  PlatformAnalytics,
  type PlatformAnalyticsData,
} from "@/components/admin/platform-analytics";
import { PendingRefundsCard } from "@/components/admin/pending-refunds-card";
import { WebhookDeadLettersCard } from "@/components/admin/webhook-dead-letters-card";
import {
  LayoutDashboard,
  Users,
  CreditCard,
  FileText,
  DollarSign,
  Star,
  AlertTriangle,
  Brain,
  ClipboardList,
  RefreshCw,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

interface AdminKPIs {
  totalUsers: number;
  activeSubscribers: number;
  submissionsToday: number;
  revenueThisMonth: number;
  // US-2390: an EXACT all-time mean, aggregated in SQL (migration 00513). It
  // briefly travelled with `averageGradeSampleSize`/`averageGradeTruncated`
  // while it was measured from a capped read of rows; there is no sample to
  // describe any more, so those fields are gone rather than left reading
  // "not truncated" forever.
  averageGrade: number;
  disputeRatePercent: number;
  aiAccuracyPercent: number;
  pendingReviews: number;
}

interface DailyPoint {
  date: string;
  label: string;
}

interface SubmissionPoint extends DailyPoint {
  count: number;
}

interface RevenuePoint extends DailyPoint {
  revenue: number;
}

interface UserPoint extends DailyPoint {
  count: number;
}

interface AdminChartData {
  submissionVolume: SubmissionPoint[];
  revenueOverTime: RevenuePoint[];
  newUsers: UserPoint[];
}

interface AdminDashboardData {
  kpis: AdminKPIs;
  charts: AdminChartData;
  // US-2390: the ANSWERS, not the rows. This used to be `raw` — every user and
  // submission row, which PlatformAnalytics aggregated in a useMemo while
  // believing it had the whole corpus. It is aggregated in SQL now, so the
  // payload is a fixed size whatever the platform's.
  analytics: PlatformAnalyticsData;
}

export function AdminDashboardPage() {
  const visible = useDocumentVisible();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: async (): Promise<AdminDashboardData> => {
      // US-1565: aggregates are computed on the edge (narrow selects, one
      // request) instead of six whole-table client pulls.
      const res = await edgeFetch("/api/admin/dashboard/summary");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load dashboard data.");
      return json as AdminDashboardData;
    },
    staleTime: 30 * 1000,
    // Auto-refresh every 60s, but only while the tab is visible so a
    // backgrounded admin dashboard stops polling. (US-576)
    refetchInterval: visible ? 60 * 1000 : false,
  });

  const kpis = data?.kpis;
  const charts = data?.charts;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <LayoutDashboard className="h-6 w-6 text-brand-red-text" />
          <h1 className="text-2xl font-bold">Admin Dashboard</h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Auto-refreshes every 60s</span>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="analytics">Platform Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
      {/* Primary KPI Cards */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-28" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{kpis?.totalUsers.toLocaleString()}</div>
              <CardDescription>Registered accounts</CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Active Subscribers</CardTitle>
              <CreditCard className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{kpis?.activeSubscribers.toLocaleString()}</div>
              <CardDescription>Paid plans</CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Submissions Today</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{kpis?.submissionsToday.toLocaleString()}</div>
              <CardDescription>New grades requested</CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Revenue This Month</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                ${kpis?.revenueThisMonth.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <CardDescription>From sales</CardDescription>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Secondary KPI Cards */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-28" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Average Grade</CardTitle>
              <Star className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {kpis?.averageGrade ? kpis.averageGrade.toFixed(1) : "—"}
              </div>
              {/* US-2390: "Across all grades" is TRUE again. It was not true
                  when this endpoint summed rows in JS — PostgREST capped the
                  read with nothing to say so — and for one pass the label read
                  "most recent N" to stop the caption claiming more than the
                  number could support. The mean is an SQL aggregate now, so
                  the original caption is the accurate one. */}
              <CardDescription>Across all grades</CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Dispute Rate</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {kpis?.disputeRatePercent.toFixed(1)}%
              </div>
              <CardDescription>Of completed grades</CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">AI Accuracy</CardTitle>
              <Brain className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {kpis?.aiAccuracyPercent.toFixed(1)}%
              </div>
              <CardDescription>High-confidence rate</CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Pending Reviews</CardTitle>
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{kpis?.pendingReviews}</div>
              <CardDescription>Awaiting human review</CardDescription>
            </CardContent>
          </Card>
        </div>
      )}

      {/* US-771: operator queue for per-grade refunds that need attention. */}
      <PendingRefundsCard />

      {/* US-772: dropped-webhook dead-letter queue. */}
      <WebhookDeadLettersCard />

      {/* Charts */}
      {isLoading ? (
        <div className="grid gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-60" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-[250px] w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4">
          {/* Submission Volume (30 days) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Submission Volume</CardTitle>
              <CardDescription>Daily submissions over the last 30 days</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart
                  data={charts?.submissionVolume}
                  margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="label"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value) => [Number(value), "Submissions"]}
                    labelFormatter={(label) => `Date: ${String(label)}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="count"
                    stroke={CHART_PALETTE.navy}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: CHART_PALETTE.navy }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Revenue (30 days) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Revenue</CardTitle>
              <CardDescription>Daily revenue over the last 30 days</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart
                  data={charts?.revenueOverTime}
                  margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="label"
                    fontSize={11}
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
                    formatter={(value) => [
                      `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                      "Revenue",
                    ]}
                    labelFormatter={(label) => `Date: ${String(label)}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    stroke={CHART_PALETTE.emerald}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: CHART_PALETTE.emerald }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* New Users (30 days) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">New Users</CardTitle>
              <CardDescription>Daily signups over the last 30 days</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart
                  data={charts?.newUsers}
                  margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="label"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value) => [Number(value), "New Users"]}
                    labelFormatter={(label) => `Date: ${String(label)}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="count"
                    stroke={CHART_PALETTE.red}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: CHART_PALETTE.red }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}
        </TabsContent>

        <TabsContent value="analytics">
          {isLoading ? (
            <div className="grid gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
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
          ) : (
            <PlatformAnalytics analytics={data?.analytics} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

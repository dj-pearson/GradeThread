import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type {
  UserRow,
  SubmissionRow,
  GradeReportRow,
  DisputeRow,
  SaleRow,
  HumanReviewRow,
} from "@/types/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
}

function buildDailyBuckets(days: number): Array<{ date: string; label: string; start: Date; end: Date }> {
  const now = new Date();
  const buckets: Array<{ date: string; label: string; start: Date; end: Date }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    buckets.push({
      date: dateStr,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      start,
      end,
    });
  }
  return buckets;
}

function processAdminData(
  users: UserRow[],
  submissions: SubmissionRow[],
  gradeReports: GradeReportRow[],
  disputes: DisputeRow[],
  sales: SaleRow[],
  humanReviews: HumanReviewRow[]
): AdminDashboardData {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // KPI: Total Users
  const totalUsers = users.length;

  // KPI: Active Subscribers (non-free plan)
  const activeSubscribers = users.filter((u) => u.plan !== "free").length;

  // KPI: Submissions Today
  const submissionsToday = submissions.filter(
    (s) => new Date(s.created_at) >= todayStart
  ).length;

  // KPI: Revenue This Month (sum of sales this month)
  const revenueThisMonth = sales
    .filter((s) => new Date(s.sale_date) >= monthStart)
    .reduce((sum, s) => sum + s.sale_price, 0);

  // KPI: Average Grade
  const completedReports = gradeReports.filter((r) => r.overall_score > 0);
  const averageGrade =
    completedReports.length > 0
      ? Math.round(
          (completedReports.reduce((sum, r) => sum + r.overall_score, 0) /
            completedReports.length) *
            10
        ) / 10
      : 0;

  // KPI: Dispute Rate % (disputes / completed submissions)
  const completedSubmissions = submissions.filter((s) => s.status === "completed" || s.status === "disputed");
  const disputeRatePercent =
    completedSubmissions.length > 0
      ? Math.round((disputes.length / completedSubmissions.length) * 1000) / 10
      : 0;

  // KPI: AI Accuracy % (reports with confidence >= 0.75 / total reports)
  const highConfidence = completedReports.filter((r) => r.confidence_score >= 0.75);
  const aiAccuracyPercent =
    completedReports.length > 0
      ? Math.round((highConfidence.length / completedReports.length) * 1000) / 10
      : 0;

  // KPI: Pending Reviews (human reviews not yet completed)
  const pendingReviews = humanReviews.filter((r) => r.adjusted_score === null).length;

  const kpis: AdminKPIs = {
    totalUsers,
    activeSubscribers,
    submissionsToday,
    revenueThisMonth,
    averageGrade,
    disputeRatePercent,
    aiAccuracyPercent,
    pendingReviews,
  };

  // Charts: 30-day daily buckets
  const buckets = buildDailyBuckets(30);

  // Submission volume
  const submissionVolume: SubmissionPoint[] = buckets.map((b) => ({
    date: b.date,
    label: b.label,
    count: submissions.filter((s) => {
      const d = new Date(s.created_at);
      return d >= b.start && d < b.end;
    }).length,
  }));

  // Revenue over time (daily)
  const revenueOverTime: RevenuePoint[] = buckets.map((b) => ({
    date: b.date,
    label: b.label,
    revenue: sales
      .filter((s) => {
        const d = new Date(s.sale_date);
        return d >= b.start && d < b.end;
      })
      .reduce((sum, s) => sum + s.sale_price, 0),
  }));

  // New users over time (daily)
  const newUsers: UserPoint[] = buckets.map((b) => ({
    date: b.date,
    label: b.label,
    count: users.filter((u) => {
      const d = new Date(u.created_at);
      return d >= b.start && d < b.end;
    }).length,
  }));

  return {
    kpis,
    charts: { submissionVolume, revenueOverTime, newUsers },
  };
}

export function AdminDashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: async () => {
      // Fetch all data in parallel — admin RLS policies allow reading all rows
      const [usersRes, subsRes, reportsRes, disputesRes, salesRes, reviewsRes] = await Promise.all([
        supabase.from("users").select("*"),
        supabase.from("submissions").select("*"),
        supabase.from("grade_reports").select("*"),
        supabase.from("disputes").select("*"),
        supabase.from("sales").select("*"),
        supabase.from("human_reviews").select("*"),
      ]);

      if (usersRes.error) throw usersRes.error;
      if (subsRes.error) throw subsRes.error;
      if (reportsRes.error) throw reportsRes.error;
      if (disputesRes.error) throw disputesRes.error;
      if (salesRes.error) throw salesRes.error;
      if (reviewsRes.error) throw reviewsRes.error;

      const users = (usersRes.data ?? []) as UserRow[];
      const submissions = (subsRes.data ?? []) as SubmissionRow[];
      const gradeReports = (reportsRes.data ?? []) as GradeReportRow[];
      const disputes = (disputesRes.data ?? []) as DisputeRow[];
      const sales = (salesRes.data ?? []) as SaleRow[];
      const humanReviews = (reviewsRes.data ?? []) as HumanReviewRow[];

      return processAdminData(users, submissions, gradeReports, disputes, sales, humanReviews);
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000, // Auto-refresh every 60 seconds
  });

  const kpis = data?.kpis;
  const charts = data?.charts;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <LayoutDashboard className="h-6 w-6 text-brand-red" />
          <h1 className="text-2xl font-bold">Admin Dashboard</h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Auto-refreshes every 60s</span>
        </div>
      </div>

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
              <div className="text-2xl font-bold text-green-600">
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
                    stroke="#0F3460"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: "#0F3460" }}
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
                    stroke="#16a34a"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: "#16a34a" }}
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
                    stroke="#E94560"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: "#E94560" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

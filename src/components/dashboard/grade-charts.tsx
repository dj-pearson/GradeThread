import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { GRADE_TIERS } from "@/lib/constants";
import type { SubmissionRow, GradeReportRow, GarmentType } from "@/types/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3, TrendingUp, PieChart as PieChartIcon } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

const TIER_COLORS: Record<string, string> = {
  NWT: "#16a34a",
  NWOT: "#22c55e",
  Excellent: "#3b82f6",
  "Very Good": "#6366f1",
  Good: "#8b5cf6",
  Fair: "#f59e0b",
  Poor: "#ef4444",
};

const PIE_COLORS = ["#0F3460", "#E94560", "#3b82f6", "#22c55e", "#f59e0b", "#8b5cf6"];

function formatGarmentType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

interface ChartData {
  gradeDistribution: Array<{ tier: string; count: number; fill: string }>;
  avgGradeOverTime: Array<{ week: string; average: number }>;
  garmentTypeBreakdown: Array<{ name: string; value: number }>;
  hasData: boolean;
}

function processChartData(
  submissions: SubmissionRow[],
  reports: Array<GradeReportRow & { submission_id: string }>
): ChartData {
  const completedSubmissions = submissions.filter((s) => s.status === "completed");

  if (completedSubmissions.length === 0 || reports.length === 0) {
    return { gradeDistribution: [], avgGradeOverTime: [], garmentTypeBreakdown: [], hasData: false };
  }

  // Build a map of submission_id -> report for easy lookup
  const reportMap = new Map(reports.map((r) => [r.submission_id, r]));

  // Grade distribution by tier
  const tierCounts: Record<string, number> = {};
  for (const tier of GRADE_TIERS) {
    tierCounts[tier] = 0;
  }
  for (const report of reports) {
    const current = tierCounts[report.grade_tier];
    if (current !== undefined) {
      tierCounts[report.grade_tier] = current + 1;
    }
  }
  const gradeDistribution = GRADE_TIERS.map((tier) => ({
    tier: tier as string,
    count: tierCounts[tier] ?? 0,
    fill: TIER_COLORS[tier] ?? "#94a3b8",
  }));

  // Average grade over time (last 30 days, weekly buckets)
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const weekBuckets: Array<{ start: Date; end: Date; label: string; scores: number[] }> = [];
  for (let i = 0; i < 4; i++) {
    const bucketEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const bucketStart = new Date(bucketEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    weekBuckets.unshift({
      start: bucketStart,
      end: bucketEnd,
      label: `${bucketStart.getMonth() + 1}/${bucketStart.getDate()}`,
      scores: [],
    });
  }

  for (const sub of completedSubmissions) {
    const subDate = new Date(sub.created_at);
    if (subDate < thirtyDaysAgo) continue;
    const report = reportMap.get(sub.id);
    if (!report) continue;

    for (const bucket of weekBuckets) {
      if (subDate >= bucket.start && subDate < bucket.end) {
        bucket.scores.push(report.overall_score);
        break;
      }
    }
  }

  const avgGradeOverTime = weekBuckets.map((bucket) => ({
    week: bucket.label,
    average:
      bucket.scores.length > 0
        ? Math.round((bucket.scores.reduce((a, b) => a + b, 0) / bucket.scores.length) * 10) / 10
        : 0,
  }));

  // Submissions by garment type
  const typeCounts: Record<string, number> = {};
  for (const sub of submissions) {
    const t = sub.garment_type as GarmentType;
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  }
  const garmentTypeBreakdown = Object.entries(typeCounts)
    .map(([name, value]) => ({ name: formatGarmentType(name), value }))
    .sort((a, b) => b.value - a.value);

  return { gradeDistribution, avgGradeOverTime, garmentTypeBreakdown, hasData: true };
}

export function GradeCharts() {
  const { data: chartData, isLoading } = useQuery({
    queryKey: ["dashboard-charts"],
    queryFn: async () => {
      // Fetch all user submissions
      const { data: subs, error: subsError } = await supabase
        .from("submissions")
        .select("*")
        .order("created_at", { ascending: false });

      if (subsError) throw subsError;
      const submissions = (subs ?? []) as SubmissionRow[];

      // Fetch all grade reports for completed submissions
      const completedIds = submissions
        .filter((s) => s.status === "completed")
        .map((s) => s.id);

      let reports: Array<GradeReportRow & { submission_id: string }> = [];
      if (completedIds.length > 0) {
        // Batch fetch in chunks of 100 to avoid query limits
        for (let i = 0; i < completedIds.length; i += 100) {
          const chunk = completedIds.slice(i, i + 100);
          const { data: reportData, error: reportError } = await supabase
            .from("grade_reports")
            .select("*")
            .in("submission_id", chunk);

          if (reportError) throw reportError;
          const rows = (reportData ?? []) as Array<GradeReportRow & { submission_id: string }>;
          reports = reports.concat(rows);
        }
      }

      return processChartData(submissions, reports);
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className={i === 2 ? "lg:col-span-2" : ""}>
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
    );
  }

  if (!chartData?.hasData) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <BarChart3 className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">No analytics data yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Complete some grading submissions to see your analytics charts here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Grade Distribution Histogram */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Grade Distribution</CardTitle>
            <CardDescription>Count of grades by tier</CardDescription>
          </div>
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData.gradeDistribution} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="tier"
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
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "var(--radius)",
                  fontSize: 12,
                }}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {chartData.gradeDistribution.map((entry, index) => (
                  <Cell key={index} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Average Grade Over Time */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Average Grade Over Time</CardTitle>
            <CardDescription>Weekly average (last 30 days)</CardDescription>
          </div>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={chartData.avgGradeOverTime} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="week"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                fontSize={11}
                tickLine={false}
                axisLine={false}
                domain={[0, 10]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "var(--radius)",
                  fontSize: 12,
                }}
                formatter={(value) => [Number(value).toFixed(1), "Avg Grade"]}
              />
              <Line
                type="monotone"
                dataKey="average"
                stroke="#0F3460"
                strokeWidth={2}
                dot={{ r: 4, fill: "#0F3460" }}
                activeDot={{ r: 6 }}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Submissions by Garment Type */}
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Submissions by Garment Type</CardTitle>
            <CardDescription>Breakdown of all submissions</CardDescription>
          </div>
          <PieChartIcon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={chartData.garmentTypeBreakdown}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                dataKey="value"
                label={({ name, percent }) =>
                  `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                }
                labelLine={true}
                fontSize={12}
              >
                {chartData.garmentTypeBreakdown.map((_, index) => (
                  <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "var(--radius)",
                  fontSize: 12,
                }}
              />
              <Legend fontSize={12} />
            </PieChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

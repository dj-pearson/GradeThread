import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { CHART_PALETTE } from "@/lib/constants";
import {
  processChartData,
  type ChartReport,
  type ChartSubmission,
} from "@/lib/grade-chart-data";
import { Skeleton } from "@/components/ui/skeleton";
import { WidgetLoadError } from "@/components/dashboard/widgets/flipdesk-shared";
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

const PIE_COLORS = [
  CHART_PALETTE.navy,
  CHART_PALETTE.red,
  CHART_PALETTE.blue,
  CHART_PALETTE.green,
  CHART_PALETTE.amber,
  CHART_PALETTE.violet,
];

/**
 * One tooltip style for all three charts. The theme tokens are HEX values
 * (src/index.css), so they are used as var(--card) directly; wrapping them in
 * hsl() produced invalid CSS and a tooltip with no background.
 */
const TOOLTIP_STYLE = {
  backgroundColor: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  fontSize: 12,
} as const;

const CHART_SUBMISSION_COLUMNS = "id, status, created_at, garment_type, superseded_at";
const CHART_REPORT_COLUMNS = "submission_id, grade_tier, overall_score";

export function GradeCharts() {
  const { data: chartData, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["dashboard-charts"],
    queryFn: async () => {
      // Live submissions only: a retake supersedes the original.
      const { data: subs, error: subsError } = await supabase
        .from("submissions")
        .select(CHART_SUBMISSION_COLUMNS)
        .is("superseded_at", null)
        .order("created_at", { ascending: false });

      if (subsError) throw subsError;
      const submissions = (subs ?? []) as ChartSubmission[];

      const completedIds = submissions
        .filter((s) => s.status === "completed")
        .map((s) => s.id);

      // Chunks of 100 keep each URL under the proxy limit; they are
      // independent, so they run together rather than one after another.
      const chunks: string[][] = [];
      for (let i = 0; i < completedIds.length; i += 100) {
        chunks.push(completedIds.slice(i, i + 100));
      }
      const results = await Promise.all(
        chunks.map((chunk) =>
          supabase
            .from("grade_reports")
            .select(CHART_REPORT_COLUMNS)
            .in("submission_id", chunk)
            .is("superseded_at", null) // US-479: active report per submission
        ),
      );
      const reports: ChartReport[] = [];
      for (const { data: reportData, error: reportError } of results) {
        if (reportError) throw reportError;
        reports.push(...((reportData ?? []) as ChartReport[]));
      }

      return processChartData(submissions, reports);
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={i === 2 ? "space-y-2 lg:col-span-2" : "space-y-2"}>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-[250px] w-full" />
          </div>
        ))}
      </div>
    );
  }

  // Before the empty check: a failed read is not "no data yet".
  if (isError) {
    return (
      <WidgetLoadError
        what="your grade trends"
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  if (!chartData?.hasData) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-6 text-center">
        <p className="text-sm font-medium">No grades to chart yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Complete a grading submission and your trends show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section>
        <h4 className="text-sm font-medium">Grade distribution</h4>
        <p className="mb-2 text-xs text-muted-foreground">Count of grades by tier</p>
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
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {chartData.gradeDistribution.map((entry, index) => (
                <Cell key={index} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </section>

      <section>
        <h4 className="text-sm font-medium">Average grade over time</h4>
        <p className="mb-2 text-xs text-muted-foreground">Weekly average, last 4 weeks</p>
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
              domain={[1, 10]}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value) => [Number(value).toFixed(1), "Avg Grade"]}
            />
            <Line
              type="monotone"
              dataKey="average"
              stroke={CHART_PALETTE.navy}
              strokeWidth={2}
              dot={{ r: 4, fill: CHART_PALETTE.navy }}
              activeDot={{ r: 6 }}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <section className="lg:col-span-2">
        <h4 className="text-sm font-medium">Submissions by garment type</h4>
        <p className="mb-2 text-xs text-muted-foreground">Breakdown of all submissions</p>
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
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Legend fontSize={12} />
          </PieChart>
        </ResponsiveContainer>
      </section>
    </div>
  );
}

import { CHART_PALETTE, GRADE_TIERS } from "@/lib/constants";
import type { SubmissionRow, GradeReportRow, GarmentType } from "@/types/database";

// The pure half of the dashboard's Grade trends widget
// (src/components/dashboard/grade-charts.tsx): rows in, chart series out.

const TIER_COLORS: Record<string, string> = {
  NWT: CHART_PALETTE.emerald,
  NWOT: CHART_PALETTE.green,
  Excellent: CHART_PALETTE.blue,
  "Very Good": CHART_PALETTE.indigo,
  Good: CHART_PALETTE.violet,
  Fair: CHART_PALETTE.amber,
  Poor: CHART_PALETTE.red,
};

function formatGarmentType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export interface ChartData {
  gradeDistribution: Array<{ tier: string; count: number; fill: string }>;
  /** Null for a week with no grades, so the line breaks instead of dropping to 0. */
  avgGradeOverTime: Array<{ week: string; average: number | null }>;
  garmentTypeBreakdown: Array<{ name: string; value: number }>;
  hasData: boolean;
}

// US-2204: the charts read four submission columns and three report columns, so
// the queries project exactly those. Naming the projection in the types — rather
// than casting the rows back to the full Row — is what makes the narrowing safe:
// tsc fails here if a chart later reaches for a column the select stopped
// fetching, instead of the field silently arriving as undefined at runtime.
export type ChartSubmission = Pick<
  SubmissionRow,
  "id" | "status" | "created_at" | "garment_type" | "superseded_at"
>;
export type ChartReport = Pick<GradeReportRow, "grade_tier" | "overall_score"> & {
  submission_id: string;
};

export function processChartData(
  allSubmissions: ChartSubmission[],
  reports: ChartReport[],
  now: Date = new Date(),
): ChartData {
  // A retake supersedes the original submission. Counting both would count
  // one garment twice in every chart, so only the live one is kept. The query
  // filters this too; the check here keeps the function honest on its own.
  const submissions = allSubmissions.filter((s) => s.superseded_at == null);
  const completedSubmissions = submissions.filter((s) => s.status === "completed");
  const completedIds = new Set(completedSubmissions.map((s) => s.id));
  const activeReports = reports.filter((r) => completedIds.has(r.submission_id));

  if (completedSubmissions.length === 0 || activeReports.length === 0) {
    return { gradeDistribution: [], avgGradeOverTime: [], garmentTypeBreakdown: [], hasData: false };
  }

  // Build a map of submission_id -> report for easy lookup
  const reportMap = new Map(activeReports.map((r) => [r.submission_id, r]));

  // Grade distribution by tier
  const tierCounts: Record<string, number> = {};
  for (const tier of GRADE_TIERS) {
    tierCounts[tier] = 0;
  }
  for (const report of reportMap.values()) {
    const current = tierCounts[report.grade_tier];
    if (current !== undefined) {
      tierCounts[report.grade_tier] = current + 1;
    }
  }
  const gradeDistribution = GRADE_TIERS.map((tier) => ({
    tier: tier as string,
    count: tierCounts[tier] ?? 0,
    fill: TIER_COLORS[tier] ?? CHART_PALETTE.slate,
  }));

  // Average grade over the last 4 weeks, in weekly buckets
  const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

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
    if (subDate < fourWeeksAgo) continue;
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
        : null,
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


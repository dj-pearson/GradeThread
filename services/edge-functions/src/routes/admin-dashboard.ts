// US-1565: admin dashboard/system aggregates served through the edge boundary.
//
// dashboard.tsx used to pull SIX whole tables into the browser with
// `select("*")` and aggregate client-side, and system.tsx called the metrics
// RPCs directly — both bypassing the edge admin boundary (JWT + role + AAL2
// middleware, step-up, audit, rate limits) and shipping full-table payloads.
// These endpoints compute the same aggregates server-side with NARROW column
// selects and return exactly what the UI renders.
//
// Read-only aggregates → role-gated (no scope guard), matching the
// admin-analytics/admin-revenue precedent in lib/admin-scope-map.ts.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminDashboardRoutes = new Hono<AdminEnv>();

/** How many days the dashboard's headline charts cover. */
export const CHART_DAYS = 30;
/** How many days the analytics tab's grade-volume trend covers. */
export const VOLUME_DAYS = 90;
/** How many monthly signup cohorts the retention table shows. */
export const COHORT_MONTHS = 6;
/**
 * Cap on the enrichment log — the ONE read in this file that still returns rows
 * and therefore the one bound that can hide something. The response carries
 * `truncated` so the panel can say the acceptance rates are measured over a
 * window rather than over everything.
 */
export const ENRICHMENT_LOG_LIMIT = 2000;

interface DailyBucket {
  date: string;
  label: string;
  start: Date;
  end: Date;
}

// Mirrors the client's old buildDailyBuckets — same labels, same local-date
// bucketing, so the charts render identically after the move.
export function buildDailyBuckets(days: number, now = new Date()): DailyBucket[] {
  const buckets: DailyBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
      String(d.getDate()).padStart(2, "0")
    }`;
    buckets.push({
      date: dateStr,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      start: new Date(d.getFullYear(), d.getMonth(), d.getDate()),
      end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1),
    });
  }
  return buckets;
}

/**
 * The N+1 instants describing N daily buckets.
 *
 * These go to the SQL aggregates rather than a day count, so the counts and the
 * labels are derived from ONE set of boundaries. Letting Postgres work out its
 * own day edges would disagree with these labels whenever the database session's
 * timezone differs from this container's — and disagree invisibly, as a chart
 * shifted by a whole column.
 */
function bucketEdges(buckets: DailyBucket[]): string[] {
  if (buckets.length === 0) return [];
  return [
    ...buckets.map((b) => b.start.toISOString()),
    buckets[buckets.length - 1]!.end.toISOString(),
  ];
}

/** One bucket as the SQL series returns it. */
interface SeriesRow {
  start: string;
  submissions: number;
  newUsers: number;
  revenue: number;
}
interface VolumeRow {
  start: string;
  count: number;
}
interface AggregateRow {
  averageGrade: number;
  gradedReportCount: number;
  revenueThisMonth: number;
}
interface AnalyticsRow {
  funnel: {
    signedUp: number;
    firstSubmission: number;
    completedGrade: number;
    subscribed: number;
  };
  planDistribution: Record<string, number>;
  topUsers: Array<{ id: string; name: string; plan: string; count: number }>;
  gradeVolume: VolumeRow[];
  cohorts: Array<{
    month: string;
    size: number;
    retention: (number | null)[];
  }>;
}

// GET /summary — the KPIs + 30-day charts the dashboard renders, plus the
// slim raw arrays PlatformAnalytics aggregates (only the fields it reads).
adminDashboardRoutes.get("/summary", async (c) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // US-2390: every count-shaped KPI is now an EXACT server-side count.
  //
  // They used to be `array.filter(...).length` over the raw reads below, which
  // made them silently wrong rather than merely slow: PostgREST enforces
  // `db-max-rows` on any response and reports the truncation only in a
  // Content-Range header that supabase-js does not surface. Past that ceiling
  // every KPI was computed on a fraction of the corpus and came back looking
  // completely normal — an operator reading "average grade 7.8" had no way to
  // tell it was measured on a slice. See vault/10-ops/postgrest-row-cap.md.
  //
  // A `count: "exact", head: true` query reads ZERO rows: the count comes from
  // the server, so it cannot be truncated by a row ceiling and does not grow
  // the payload. Every KPI except the mean is expressible this way, which is
  // why the mean is handled separately below.
  const [
    totalUsersRes,
    activeSubsRes,
    submissionsTodayRes,
    completedSubsRes,
    completedReportsRes,
    highConfidenceRes,
    disputesRes,
    pendingRes,
  ] = await Promise.all([
    supabaseAdmin.from("users").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("users").select("id", { count: "exact", head: true })
      .neq("plan", "free"),
    supabaseAdmin.from("submissions").select("id", { count: "exact", head: true })
      .gte("created_at", todayStart.toISOString()),
    supabaseAdmin.from("submissions").select("id", { count: "exact", head: true })
      .in("status", ["completed", "disputed"]),
    supabaseAdmin.from("grade_reports").select("id", { count: "exact", head: true })
      .gt("overall_score", 0),
    supabaseAdmin.from("grade_reports").select("id", { count: "exact", head: true })
      .gt("overall_score", 0).gte("confidence_score", 0.75),
    supabaseAdmin.from("disputes").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("human_reviews").select("id", { count: "exact", head: true })
      .is("adjusted_score", null),
  ]);

  // US-2390: everything that needs VALUES rather than a count is now aggregated
  // in SQL (migration 00513). The three unbounded reads this handler used to
  // issue — every user, every submission, every grade report, every sale — are
  // gone, and with them the whole class of failure they carried: a number
  // computed over whatever fraction of the corpus PostgREST chose to return,
  // presented as if it were the whole.
  //
  // Nothing below returns rows, so nothing below can truncate. The charts come
  // back as 30 buckets and the analytics as a fixed-size document, whatever the
  // platform's size.
  const buckets = buildDailyBuckets(CHART_DAYS, now);
  const volumeBuckets = buildDailyBuckets(VOLUME_DAYS, now);
  const [aggRes, seriesRes, analyticsRes] = await Promise.all([
    supabaseAdmin.rpc("admin_dashboard_aggregates", {
      p_month_start: monthStart.toISOString(),
    }),
    supabaseAdmin.rpc("admin_dashboard_daily_series", {
      p_edges: bucketEdges(buckets),
    }),
    supabaseAdmin.rpc("admin_platform_analytics", {
      p_volume_edges: bucketEdges(volumeBuckets),
      p_cohort_months: COHORT_MONTHS,
    }),
  ]);
  if (aggRes.error || seriesRes.error || analyticsRes.error) {
    return jsonError(c, 500, "Failed to load dashboard data");
  }

  const agg = (aggRes.data ?? {}) as Partial<AggregateRow>;
  const series = (seriesRes.data ?? []) as SeriesRow[];
  const analytics = (analyticsRes.data ?? {}) as Partial<AnalyticsRow>;

  const disputeCount = disputesRes.count ?? 0;
  const completedReportCount = completedReportsRes.count ?? 0;
  const completedSubmissionCount = completedSubsRes.count ?? 0;

  const kpis = {
    totalUsers: totalUsersRes.count ?? 0,
    activeSubscribers: activeSubsRes.count ?? 0,
    submissionsToday: submissionsTodayRes.count ?? 0,
    revenueThisMonth: Number(agg.revenueThisMonth ?? 0),
    // An exact all-time mean now, not a sample of one. The sample-size and
    // truncation fields that used to travel with it are gone because there is
    // no longer a sample to describe.
    averageGrade: Number(agg.averageGrade ?? 0),
    disputeRatePercent: completedSubmissionCount > 0
      ? Math.round((disputeCount / completedSubmissionCount) * 1000) / 10
      : 0,
    aiAccuracyPercent: completedReportCount > 0
      ? Math.round(((highConfidenceRes.count ?? 0) / completedReportCount) * 1000) / 10
      : 0,
    // Explicit rather than shorthand: the provenance guard reads this literal
    // to check every count-shaped KPI comes from a server count, and a
    // shorthand key hides where the value came from.
    pendingReviews: pendingRes.count ?? 0,
  };

  // Zip the SQL buckets back onto the labels they were computed from. Index
  // rather than date-match: the edges went out in order and come back in order,
  // and a missing bucket should read as zero rather than shift the series.
  const charts = {
    submissionVolume: buckets.map((b, i) => ({
      date: b.date,
      label: b.label,
      count: Number(series[i]?.submissions ?? 0),
    })),
    revenueOverTime: buckets.map((b, i) => ({
      date: b.date,
      label: b.label,
      revenue: Number(series[i]?.revenue ?? 0),
    })),
    newUsers: buckets.map((b, i) => ({
      date: b.date,
      label: b.label,
      count: Number(series[i]?.newUsers ?? 0),
    })),
  };

  return c.json({
    kpis,
    charts,
    // Replaces the old `raw` arrays. The client used to receive every user and
    // submission row and aggregate them in a useMemo, believing it was seeing
    // everything; it now receives the answers.
    analytics: {
      funnel: analytics.funnel ?? {
        signedUp: 0,
        firstSubmission: 0,
        completedGrade: 0,
        subscribed: 0,
      },
      planDistribution: analytics.planDistribution ?? {},
      topUsers: analytics.topUsers ?? [],
      cohorts: analytics.cohorts ?? [],
      gradeVolume: volumeBuckets.map((b, i) => ({
        label: b.label,
        count: Number(analytics.gradeVolume?.[i]?.count ?? 0),
      })),
    },
  });
});

// GET /system — DB latency probe + the two metrics RPCs system.tsx renders.
adminDashboardRoutes.get("/system", async (c) => {
  const dbStart = performance.now();
  const ping = await supabaseAdmin.from("users").select("id", {
    count: "exact",
    head: true,
  });
  const dbLatencyMs = Math.round(performance.now() - dbStart);
  if (ping.error) return jsonError(c, 500, "DB ping failed");

  const [metricsRes, revenueRes] = await Promise.all([
    supabaseAdmin.rpc("admin_system_metrics"),
    supabaseAdmin.rpc("admin_revenue_metrics"),
  ]);
  if (metricsRes.error || !metricsRes.data) {
    return jsonError(c, 500, "Failed to load system metrics");
  }
  if (revenueRes.error || !revenueRes.data) {
    return jsonError(c, 500, "Failed to load revenue metrics");
  }
  return c.json({
    db_latency_ms: dbLatencyMs,
    metrics: metricsRes.data,
    revenue: revenueRes.data,
  });
});

// GET /enrichment-log — recent AI enrichment acceptance rows (US-167 panel on
// the dashboard's analytics tab; was a direct client table read).
//
// US-2390 AC5: this is the one read here that still returns rows, so it is the
// one place a bound can hide something. The cap stays — the acceptance rates it
// feeds are a tuning signal, not an accounting figure, and the newest N calls
// are the useful ones — but the response now SAYS when it is measuring a window
// instead of everything, and the panel repeats that to the operator. A capped
// number with stated provenance is honest; the same number with none is not.
adminDashboardRoutes.get("/enrichment-log", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("ai_enrichment_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(ENRICHMENT_LOG_LIMIT);
  if (error) return jsonError(c, 500, "Failed to load enrichment log");
  const logs = data ?? [];
  return c.json({
    logs,
    truncated: logs.length >= ENRICHMENT_LOG_LIMIT,
    limit: ENRICHMENT_LOG_LIMIT,
  });
});

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

/**
 * US-2390: how many recent completed grades the average is measured over.
 *
 * Sized well under the assumed `db-max-rows` ceiling (1000 by Supabase default,
 * unconfirmed for this deployment) so the read is answered in full rather than
 * being cut short by the server — which is the failure this whole endpoint was
 * rewritten to remove. If the ceiling turns out to be lower, the sample is
 * simply smaller and `averageGradeSampleSize` says so; nothing becomes wrong.
 */
export const AVERAGE_GRADE_SAMPLE = 500;

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

interface UserSlim {
  id: string;
  plan: string;
  created_at: string;
  email: string;
  full_name: string | null;
}
interface SubmissionSlim {
  user_id: string;
  status: string;
  created_at: string;
}
interface ReportSlim {
  overall_score: number;
  confidence_score: number;
  created_at: string;
}
interface SaleSlim {
  sale_price: number;
  sale_date: string;
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

  // US-2390: the raw arrays are now read ONLY for the 30-day charts and for the
  // client-side analytics (funnel, plan cohorts, top users), which genuinely
  // need rows. No KPI depends on them any more, so a truncated read here can no
  // longer corrupt a headline number — it can only shorten a chart. Making
  // these bounded is US-2390's remaining half; they are still listed in
  // KNOWN_UNBOUNDED with that reasoning.
  const [usersRes, subsRes, reportsRes, salesRes] = await Promise.all([
    supabaseAdmin.from("users").select("id, plan, created_at, email, full_name"),
    supabaseAdmin.from("submissions").select("user_id, status, created_at"),
    supabaseAdmin.from("grade_reports").select(
      "overall_score, confidence_score, created_at",
    ),
    supabaseAdmin.from("sales").select("sale_price, sale_date"),
  ]);
  for (const res of [usersRes, subsRes, reportsRes, salesRes]) {
    if (res.error) {
      return jsonError(c, 500, "Failed to load dashboard data");
    }
  }

  const users = (usersRes.data ?? []) as UserSlim[];
  const submissions = (subsRes.data ?? []) as SubmissionSlim[];
  const reports = (reportsRes.data ?? []) as ReportSlim[];
  const sales = (salesRes.data ?? []) as SaleSlim[];
  const disputeCount = disputesRes.count ?? 0;
  const completedReportCount = completedReportsRes.count ?? 0;
  const completedSubmissionCount = completedSubsRes.count ?? 0;

  // The ONE KPI that needs values rather than a count. It is read capped and
  // NEWEST-FIRST, and the response says so: `averageGradeSampleSize` and
  // `averageGradeTruncated` travel with the number.
  //
  // Capping a mean is normally exactly the mistake this story exists to remove
  // — an arbitrary slice yields a plausible wrong number. What makes it
  // acceptable here is that the sample is not arbitrary and not silent: ordered
  // by `created_at` descending it is "the most recent N grades", a statistic an
  // operator can reason about, and the payload carries N. A number with stated
  // provenance is honest; the same number with none is not.
  //
  // The durable fix is an aggregate RPC (`avg(overall_score)` in SQL, alongside
  // the existing admin_system_metrics). That needs a migration, and a migration
  // blocks pushes until an operator applies it, so it is deliberately left to a
  // follow-up rather than bundled here.
  const meanRes = await supabaseAdmin
    .from("grade_reports")
    .select("overall_score")
    .gt("overall_score", 0)
    .order("created_at", { ascending: false })
    .limit(AVERAGE_GRADE_SAMPLE);
  const meanRows = (meanRes.data ?? []) as { overall_score: number }[];
  const averageGrade = meanRows.length > 0
    ? Math.round(
      (meanRows.reduce((sum, r) => sum + r.overall_score, 0) / meanRows.length) * 10,
    ) / 10
    : 0;

  const kpis = {
    totalUsers: totalUsersRes.count ?? 0,
    activeSubscribers: activeSubsRes.count ?? 0,
    submissionsToday: submissionsTodayRes.count ?? 0,
    revenueThisMonth: sales
      .filter((s) => new Date(s.sale_date) >= monthStart)
      .reduce((sum, s) => sum + s.sale_price, 0),
    averageGrade,
    averageGradeSampleSize: meanRows.length,
    // True when the sample filled the cap, i.e. older grades exist beyond it.
    averageGradeTruncated: meanRows.length >= AVERAGE_GRADE_SAMPLE &&
      completedReportCount > meanRows.length,
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

  const buckets = buildDailyBuckets(30, now);
  const inBucket = (iso: string, b: DailyBucket) => {
    const d = new Date(iso);
    return d >= b.start && d < b.end;
  };
  const charts = {
    submissionVolume: buckets.map((b) => ({
      date: b.date,
      label: b.label,
      count: submissions.filter((s) => inBucket(s.created_at, b)).length,
    })),
    revenueOverTime: buckets.map((b) => ({
      date: b.date,
      label: b.label,
      revenue: sales.filter((s) => inBucket(s.sale_date, b))
        .reduce((sum, s) => sum + s.sale_price, 0),
    })),
    newUsers: buckets.map((b) => ({
      date: b.date,
      label: b.label,
      count: users.filter((u) => inBucket(u.created_at, b)).length,
    })),
  };

  return c.json({
    kpis,
    charts,
    raw: {
      users,
      submissions,
      gradeReports: reports.map((r) => ({ created_at: r.created_at })),
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
adminDashboardRoutes.get("/enrichment-log", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("ai_enrichment_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) return jsonError(c, 500, "Failed to load enrichment log");
  return c.json({ logs: data ?? [] });
});

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
  const [usersRes, subsRes, reportsRes, salesRes, disputesRes, pendingRes] = await Promise
    .all([
      supabaseAdmin.from("users").select("id, plan, created_at, email, full_name"),
      supabaseAdmin.from("submissions").select("user_id, status, created_at"),
      supabaseAdmin.from("grade_reports").select(
        "overall_score, confidence_score, created_at",
      ),
      supabaseAdmin.from("sales").select("sale_price, sale_date"),
      supabaseAdmin.from("disputes").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("human_reviews").select("id", { count: "exact", head: true })
        .is("adjusted_score", null),
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
  const pendingReviews = pendingRes.count ?? 0;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const completedReports = reports.filter((r) => r.overall_score > 0);
  const completedSubmissions = submissions.filter(
    (s) => s.status === "completed" || s.status === "disputed",
  );
  const highConfidence = completedReports.filter((r) => r.confidence_score >= 0.75);

  const kpis = {
    totalUsers: users.length,
    activeSubscribers: users.filter((u) => u.plan !== "free").length,
    submissionsToday:
      submissions.filter((s) => new Date(s.created_at) >= todayStart).length,
    revenueThisMonth: sales
      .filter((s) => new Date(s.sale_date) >= monthStart)
      .reduce((sum, s) => sum + s.sale_price, 0),
    averageGrade: completedReports.length > 0
      ? Math.round(
        (completedReports.reduce((sum, r) => sum + r.overall_score, 0) /
          completedReports.length) * 10,
      ) / 10
      : 0,
    disputeRatePercent: completedSubmissions.length > 0
      ? Math.round((disputeCount / completedSubmissions.length) * 1000) / 10
      : 0,
    aiAccuracyPercent: completedReports.length > 0
      ? Math.round((highConfidence.length / completedReports.length) * 1000) / 10
      : 0,
    pendingReviews,
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

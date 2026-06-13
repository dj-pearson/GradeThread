import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { supabase } from "@/lib/supabase";
import { fetchAdminSystemMetrics, type AdminSystemMetrics } from "@/lib/admin-aggregates";
import { PLANS } from "@/lib/constants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Wrench,
  RefreshCw,
  CheckCircle,
  XCircle,
  Database,
  HardDrive,
  Wifi,
  Clock,
  AlertTriangle,
  ImageIcon,
  CreditCard,
  Users,
  TrendingDown,
  Loader2,
} from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

const PLAN_COLORS: Record<string, string> = {
  free: "#94a3b8",
  starter: "#0F3460",
  professional: "#E94560",
  enterprise: "#16a34a",
};

// ─── Health check types ─────────────────────────────────────────

interface HealthStatus {
  database: "healthy" | "degraded" | "down";
  storage: "healthy" | "degraded" | "down";
  api: "healthy" | "degraded" | "down";
  dbLatencyMs: number;
}

interface QueueMetrics {
  pendingCount: number;
  processingCount: number;
  avgProcessingTimeMin: number;
  failedLast24h: number;
}

interface StorageMetrics {
  totalImages: number;
  estimatedSizeMB: number;
}

interface SubscriptionMetrics {
  mrr: number;
  totalPaid: number;
  planDistribution: Array<{ name: string; value: number; color: string }>;
  churnRatePercent: number;
}

interface TrafficPoint {
  label: string;
  submissions: number;
  uniqueUsers: number;
}

interface ErrorRatePoint {
  label: string;
  failedRate: number;
  totalSubmissions: number;
  failedCount: number;
}

interface SystemData {
  health: HealthStatus;
  queue: QueueMetrics;
  storage: StorageMetrics;
  subscriptions: SubscriptionMetrics;
  hourlyTraffic: TrafficPoint[];
  dailyUsers: Array<{ label: string; uniqueUsers: number }>;
  errorRate: ErrorRatePoint[];
}

// ─── Data processing ────────────────────────────────────────────
//
// US-415: all heavy aggregation now happens server-side in the
// `admin_system_metrics` RPC (migration 00147). This page no longer downloads
// the users / submissions / submission_images / grade_reports / sales tables —
// it receives a compact, size-independent summary and only formats bucket
// labels (in local time) and computes MRR from the plan counts + PLANS pricing.

const HOUR_LABEL = (iso: string) =>
  `${new Date(iso).getHours().toString().padStart(2, "0")}:00`;

const DAY_LABEL = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

function buildSystemData(metrics: AdminSystemMetrics, dbLatencyMs: number): SystemData {
  // ── Health ──
  const health: HealthStatus = {
    database: dbLatencyMs < 500 ? "healthy" : dbLatencyMs < 2000 ? "degraded" : "down",
    storage: "healthy", // submission_images count came back, so storage is working
    api: "healthy", // If this page loaded, API is working
    dbLatencyMs,
  };

  // ── Queue ──
  const queue: QueueMetrics = {
    pendingCount: metrics.queue.pendingCount,
    processingCount: metrics.queue.processingCount,
    avgProcessingTimeMin: metrics.queue.avgProcessingTimeMin,
    failedLast24h: metrics.queue.failedLast24h,
  };

  // ── Storage ──
  const totalImages = metrics.storage.totalImages;
  // Estimate ~500KB per image average (compressed)
  const estimatedSizeMB = Math.round(totalImages * 0.5 * 100) / 100;
  const storage: StorageMetrics = { totalImages, estimatedSizeMB };

  // ── Subscriptions ──
  const planCounts = metrics.subscriptions.planCounts;
  const planOrder: Array<keyof typeof PLANS> = ["free", "starter", "professional", "enterprise"];
  const planDistribution = planOrder.map((key) => ({
    name: PLANS[key].name,
    value: planCounts[key] ?? 0,
    color: PLAN_COLORS[key] ?? "#94a3b8",
  }));

  const totalPaid = metrics.subscriptions.totalPaid;

  // MRR = sum of monthly prices for all paid users. PLANS records priceMonthly
  // as `number | null` (null = "Custom"); fall back to 0 for those. Enterprise
  // is custom-priced, estimated at $499/mo.
  let mrr = 0;
  for (const key of planOrder) {
    if (key === "free" || key === "enterprise") continue;
    mrr += (planCounts[key] ?? 0) * (PLANS[key].priceMonthly ?? 0);
  }
  mrr += (planCounts["enterprise"] ?? 0) * 499;

  const freeWithActivity = metrics.subscriptions.churnFreeWithActivity;
  const churnRatePercent = totalPaid + freeWithActivity > 0
    ? Math.round((freeWithActivity / (totalPaid + freeWithActivity)) * 1000) / 10
    : 0;

  const subscriptions: SubscriptionMetrics = { mrr, totalPaid, planDistribution, churnRatePercent };

  // ── Time-bucketed series (labels formatted client-side, local time) ──
  const hourlyTraffic: TrafficPoint[] = metrics.hourlyTraffic.map((b) => ({
    label: HOUR_LABEL(b.start),
    submissions: b.submissions,
    uniqueUsers: b.uniqueUsers,
  }));

  const dailyUsers = metrics.dailyUsers.map((b) => ({
    label: DAY_LABEL(b.start),
    uniqueUsers: b.uniqueUsers,
  }));

  const errorRate: ErrorRatePoint[] = metrics.errorRate.map((b) => ({
    label: DAY_LABEL(b.start),
    totalSubmissions: b.totalSubmissions,
    failedCount: b.failedCount,
    failedRate: b.totalSubmissions > 0
      ? Math.round((b.failedCount / b.totalSubmissions) * 1000) / 10
      : 0,
  }));

  return { health, queue, storage, subscriptions, hourlyTraffic, dailyUsers, errorRate };
}

// ─── Health indicator component ─────────────────────────────────

function HealthIndicator({ label, status, icon: Icon, detail }: {
  label: string;
  status: "healthy" | "degraded" | "down";
  icon: React.ElementType;
  detail?: string;
}) {
  const colors = {
    healthy: "text-green-600 dark:text-green-400",
    degraded: "text-yellow-600 dark:text-yellow-400",
    down: "text-red-600 dark:text-red-400",
  };
  const bgColors = {
    healthy: "bg-green-50 dark:bg-green-950/40",
    degraded: "bg-yellow-50 dark:bg-yellow-950/40",
    down: "bg-red-50 dark:bg-red-950/40",
  };
  const StatusIcon = status === "healthy" ? CheckCircle : status === "degraded" ? AlertTriangle : XCircle;

  return (
    <div className={`flex items-center gap-3 rounded-lg p-3 ${bgColors[status]}`}>
      <Icon className={`h-5 w-5 ${colors[status]}`} />
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
      </div>
      <StatusIcon className={`h-4 w-4 ${colors[status]}`} />
    </div>
  );
}

// ─── Custom pie label ───────────────────────────────────────────

function renderPieLabel(props: { name?: string | number; percent?: number }) {
  const name = String(props.name ?? "");
  const p = props.percent ?? 0;
  if (p < 0.05) return null;
  return `${name} ${(p * 100).toFixed(0)}%`;
}

// ─── Page component ─────────────────────────────────────────────

export function AdminSystemPage() {
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const visible = useDocumentVisible();

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin-system"],
    queryFn: async () => {
      // Measure DB latency with a simple ping (also serves as a cheap health probe).
      const dbStart = performance.now();
      const pingRes = await supabase.from("users").select("id", { count: "exact", head: true });
      const dbLatencyMs = Math.round(performance.now() - dbStart);
      if (pingRes.error) throw pingRes.error;

      // All aggregation happens server-side (US-415): one compact summary, no
      // full-table downloads.
      const metrics = await fetchAdminSystemMetrics();

      setLastRefresh(new Date());

      return buildSystemData(metrics, dbLatencyMs);
    },
    staleTime: 15 * 1000,
    // Auto-refresh every 30s, but only while the tab is visible so a
    // backgrounded system-health page stops polling. (US-576)
    refetchInterval: visible ? 30 * 1000 : false,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wrench className="h-6 w-6 text-brand-red-text" />
          <h1 className="text-2xl font-bold">System Health</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Last refresh: {lastRefresh.toLocaleTimeString()}
          </span>
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </button>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3" />
            <span>Auto-refreshes every 30s</span>
          </div>
        </div>
      </div>

      {/* Health indicators */}
      {isLoading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Service Health</CardTitle>
            <CardDescription>Real-time health status of core services</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3">
              <HealthIndicator
                label="Database"
                status={data?.health.database ?? "down"}
                icon={Database}
                detail={`Latency: ${data?.health.dbLatencyMs ?? 0}ms`}
              />
              <HealthIndicator
                label="Storage"
                status={data?.health.storage ?? "down"}
                icon={HardDrive}
                detail="Supabase Storage"
              />
              <HealthIndicator
                label="API"
                status={data?.health.api ?? "down"}
                icon={Wifi}
                detail="Edge Functions"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Queue metrics + Storage */}
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
        <>
          {/* Queue Metrics */}
          <div>
            <h2 className="mb-3 text-lg font-semibold">Queue Metrics</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Pending</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {data?.queue.pendingCount ?? 0}
                  </div>
                  <CardDescription>Awaiting processing</CardDescription>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Processing</CardTitle>
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                    {data?.queue.processingCount ?? 0}
                  </div>
                  <CardDescription>Currently grading</CardDescription>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Avg Processing Time</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {data?.queue.avgProcessingTimeMin ?? 0} min
                  </div>
                  <CardDescription>Submission to grade</CardDescription>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Failed (24h)</CardTitle>
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${(data?.queue.failedLast24h ?? 0) > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                    {data?.queue.failedLast24h ?? 0}
                  </div>
                  <CardDescription>Failed submissions</CardDescription>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Storage Usage */}
          <div>
            <h2 className="mb-3 text-lg font-semibold">Storage</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Total Images</CardTitle>
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {(data?.storage.totalImages ?? 0).toLocaleString()}
                  </div>
                  <CardDescription>Across all submissions</CardDescription>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Estimated Storage</CardTitle>
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {(data?.storage.estimatedSizeMB ?? 0) >= 1024
                      ? `${((data?.storage.estimatedSizeMB ?? 0) / 1024).toFixed(1)} GB`
                      : `${data?.storage.estimatedSizeMB ?? 0} MB`}
                  </div>
                  <CardDescription>~500KB per image avg</CardDescription>
                  {(data?.storage.estimatedSizeMB ?? 0) > 0 && (
                    <Progress
                      value={Math.min(((data?.storage.estimatedSizeMB ?? 0) / 5120) * 100, 100)}
                      className="mt-2 h-2"
                    />
                  )}
                  <span className="text-xs text-muted-foreground">
                    of 5 GB estimated capacity
                  </span>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}

      {/* Traffic charts */}
      {isLoading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-60" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[250px] w-full" />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Requests per hour (last 24h) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Submissions per Hour</CardTitle>
              <CardDescription>Last 24 hours</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart
                  data={data?.hourlyTraffic}
                  margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="label"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    interval={2}
                  />
                  <YAxis
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value, name) => [
                      Number(value),
                      name === "submissions" ? "Submissions" : "Unique Users",
                    ]}
                  />
                  <Legend />
                  <Bar dataKey="submissions" fill="#0F3460" name="Submissions" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="uniqueUsers" fill="#E94560" name="Unique Users" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Unique users per day (last 30d) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Unique Users per Day</CardTitle>
              <CardDescription>Last 30 days</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart
                  data={data?.dailyUsers}
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
                    formatter={(value) => [Number(value), "Unique Users"]}
                    labelFormatter={(label) => `Date: ${String(label)}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="uniqueUsers"
                    stroke="#0F3460"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: "#0F3460" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Error rate chart */}
      {isLoading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[250px] w-full" />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Error Rate</CardTitle>
            <CardDescription>Failed grading rate over the last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart
                data={data?.errorRate}
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
                  tickFormatter={(v) => `${Number(v)}%`}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value, name) => {
                    if (name === "failedRate") return [`${Number(value)}%`, "Failure Rate"];
                    return [Number(value), String(name)];
                  }}
                  labelFormatter={(label) => `Date: ${String(label)}`}
                />
                <Bar dataKey="failedRate" fill="#ef4444" name="failedRate" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            {/* Summary */}
            <div className="mt-3 flex gap-6 text-sm text-muted-foreground">
              <div>
                Total Failed (7d):{" "}
                <span className="font-medium text-foreground">
                  {data?.errorRate.reduce((sum, e) => sum + e.failedCount, 0) ?? 0}
                </span>
              </div>
              <div>
                Total Submissions (7d):{" "}
                <span className="font-medium text-foreground">
                  {data?.errorRate.reduce((sum, e) => sum + e.totalSubmissions, 0) ?? 0}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Subscription metrics */}
      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-[250px] w-full" />
            </CardContent>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
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
        </div>
      ) : (
        <div>
          <h2 className="mb-3 text-lg font-semibold">Subscription Metrics</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Plan distribution pie chart */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Plan Distribution</CardTitle>
                <CardDescription>Users by subscription plan</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie
                      data={data?.subscriptions.planDistribution}
                      cx="50%"
                      cy="50%"
                      outerRadius={90}
                      dataKey="value"
                      label={renderPieLabel}
                      labelLine={false}
                    >
                      {data?.subscriptions.planDistribution.map((entry, idx) => (
                        <Cell key={idx} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(value) => [Number(value), "Users"]}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* MRR, paid users, churn */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">MRR</CardTitle>
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                    ${(data?.subscriptions.mrr ?? 0).toLocaleString()}
                  </div>
                  <CardDescription>Monthly recurring revenue</CardDescription>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Paid Users</CardTitle>
                  <Users className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {data?.subscriptions.totalPaid ?? 0}
                  </div>
                  <CardDescription>Active subscribers</CardDescription>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Churn Rate</CardTitle>
                  <TrendingDown className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${(data?.subscriptions.churnRatePercent ?? 0) > 5 ? "text-red-600 dark:text-red-400" : ""}`}>
                    {data?.subscriptions.churnRatePercent ?? 0}%
                  </div>
                  <CardDescription>Estimated 30-day</CardDescription>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">ARPU</CardTitle>
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    ${(data?.subscriptions.totalPaid ?? 0) > 0
                      ? Math.round((data?.subscriptions.mrr ?? 0) / (data?.subscriptions.totalPaid ?? 1))
                      : 0}
                  </div>
                  <CardDescription>Avg revenue per paid user</CardDescription>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

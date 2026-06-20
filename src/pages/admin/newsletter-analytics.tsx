import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  MailCheck,
  Users,
  Percent,
  MousePointerClick,
  TrendingUp,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  Info,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// ── API payload types (mirror the newsletter_analytics RPC, migration 00278) ──

interface NewsletterIssue {
  id: string;
  name: string;
  subject: string;
  sentAt: string | null;
  sent: number;
  opened: number;
  clicked: number;
  failed: number;
  skipped: number;
  openRate: number;
  ctr: number;
  bounceRate: number;
}

interface NewsletterProgram {
  issuesSent: number;
  sent: number;
  opened: number;
  clicked: number;
  failed: number;
  skipped: number;
  openRate: number;
  ctr: number;
  clickToOpenRate: number;
  bounces: number;
  complaints: number;
  bounceRate: number;
  complaintRate: number;
  unsubscribed: number;
  unsubRate: number;
  listSize: number;
  confirmedSubscribers: number;
  pendingSubscribers: number;
  newSubscribers: number;
  netGrowth: number;
  clickedThenGraded: number;
}

interface DeliverabilityFlag {
  metric: "complaintRate" | "bounceRate" | "unsubRate" | "openRate";
  severity: "warning" | "critical";
  value: number;
  threshold: number;
  message: string;
}

interface NewsletterResponse {
  period: string;
  window: { start: string; end: string };
  analytics: {
    period: string;
    window: { start: string; end: string };
    program: NewsletterProgram;
    issues: NewsletterIssue[];
  };
  deliverability: {
    status: "ok" | "warning" | "critical";
    shouldAutoPause: boolean;
    flags: DeliverabilityFlag[];
  };
  sendPaused: boolean;
}

type PeriodKey = "7d" | "30d" | "90d" | "180d" | "365d";

const PERIOD_LABELS: Array<{ key: PeriodKey; label: string }> = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "180d", label: "180 days" },
  { key: "365d", label: "365 days" },
];

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};

const pct = (ratio: number | null | undefined, digits = 1) =>
  ratio == null ? "—" : `${(ratio * 100).toFixed(digits)}%`;

const ISSUE_LABEL = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

function KpiCard({
  title,
  value,
  icon: Icon,
  description,
  valueClass,
}: {
  title: string;
  value: string;
  icon: React.ElementType;
  description?: string;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${valueClass ?? ""}`}>{value}</div>
        {description && <CardDescription>{description}</CardDescription>}
      </CardContent>
    </Card>
  );
}

export function AdminNewsletterAnalyticsPage() {
  const [period, setPeriod] = useState<PeriodKey>("90d");

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["admin-newsletter-analytics", period],
    queryFn: async (): Promise<NewsletterResponse> => {
      const res = await edgeFetch(`/api/admin/newsletter/analytics?period=${period}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to load newsletter analytics");
      }
      return json as NewsletterResponse;
    },
    staleTime: 60 * 1000,
  });

  const p = data?.analytics.program;
  const flags = data?.deliverability.flags ?? [];

  // Per-issue engagement: sent → opened → clicked.
  const issueSeries = useMemo(
    () =>
      (data?.analytics.issues ?? [])
        .slice()
        .reverse()
        .map((i) => ({
          label: ISSUE_LABEL(i.sentAt),
          sent: i.sent,
          opened: i.opened,
          clicked: i.clicked,
        })),
    [data],
  );

  return (
    <div className="space-y-6">
      {/* Header + period selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <MailCheck className="h-6 w-6 text-brand-red-text" />
          <div>
            <h1 className="text-2xl font-bold">Newsletter Health</h1>
            <p className="text-sm text-muted-foreground">
              Opens, clicks, bounces, complaints, unsubscribes, and list growth.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PERIOD_LABELS.map((pl) => (
            <Button
              key={pl.key}
              size="sm"
              variant={period === pl.key ? "default" : "outline"}
              onClick={() => setPeriod(pl.key)}
            >
              {pl.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Definitions note (AC6) */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <p>
          Numbers reconcile with the <strong>campaign_recipients</strong> ledger:
          open/CTR are opened/clicked over sent; bounce &amp; complaint rates use
          the SES suppression feed over sent; list size is confirmed subscribers,
          growth is confirmations minus unsubscribes in-window. Read-only and
          server-aggregated — it complements PostHog rather than duplicating it.
        </p>
      </div>

      {/* Send-paused banner */}
      {data?.sendPaused && (
        <div className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <ShieldAlert className="h-4 w-4 flex-shrink-0" />
          <span>
            Newsletter sending is currently <strong>paused</strong> (deliverability
            kill-switch). Clear it from the Settings Registry once the list is
            healthy.
          </span>
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-red-600 dark:text-red-400">
            {error instanceof Error
              ? error.message
              : "Failed to load newsletter analytics"}
          </CardContent>
        </Card>
      )}

      {/* KPI cards */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : p ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            title="Open Rate"
            value={pct(p.openRate)}
            icon={Percent}
            description={`${p.opened.toLocaleString()} / ${p.sent.toLocaleString()} sent`}
            valueClass="text-green-600 dark:text-green-400"
          />
          <KpiCard
            title="Click Rate"
            value={pct(p.ctr)}
            icon={MousePointerClick}
            description={`${pct(p.clickToOpenRate)} click-to-open`}
          />
          <KpiCard
            title="List Size"
            value={p.listSize.toLocaleString()}
            icon={Users}
            description={`${p.confirmedSubscribers.toLocaleString()} confirmed`}
          />
          <KpiCard
            title="Net Growth"
            value={`${p.netGrowth >= 0 ? "+" : ""}${p.netGrowth.toLocaleString()}`}
            icon={TrendingUp}
            description={`+${p.newSubscribers.toLocaleString()} new · −${p.unsubscribed.toLocaleString()} unsub`}
            valueClass={
              p.netGrowth >= 0
                ? "text-green-600 dark:text-green-400"
                : "text-red-600 dark:text-red-400"
            }
          />
        </div>
      ) : null}

      {/* Closed-loop product impact (AC3): clicked → graded */}
      {!isLoading && p && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <MousePointerClick className="h-4 w-4 flex-shrink-0 text-brand-red-text" />
          <span>
            <strong className="text-foreground">
              {p.clickedThenGraded.toLocaleString()}
            </strong>{" "}
            reader{p.clickedThenGraded === 1 ? "" : "s"} who clicked a newsletter
            went on to grade a garment in this window — newsletter engagement tied
            back to a product outcome (reuses the click closed-loop signal).
          </span>
        </div>
      )}

      {/* Deliverability flags (AC2 + AC4) */}
      {!isLoading && p && (
        <Card
          className={
            flags.some((f) => f.severity === "critical")
              ? "border-red-300 dark:border-red-800"
              : flags.length > 0
              ? "border-amber-300 dark:border-amber-800"
              : ""
          }
        >
          <CardHeader className="flex flex-row items-center gap-2 pb-2">
            {flags.length > 0 ? (
              <AlertTriangle
                className={`h-4 w-4 ${
                  flags.some((f) => f.severity === "critical")
                    ? "text-red-500"
                    : "text-amber-500"
                }`}
              />
            ) : (
              <MailCheck className="h-4 w-4 text-green-500" />
            )}
            <CardTitle className="text-base">Deliverability</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">Bounce rate</p>
                <p className="text-lg font-bold">{pct(p.bounceRate, 2)}</p>
                <p className="text-xs text-muted-foreground">
                  {p.bounces.toLocaleString()} suppressed
                </p>
              </div>
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">Complaint rate</p>
                <p className="text-lg font-bold">{pct(p.complaintRate, 2)}</p>
                <p className="text-xs text-muted-foreground">
                  {p.complaints.toLocaleString()} reported
                </p>
              </div>
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">Unsub rate</p>
                <p className="text-lg font-bold">{pct(p.unsubRate, 2)}</p>
                <p className="text-xs text-muted-foreground">
                  {p.unsubscribed.toLocaleString()} left
                </p>
              </div>
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">Issues sent</p>
                <p className="text-lg font-bold">{p.issuesSent.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">
                  {p.failed.toLocaleString()} failed
                </p>
              </div>
            </div>

            {flags.length === 0 ? (
              <p className="text-muted-foreground">
                All deliverability metrics are within healthy thresholds.
              </p>
            ) : (
              <div className="space-y-1.5">
                {flags.map((f) => (
                  <div
                    key={f.metric}
                    className={`flex items-start gap-2 rounded-md px-3 py-1.5 ${
                      f.severity === "critical"
                        ? "bg-red-50 dark:bg-red-950/40"
                        : "bg-amber-50 dark:bg-amber-950/40"
                    }`}
                  >
                    <AlertTriangle
                      className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${
                        f.severity === "critical"
                          ? "text-red-500"
                          : "text-amber-500"
                      }`}
                    />
                    <span>{f.message}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Per-issue engagement */}
      {isLoading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[280px] w-full" />
          </CardContent>
        </Card>
      ) : p ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Engagement by Issue</CardTitle>
            <CardDescription>Sent → opened → clicked, per issue</CardDescription>
          </CardHeader>
          <CardContent>
            {issueSeries.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                No newsletter issues sent in this period yet.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={issueSeries}
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
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend />
                  <Bar dataKey="sent" fill="#0F3460" name="Sent" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="opened" fill="#3b82f6" name="Opened" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="clicked" fill="#16a34a" name="Clicked" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Per-issue table */}
      {!isLoading && p && data && data.analytics.issues.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Issues</CardTitle>
            <CardDescription>Per-issue open rate, CTR, and bounces</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Issue</th>
                    <th className="py-2 pr-3 font-medium">Sent</th>
                    <th className="py-2 pr-3 font-medium">Open</th>
                    <th className="py-2 pr-3 font-medium">CTR</th>
                    <th className="py-2 font-medium">Bounce</th>
                  </tr>
                </thead>
                <tbody>
                  {data.analytics.issues.map((i) => (
                    <tr key={i.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{i.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {ISSUE_LABEL(i.sentAt)} · {i.subject}
                        </div>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {i.sent.toLocaleString()}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{pct(i.openRate)}</td>
                      <td className="py-2 pr-3 tabular-nums">{pct(i.ctr)}</td>
                      <td className="py-2 tabular-nums">{pct(i.bounceRate, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

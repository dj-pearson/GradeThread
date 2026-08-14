import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { edgeFetch } from "@/lib/edge-fetch";
import { CHART_PALETTE } from "@/lib/constants";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  Megaphone,
  Send,
  MailOpen,
  MousePointerClick,
  Users,
  Gift,
  Layers,
  Bell,
  BadgeCheck,
} from "lucide-react";

interface GrowthSummary {
  window_days: number;
  campaigns: {
    total: number;
    sent: number;
    recipients_sent: number;
    opened: number;
    clicked: number;
  };
  announcements: { active: number; dismissals: number };
  referrals: { codes: number; pending: number; granted: number };
}

function pct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Send;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function GrowthDashboardPage() {
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["growth-summary"],
    queryFn: async (): Promise<GrowthSummary> => {
      const res = await edgeFetch("/api/admin/growth/summary?days=30");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load growth summary");
      return json;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: ts } = useQuery({
    queryKey: ["growth-timeseries"],
    queryFn: async (): Promise<{ series: { date: string; delivered: number; dismissals: number }[] }> => {
      const res = await edgeFetch("/api/admin/growth/timeseries?days=30");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load time series");
      return json;
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  // US-1760: platform-wide badge funnel.
  const { data: badge } = useQuery({
    queryKey: ["growth-badge-funnel"],
    queryFn: async (): Promise<{
      totalClicks: number;
      conversions: number;
      activeSellers: number;
      clicksBySource: Record<string, number>;
    }> => {
      const res = await edgeFetch("/api/admin/growth/badge-funnel");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load badge funnel");
      return json;
    },
    staleTime: 60_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Megaphone}
        title="Growth"
        subtitle={
          <>
            Promote the platform — segment your audience, broadcast across email,
            in-app, and push, and run announcements. Last 30 days.
          </>
        }
        actions={
          <div className="flex gap-2 text-sm">
            <Link to="/admin/growth/segments" className="text-brand-red-text hover:underline">Segments</Link>
            <span className="text-muted-foreground">·</span>
            <Link to="/admin/growth/campaigns" className="text-brand-red-text hover:underline">Campaigns</Link>
            <span className="text-muted-foreground">·</span>
            <Link to="/admin/growth/announcements" className="text-brand-red-text hover:underline">Announcements</Link>
          </div>
        }
      />

      {/* US-2507: isError first. An errored query leaves `data` undefined, so
          `isLoading || !data` would otherwise render the skeleton forever. */}
      {isError ? (
        <ErrorState
          title="Couldn't load the growth summary"
          description="The numbers are still being tracked — we just couldn't fetch them right now."
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Campaigns
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat icon={Send} label="Campaigns sent" value={data.campaigns.sent} hint={`${data.campaigns.total} created`} />
              <Stat icon={Users} label="Messages delivered" value={data.campaigns.recipients_sent} />
              <Stat
                icon={MailOpen}
                label="Opened"
                value={data.campaigns.opened}
                hint={`${pct(data.campaigns.opened, data.campaigns.recipients_sent)} open rate`}
              />
              <Stat
                icon={MousePointerClick}
                label="Clicked"
                value={data.campaigns.clicked}
                hint={`${pct(data.campaigns.clicked, data.campaigns.recipients_sent)} CTR`}
              />
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Announcements & Referrals
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat icon={Bell} label="Active announcements" value={data.announcements.active} />
              <Stat icon={Layers} label="Dismissals" value={data.announcements.dismissals} />
              <Stat icon={Gift} label="Referral codes" value={data.referrals.codes} />
              <Stat
                icon={Gift}
                label="Rewards granted"
                value={data.referrals.granted}
                hint={`${data.referrals.pending} pending`}
              />
            </div>
          </div>

          {ts && ts.series.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Engagement — last 30 days</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={ts.series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(d: string) => d.slice(5)}
                      fontSize={11}
                      stroke="currentColor"
                      className="text-muted-foreground"
                    />
                    <YAxis allowDecimals={false} fontSize={11} stroke="currentColor" className="text-muted-foreground" />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="delivered"
                      name="Messages delivered"
                      stroke={CHART_PALETTE.navy}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="dismissals"
                      name="Announcement dismissals"
                      stroke={CHART_PALETTE.red}
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {badge && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Badge funnel — last 30 days</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4">
                  <Stat icon={BadgeCheck} label="Badge clicks" value={badge.totalClicks} />
                  <Stat icon={Gift} label="Referred signups" value={badge.conversions} />
                  <Stat icon={Megaphone} label="Active sellers" value={badge.activeSellers} />
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

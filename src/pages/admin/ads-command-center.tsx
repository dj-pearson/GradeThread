// US-1699: Ads Command Center — account/campaign performance from the synced
// ads_* snapshots (never Google Ads directly; reads GET /api/admin/ads/overview
// via TanStack Query). Lazy-loaded from the admin Ads page so recharts stays out
// of the base admin bundle. Super-admin gated at the route + edge layers.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { edgeFetch } from "@/lib/edge-fetch";
import { AlertTriangle, RefreshCw, TrendingUp } from "lucide-react";

interface Kpis {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  ctr: number;
  cpc: number;
  cpa: number;
  roas: number;
}
interface CampaignPerf extends Kpis {
  id: string;
  name: string;
  status: string | null;
}
interface DailyPoint {
  date: string;
  spend: number;
  clicks: number;
  conversions: number;
  cpa: number;
}
interface OverviewResponse {
  configured: boolean;
  tablesReady: boolean;
  account: {
    external_customer_id: string;
    descriptive_name: string | null;
    currency_code: string | null;
    time_zone: string | null;
  } | null;
  lastSync: {
    status: string;
    started_at: string;
    finished_at: string | null;
    counts: Record<string, number> | null;
    error: string | null;
  } | null;
  kpis: Kpis;
  campaigns: CampaignPerf[];
  timeseries: DailyPoint[];
  windowDays: number;
}

type MetricKey = "spend" | "clicks" | "conversions" | "cpa";
const METRICS: { key: MetricKey; label: string; money?: boolean }[] = [
  { key: "spend", label: "Spend", money: true },
  { key: "clicks", label: "Clicks" },
  { key: "conversions", label: "Conversions" },
  { key: "cpa", label: "CPA", money: true },
];

function useOverview() {
  return useQuery<OverviewResponse>({
    queryKey: ["ads-overview"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/ads/overview");
      if (!res.ok) throw new Error("Couldn't load the Ads overview.");
      return res.json();
    },
  });
}

function money(v: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}
const num = (v: number) => new Intl.NumberFormat("en-US").format(v);

export function AdsCommandCenter() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useOverview();
  const [chartMetric, setChartMetric] = useState<MetricKey>("spend");

  const syncNow = useMutation({
    mutationFn: async () => {
      const res = await edgeFetch("/api/admin/ads/google/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Sync failed.");
      return body;
    },
    onSuccess: (body: { configured?: boolean; message?: string; counts?: Record<string, number> }) => {
      if (body.configured === false) {
        toast.info(body.message ?? "Google Ads isn't configured yet.");
      } else {
        toast.success("Ads sync complete.");
      }
      void qc.invalidateQueries({ queryKey: ["ads-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Loading performance…</p>;
  }
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Couldn't load the Ads overview. Try again shortly.
        </CardContent>
      </Card>
    );
  }

  const currency = data.account?.currency_code ?? "USD";

  // Unconfigured / no data yet — explicit empty state (link to connection status).
  if (!data.configured || !data.tablesReady || data.campaigns.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" /> Ads Command Center
          </CardTitle>
          <CardDescription>
            {!data.configured
              ? "Google Ads isn't connected yet. Set the GOOGLE_ADS_* secrets, then run a sync to populate the dashboard."
              : !data.tablesReady
              ? "The Ads tables aren't migrated yet — apply migration 00381, then run a sync."
              : "No synced data yet. Run the first sync to pull your campaigns and metrics."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
            <RefreshCw className={`mr-2 h-4 w-4 ${syncNow.isPending ? "animate-spin" : ""}`} />
            {syncNow.isPending ? "Syncing…" : "Sync now"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const k = data.kpis;
  const kpiCards: { label: string; value: string }[] = [
    { label: "Spend", value: money(k.spend, currency) },
    { label: "Clicks", value: num(k.clicks) },
    { label: "CTR", value: `${(k.ctr * 100).toFixed(2)}%` },
    { label: "CPC", value: money(k.cpc, currency) },
    { label: "Conversions", value: num(k.conversions) },
    { label: "CPA", value: money(k.cpa, currency) },
    { label: "ROAS", value: `${k.roas.toFixed(2)}×` },
    { label: "Impressions", value: num(k.impressions) },
  ];
  const activeMetric = METRICS.find((m) => m.key === chartMetric)!;

  return (
    <div className="space-y-6">
      {/* Header + sync */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {data.account?.descriptive_name ?? "Google Ads"}
            {data.account?.currency_code ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {data.account.currency_code}
              </span>
            ) : null}
          </h2>
          <p className="text-xs text-muted-foreground">
            Last {data.windowDays} days
            {data.lastSync?.finished_at
              ? ` · synced ${new Date(data.lastSync.finished_at).toLocaleString()}`
              : ""}
            {data.lastSync?.counts
              ? ` · ${Object.entries(data.lastSync.counts).map(([kk, vv]) => `${vv} ${kk}`).join(", ")}`
              : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
          <RefreshCw className={`mr-2 h-4 w-4 ${syncNow.isPending ? "animate-spin" : ""}`} />
          {syncNow.isPending ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {kpiCards.map((kc) => (
          <Card key={kc.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{kc.label}</p>
              <p className="mt-1 text-xl font-semibold">{kc.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Trend chart */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <CardTitle className="text-sm font-medium">Daily {activeMetric.label.toLowerCase()}</CardTitle>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Trend metric">
            {METRICS.map((m) => (
              <Button
                key={m.key}
                variant={m.key === chartMetric ? "default" : "outline"}
                size="sm"
                onClick={() => setChartMetric(m.key)}
                aria-pressed={m.key === chartMetric}
              >
                {m.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.timeseries} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} width={56} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "var(--radius)",
                    fontSize: 12,
                  }}
                  formatter={(value) =>
                    activeMetric.money ? money(Number(value), currency) : num(Number(value))}
                />
                <Line
                  type="monotone"
                  dataKey={chartMetric}
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  name={activeMetric.label}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Campaign table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Campaigns</CardTitle>
          <CardDescription>Spend-sorted, last {data.windowDays} days.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">CTR</TableHead>
                <TableHead className="text-right">CPC</TableHead>
                <TableHead className="text-right">Conv.</TableHead>
                <TableHead className="text-right">CPA</TableHead>
                <TableHead className="text-right">ROAS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.campaigns.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="max-w-[220px] truncate font-medium">
                    {c.name}
                    {c.status ? (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        {c.status}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">{money(c.spend, currency)}</TableCell>
                  <TableCell className="text-right">{num(c.clicks)}</TableCell>
                  <TableCell className="text-right">{(c.ctr * 100).toFixed(2)}%</TableCell>
                  <TableCell className="text-right">{money(c.cpc, currency)}</TableCell>
                  <TableCell className="text-right">{num(c.conversions)}</TableCell>
                  <TableCell className="text-right">{money(c.cpa, currency)}</TableCell>
                  <TableCell className="text-right">{c.roas.toFixed(2)}×</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

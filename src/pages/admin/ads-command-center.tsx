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
import { AlertTriangle, RefreshCw, Sparkles, TrendingUp } from "lucide-react";

const sevRank = (s: string | null): number => (s === "high" ? 0 : s === "medium" ? 1 : 2);

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
  pacing?: {
    mtdSpend: number;
    dayOfMonth: number;
    daysInMonth: number;
    dailyAvg: number;
    projectedEom: number;
    monthlyBudget: number;
    projectedUtilization: number;
  } | null;
  windowDays: number;
}

interface Recommendation {
  id: string;
  target_type: string;
  target_resource: string;
  target_name: string | null;
  change_type: string;
  rationale: string;
  confidence: number | null;
  projected_impact: Record<string, number> | null;
  severity: string | null;
  status: string;
  payload: Record<string, unknown> | null;
  snooze_until: string | null;
  dismiss_reason: string | null;
}

// US-1702: a human-readable "current → proposed" preview from the rec payload.
function describeChange(r: Recommendation): string {
  const p = r.payload ?? {};
  const money = (v: unknown) => {
    const micros = Number((p as Record<string, unknown>)[v as string]);
    return Number.isFinite(micros) ? `$${(micros / 1_000_000).toFixed(2)}` : String((p as Record<string, unknown>)[v as string] ?? "");
  };
  switch (r.change_type) {
    case "pause_campaign": return "Pause campaign";
    case "pause_ad_group": return "Pause ad group";
    case "pause_keyword": return "Pause keyword";
    case "adjust_budget":
    case "reallocate_budget": return `Budget → ${p.amount != null ? `$${p.amount}` : money("amountMicros")}`;
    case "adjust_bid": return `Bid → ${p.bidAmount != null ? `$${p.bidAmount}` : money("cpcBidMicros")}`;
    case "adjust_tcpa": return `Target CPA → ${money("targetCpaMicros")}`;
    case "add_negative_keyword": return `Add negative keyword: “${String(p.text ?? "")}”`;
    case "add_keyword": return `Add keyword: “${String(p.text ?? "")}”`;
    case "fix_rsa_gap": return "Fix responsive-search-ad gaps";
    default: return r.change_type.replace(/_/g, " ");
  }
}

// Mirrors the edge EXECUTABLE_CHANGE_TYPES allow-list (google-ads-mutate.ts):
// only these can be applied to Google Ads; the rest are report-only.
const EXECUTABLE_CHANGE_TYPES = new Set([
  "pause_campaign",
  "pause_ad_group",
  "pause_keyword",
  "adjust_budget",
  "reallocate_budget",
  "adjust_bid",
  "adjust_tcpa",
  "add_negative_keyword",
]);

type MetricKey = "spend" | "clicks" | "conversions" | "cpa";
const METRICS: { key: MetricKey; label: string; money?: boolean }[] = [
  { key: "spend", label: "Spend", money: true },
  { key: "clicks", label: "Clicks" },
  { key: "conversions", label: "Conversions" },
  { key: "cpa", label: "CPA", money: true },
];

function useOverview(platform: string) {
  return useQuery<OverviewResponse>({
    queryKey: ["ads-overview", platform],
    queryFn: async () => {
      const res = await edgeFetch(`/api/admin/ads/overview?platform=${platform}`);
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
  const [platform, setPlatform] = useState<"google_ads" | "apple_search_ads">("google_ads");
  const { data, isLoading, isError } = useOverview(platform);
  const [chartMetric, setChartMetric] = useState<MetricKey>("spend");

  const syncNow = useMutation({
    mutationFn: async () => {
      const path = platform === "apple_search_ads" ? "/api/admin/ads/apple/sync" : "/api/admin/ads/google/sync";
      const res = await edgeFetch(path, { method: "POST" });
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

  const recsQuery = useQuery<{ recommendations: Recommendation[] }>({
    queryKey: ["ads-recommendations", platform],
    queryFn: async () => {
      const res = await edgeFetch(`/api/admin/ads/recommendations?platform=${platform}`);
      if (!res.ok) throw new Error("Couldn't load recommendations.");
      return res.json();
    },
  });
  const analyze = useMutation({
    mutationFn: async () => {
      const res = await edgeFetch(`/api/admin/ads/analyze?platform=${platform}`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Analysis failed.");
      return body as { generated?: number };
    },
    onSuccess: (b) => {
      toast.success(`Analysis complete — ${b.generated ?? 0} recommendation(s).`);
      void qc.invalidateQueries({ queryKey: ["ads-recommendations"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const recAction = useMutation({
    mutationFn: async (
      v: { id: string; action: "approve" | "apply" | "revert" | "dismiss" | "snooze"; dryRun?: boolean; reason?: string; until?: string },
    ) => {
      const base = `/api/admin/ads/recommendations/${v.id}`;
      const path = `${base}/${v.action}`;
      const bodyObj =
        v.action === "apply" ? { dryRun: v.dryRun ?? true }
          : v.action === "dismiss" ? { reason: v.reason }
          : v.action === "snooze" ? { until: v.until }
          : undefined;
      const res = await edgeFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyObj ? JSON.stringify(bodyObj) : undefined,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? "Action failed.");
      return { action: v.action, dryRun: v.dryRun };
    },
    onSuccess: (r) => {
      const msg: Record<string, string> = {
        approve: "Approved.",
        revert: "Rolled back.",
        dismiss: "Dismissed.",
        snooze: "Snoozed.",
      };
      toast.success(
        r.action === "apply" ? (r.dryRun ? "Dry-run passed — safe to apply." : "Applied to the ad platform.") : (msg[r.action] ?? "Done."),
      );
      void qc.invalidateQueries({ queryKey: ["ads-recommendations"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const platformToggle = (
    <div className="flex gap-1" role="group" aria-label="Ad platform">
      <Button size="sm" variant={platform === "google_ads" ? "default" : "outline"} onClick={() => setPlatform("google_ads")}>
        Google Ads
      </Button>
      <Button size="sm" variant={platform === "apple_search_ads" ? "default" : "outline"} onClick={() => setPlatform("apple_search_ads")}>
        Apple Search Ads
      </Button>
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        {platformToggle}
        <p className="py-10 text-center text-sm text-muted-foreground">Loading performance…</p>
      </div>
    );
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
        <CardContent className="space-y-3">
          {platformToggle}
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
      {/* Platform toggle */}
      {platformToggle}

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

      {/* Budget pacing */}
      {data.pacing && data.pacing.monthlyBudget > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Budget pacing (month to date)</CardTitle>
            <CardDescription>
              Day {data.pacing.dayOfMonth} of {data.pacing.daysInMonth} ·{" "}
              {money(data.pacing.mtdSpend, currency)} spent · {money(data.pacing.dailyAvg, currency)}/day avg
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm">
                Projected end-of-month:{" "}
                <span className="font-semibold">{money(data.pacing.projectedEom, currency)}</span>
                <span className="text-muted-foreground"> of {money(data.pacing.monthlyBudget, currency)} budget</span>
              </span>
              <Badge variant={data.pacing.projectedUtilization > 1 ? "destructive" : "outline"}>
                {Math.round(data.pacing.projectedUtilization * 100)}% projected
              </Badge>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full ${data.pacing.projectedUtilization > 1 ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${Math.min(100, Math.round(data.pacing.projectedUtilization * 100))}%` }}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

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

      {/* Recommendations (report-only — nothing is applied automatically) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-sm font-medium">Recommendations</CardTitle>
            <CardDescription>
              Claude analysis — report-only; nothing is applied automatically.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => analyze.mutate()} disabled={analyze.isPending}>
            <Sparkles className={`mr-2 h-4 w-4 ${analyze.isPending ? "animate-pulse" : ""}`} />
            {analyze.isPending ? "Analyzing…" : "Analyze"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {(recsQuery.data?.recommendations ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recommendations yet. Run an analysis to generate optimization guidance.
            </p>
          ) : (
            [...(recsQuery.data?.recommendations ?? [])]
              .sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
              .map((r) => (
                <div key={r.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={r.severity === "high" ? "destructive" : "outline"}
                      className="text-[10px] uppercase"
                    >
                      {r.severity ?? "medium"}
                    </Badge>
                    <span className="text-sm font-medium">{describeChange(r)}</span>
                    <span className="text-xs text-muted-foreground">
                      · {r.target_type}
                      {r.target_name ? ` · ${r.target_name}` : ""}
                    </span>
                    {typeof r.confidence === "number" ? (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {Math.round(r.confidence * 100)}% conf.
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm">{r.rationale}</p>
                  {r.projected_impact && Object.keys(r.projected_impact).length > 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {Object.entries(r.projected_impact)
                        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="text-[10px] uppercase">{r.status}</Badge>
                    {r.status === "snoozed" ? (
                      <>
                        <span className="text-xs text-muted-foreground">
                          Snoozed{r.snooze_until ? ` until ${new Date(r.snooze_until).toLocaleDateString()}` : ""}
                        </span>
                        {/* Approve only makes sense for executable recs (report-only can't be applied). */}
                        {EXECUTABLE_CHANGE_TYPES.has(r.change_type) ? (
                          <Button size="sm" variant="outline" disabled={recAction.isPending}
                            aria-label={`Un-snooze and approve ${r.target_name ?? r.target_type}`}
                            onClick={() => recAction.mutate({ id: r.id, action: "approve" })}>
                            Un-snooze / Approve
                          </Button>
                        ) : null}
                        <Button size="sm" variant="ghost" disabled={recAction.isPending}
                          aria-label={`Dismiss ${r.target_name ?? r.target_type}`}
                          onClick={() => recAction.mutate({ id: r.id, action: "dismiss" })}>
                          Dismiss
                        </Button>
                      </>
                    ) : r.status === "proposed" ? (
                      <>
                        {EXECUTABLE_CHANGE_TYPES.has(r.change_type) ? (
                          <Button size="sm" variant="outline" disabled={recAction.isPending}
                            aria-label={`Approve ${r.target_name ?? r.target_type}`}
                            onClick={() => recAction.mutate({ id: r.id, action: "approve" })}>
                            Approve
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Report-only</span>
                        )}
                        <Button size="sm" variant="ghost" disabled={recAction.isPending}
                          aria-label={`Dismiss ${r.target_name ?? r.target_type}`}
                          onClick={() => recAction.mutate({ id: r.id, action: "dismiss" })}>
                          Dismiss
                        </Button>
                        <Button size="sm" variant="ghost" disabled={recAction.isPending}
                          aria-label={`Snooze ${r.target_name ?? r.target_type} for 7 days`}
                          onClick={() => recAction.mutate({
                            id: r.id,
                            action: "snooze",
                            until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                          })}>
                          Snooze 7d
                        </Button>
                      </>
                    ) : !EXECUTABLE_CHANGE_TYPES.has(r.change_type) ? (
                      <span className="text-xs text-muted-foreground">Report-only — apply manually.</span>
                    ) : r.status === "approved" ? (
                      <>
                        <Button size="sm" variant="outline" disabled={recAction.isPending}
                          aria-label={`Dry-run ${r.target_name ?? r.target_type}`}
                          onClick={() => recAction.mutate({ id: r.id, action: "apply", dryRun: true })}>
                          Dry-run
                        </Button>
                        <Button size="sm" disabled={recAction.isPending}
                          aria-label={`Apply ${r.target_name ?? r.target_type}`}
                          onClick={() => recAction.mutate({ id: r.id, action: "apply", dryRun: false })}>
                          Apply
                        </Button>
                      </>
                    ) : r.status === "applied" ? (
                      <Button size="sm" variant="outline" disabled={recAction.isPending}
                        aria-label={`Roll back ${r.target_name ?? r.target_type}`}
                        onClick={() => recAction.mutate({ id: r.id, action: "revert" })}>
                        Roll back
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

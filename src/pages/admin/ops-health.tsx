import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Activity,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  CircleAlert,
  HelpCircle,
  Database,
  HardDrive,
} from "lucide-react";

// US-883 — Operations console: system health & infrastructure dashboard.
//
// Read-only. Renders the /api/admin/ops/health payload as green/amber/red status
// tiles (thresholds tunable server-side via the system_settings registry), with
// a sparkline trend where data exists, plus DB table sizes, storage usage and
// the slowest recent jobs.

type HealthStatus = "green" | "amber" | "red" | "unknown";

interface HealthTile {
  key: string;
  label: string;
  status: HealthStatus;
  value: string;
  detail?: string;
  trend?: number[];
}

interface TableStat {
  name: string;
  rows: number;
  bytes: number;
}
interface BucketStat {
  bucket: string;
  objects: number;
  bytes: number;
}
interface SlowestJob {
  job: string;
  durationMs: number | null;
  status: string;
  at: string;
}

interface HealthReport {
  overall: HealthStatus;
  tiles: HealthTile[];
  runtime: {
    uptimeSeconds: number;
    version: string;
    env: string;
    supabaseReachable: boolean;
    dbLatencyMs: number | null;
  };
  metrics: {
    tables: TableStat[];
    storage: { buckets: BucketStat[]; totalObjects: number; totalBytes: number };
    jobs: { failuresLast24h: number; maxDurationMs: number; slowest: SlowestJob[] };
  } | null;
  thresholds: unknown;
  generatedAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const STATUS_STYLES: Record<HealthStatus, { ring: string; text: string; bg: string; Icon: typeof CheckCircle2 }> = {
  green: { ring: "border-emerald-200", text: "text-emerald-600", bg: "bg-emerald-50", Icon: CheckCircle2 },
  amber: { ring: "border-amber-300", text: "text-amber-600", bg: "bg-amber-50", Icon: AlertTriangle },
  red: { ring: "border-red-300", text: "text-destructive", bg: "bg-red-50", Icon: CircleAlert },
  unknown: { ring: "border-border", text: "text-muted-foreground", bg: "bg-muted/40", Icon: HelpCircle },
};

function Sparkline({ data, status }: { data: number[]; status: HealthStatus }) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const w = 80;
  const h = 24;
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(" ");
  const stroke =
    status === "red" ? "#E94560" : status === "amber" ? "#d97706" : "#059669";
  return (
    <svg width={w} height={h} className="overflow-visible" aria-hidden>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}

function StatusTile({ tile }: { tile: HealthTile }) {
  const s = STATUS_STYLES[tile.status];
  return (
    <div className={cn("rounded-lg border p-4", s.ring, s.bg)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{tile.label}</span>
        <s.Icon className={cn("h-4 w-4", s.text)} />
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className={cn("text-2xl font-bold", s.text)}>{tile.value}</span>
        {tile.trend && tile.trend.length > 0 && (
          <Sparkline data={tile.trend} status={tile.status} />
        )}
      </div>
      {tile.detail && <p className="mt-1 text-xs text-muted-foreground">{tile.detail}</p>}
    </div>
  );
}

export function AdminOpsHealthPage() {
  const visible = useDocumentVisible();
  const healthQuery = useQuery({
    queryKey: ["admin-ops-health"],
    queryFn: () => getJson<HealthReport>("/api/admin/ops/health"),
    refetchInterval: visible ? 30_000 : false,
  });

  const data = healthQuery.data;
  const overall = data?.overall ?? "unknown";
  const overallStyle = STATUS_STYLES[overall];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6 text-brand-red-text" />
          <div>
            <h1 className="text-2xl font-bold">System Health</h1>
            <p className="text-sm text-muted-foreground">
              Live infrastructure dashboard — DB &amp; storage usage, queue/DLQ depths, recent
              job failures. Spot a problem before customers do.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <Badge
              className={cn("capitalize", overallStyle.text, overallStyle.bg, "border", overallStyle.ring)}
              variant="outline"
            >
              {overall}
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void healthQuery.refetch()}
            disabled={healthQuery.isFetching}
          >
            {healthQuery.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {healthQuery.isLoading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : healthQuery.isError ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-destructive">
            {(healthQuery.error as Error)?.message ?? "Failed to load system health."}
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Status tiles */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {data.tiles.map((tile) => (
              <StatusTile key={tile.key} tile={tile} />
            ))}
          </div>

          {/* Runtime line */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm text-muted-foreground">
              <span>
                Edge uptime <strong className="text-foreground">{formatUptime(data.runtime.uptimeSeconds)}</strong>
              </span>
              <span>
                Version <code className="text-foreground">{data.runtime.version || "unknown"}</code>
              </span>
              <span>
                Env <code className="text-foreground">{data.runtime.env}</code>
              </span>
              {data.runtime.dbLatencyMs != null && (
                <span>
                  DB latency <strong className="text-foreground">{data.runtime.dbLatencyMs} ms</strong>
                </span>
              )}
              <span className="ml-auto">
                Updated {new Date(data.generatedAt).toLocaleTimeString()}
              </span>
            </CardContent>
          </Card>

          {data.metrics && (
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Table sizes */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Database className="h-4 w-4" /> Table sizes
                  </CardTitle>
                  <CardDescription>Estimated rows + on-disk size for high-traffic tables.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Table</TableHead>
                        <TableHead className="text-right">Rows</TableHead>
                        <TableHead className="text-right">Size</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.metrics.tables.map((t) => (
                        <TableRow key={t.name}>
                          <TableCell className="font-mono text-xs">{t.name}</TableCell>
                          <TableCell className="text-right text-sm">{t.rows.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-sm">{formatBytes(t.bytes)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Storage + slowest jobs */}
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <HardDrive className="h-4 w-4" /> Storage buckets
                    </CardTitle>
                    <CardDescription>
                      {data.metrics.storage.totalObjects.toLocaleString()} objects ·{" "}
                      {formatBytes(data.metrics.storage.totalBytes)} total
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Bucket</TableHead>
                          <TableHead className="text-right">Objects</TableHead>
                          <TableHead className="text-right">Size</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.metrics.storage.buckets.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                              No storage objects.
                            </TableCell>
                          </TableRow>
                        ) : (
                          data.metrics.storage.buckets.map((b) => (
                            <TableRow key={b.bucket}>
                              <TableCell className="font-mono text-xs">{b.bucket}</TableCell>
                              <TableCell className="text-right text-sm">{b.objects.toLocaleString()}</TableCell>
                              <TableCell className="text-right text-sm">{formatBytes(b.bytes)}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Slowest jobs (24h)</CardTitle>
                    <CardDescription>Longest-running cron executions in the last day.</CardDescription>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Job</TableHead>
                          <TableHead className="text-right">Duration</TableHead>
                          <TableHead className="text-right">Outcome</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.metrics.jobs.slowest.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                              No recorded runs.
                            </TableCell>
                          </TableRow>
                        ) : (
                          data.metrics.jobs.slowest.map((j, i) => (
                            <TableRow key={`${j.job}-${i}`}>
                              <TableCell className="font-mono text-xs">{j.job}</TableCell>
                              <TableCell className="text-right text-sm">
                                {j.durationMs != null ? `${(j.durationMs / 1000).toFixed(1)}s` : "—"}
                              </TableCell>
                              <TableCell className="text-right text-sm">
                                <span className={j.status === "error" ? "text-destructive" : "text-muted-foreground"}>
                                  {j.status}
                                </span>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

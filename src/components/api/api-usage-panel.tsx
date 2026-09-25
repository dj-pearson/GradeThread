// US-596: usage/billing dashboard for the public grading API. Reads the
// per-key request ledger summary + the account's rate-limit tier from
// GET /api/keys/usage and renders call volume, the live/sandbox split, a
// 30-day daily chart, busiest endpoints, and the documented per-minute limits.
import { useState } from "react";
import { Gauge } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiUsageError, useApiUsage } from "@/hooks/use-api-usage";
import { zeroFillDaily } from "@/lib/api-usage-series";

function shortDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const W = 600;
const H = 140;
const PAD_TOP = 8;
const PAD_BOTTOM = 20;
const GAP = 2;

function DailyChart({ series }: { series: { day: string; count: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((d) => d.count));
  const slot = W / series.length;
  const barW = Math.max(1, slot - GAP);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const active = hover !== null ? series[hover] : null;

  return (
    <figure className="space-y-2">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">Requests per day (UTC)</span>
        <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {active
            ? `${shortDay(active.day)}: ${active.count.toLocaleString()}`
            : `Peak ${max.toLocaleString()}`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-36 w-full text-primary"
        role="img"
        aria-label={`Daily API requests for the last ${series.length} days. The table below has the numbers.`}
        onMouseLeave={() => setHover(null)}
      >
        <line
          x1={0}
          x2={W}
          y1={H - PAD_BOTTOM}
          y2={H - PAD_BOTTOM}
          className="stroke-border"
          strokeWidth={1}
        />
        {series.map((d, i) => {
          const h = d.count === 0 ? 0 : Math.max(2, (d.count / max) * plotH);
          const x = i * slot + GAP / 2;
          return (
            <g key={d.day} data-testid="usage-bar" onMouseEnter={() => setHover(i)}>
              {/* Hit target: the whole column, not just the bar. */}
              <rect x={i * slot} y={0} width={slot} height={H - PAD_BOTTOM} fill="transparent" />
              {h > 0 && (
                <rect
                  x={x}
                  y={H - PAD_BOTTOM - h}
                  width={barW}
                  height={h}
                  rx={Math.min(2, barW / 2)}
                  fill="currentColor"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              <title>{`${shortDay(d.day)}: ${d.count.toLocaleString()} requests`}</title>
            </g>
          );
        })}
        <text x={0} y={H - 4} className="fill-muted-foreground text-[10px]">
          {shortDay(series[0]!.day)}
        </text>
        <text x={W} y={H - 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
          {shortDay(series[series.length - 1]!.day)}
        </text>
      </svg>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Show as a table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day (UTC)</TableHead>
                <TableHead className="text-right">Requests</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {series.map((d) => (
                <TableRow key={d.day}>
                  <TableCell>{d.day}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.count.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </figure>
  );
}

export function ApiUsagePanel() {
  const { data, isLoading, isError, error, isFetching, refetch } = useApiUsage();

  const summary = data?.summary;
  const liveSuccess = data?.live_success_requests ?? 0;
  const sandbox = summary?.sandbox_requests ?? 0;
  // Live errors are every live call that was not a success, so the three
  // parts add up to the total by construction.
  const liveErrors = summary ? Math.max(0, summary.total_requests - sandbox - liveSuccess) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-5 w-5" />
          API Usage &amp; Limits
        </CardTitle>
        <CardDescription>
          Request volume across all your keys for the last 30 days, plus your
          plan&apos;s rate limits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : isError ? (
          error instanceof ApiUsageError && error.status === 403 ? (
            <p className="text-sm text-muted-foreground">{error.message}</p>
          ) : (
            <ErrorState
              title="Couldn't load API usage"
              description="Your usage numbers didn't load. Your keys and limits are unaffected."
              onRetry={() => void refetch()}
              retrying={isFetching}
              hideSupport
            />
          )
        ) : data && summary ? (
          <>
            {/* One typographic row. Total, then the three parts that make it up. */}
            <dl className="flex flex-wrap gap-x-10 gap-y-4" data-testid="usage-stats">
              {[
                { label: "Total requests (30d)", value: summary.total_requests, key: "total" },
                { label: "Live success", value: liveSuccess, key: "live-success" },
                { label: "Live errors", value: liveErrors, key: "live-errors" },
                { label: "Sandbox (free)", value: sandbox, key: "sandbox" },
              ].map((s) => (
                <div key={s.key} data-stat={s.key}>
                  <dd className="text-2xl font-bold tabular-nums">{s.value.toLocaleString()}</dd>
                  <dt className="text-xs text-muted-foreground">{s.label}</dt>
                </div>
              ))}
            </dl>

            <DailyChart series={zeroFillDaily(summary.daily)} />

            {/* Rate-limit tier: the SAME budget the live API enforces. */}
            <div className="rounded-lg bg-muted/40 p-4">
              <p className="text-sm font-medium">
                Rate limits, <span className="capitalize">{data.plan.replace("_", " ")}</span> plan
              </p>
              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-2xl font-bold tabular-nums">{data.rate_limits.read_per_minute}</p>
                  <p className="text-xs text-muted-foreground">reads / min (GET)</p>
                </div>
                <div>
                  <p className="text-2xl font-bold tabular-nums">{data.rate_limits.write_per_minute}</p>
                  <p className="text-xs text-muted-foreground">writes / min (POST, PATCH, PUT, DELETE)</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Limits are per API key in a {data.rate_limits.window_seconds}-second window.
                Exceeding a budget returns <code className="rounded bg-muted px-1">429</code> with a
                <code className="rounded bg-muted px-1">retry_after_seconds</code> hint.
              </p>
            </div>

            {summary.by_endpoint.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">Busiest endpoints</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Requests</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.by_endpoint.map((row) => (
                      <TableRow key={`${row.method} ${row.endpoint}`}>
                        <TableCell>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{row.endpoint}</code>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{row.method}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.count.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {summary.total_requests === 0 && (
              <p className="text-sm text-muted-foreground">
                No API calls yet. Try the free sandbox at{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  POST /api/v1/sandbox/grades
                </code>
                . It returns a sample grade and spends no credits.
              </p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

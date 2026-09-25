// US-596: usage/billing dashboard for the public grading API. Reads the
// per-key request ledger summary + the account's rate-limit tier from
// GET /api/keys/usage and renders call volume, success/error/sandbox split,
// busiest endpoints, and the documented per-minute limits.
import { Activity, AlertCircle, FlaskConical, Gauge } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApiUsage } from "@/hooks/use-api-usage";

function Stat({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Activity }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-brand-navy/10 text-brand-navy dark:text-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-2xl font-bold tabular-nums">{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

export function ApiUsagePanel() {
  const { data, isLoading } = useApiUsage();

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
          <div className="grid gap-3 sm:grid-cols-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Total requests (30d)" value={data.summary.total_requests} icon={Activity} />
              <Stat label="Successful" value={data.summary.success_requests} icon={Gauge} />
              <Stat label="Errors" value={data.summary.error_requests} icon={AlertCircle} />
              <Stat label="Sandbox (free)" value={data.summary.sandbox_requests} icon={FlaskConical} />
            </div>

            {/* Rate-limit tier — the SAME budget the live API enforces. */}
            <div className="rounded-lg border bg-muted/40 p-4">
              <p className="text-sm font-medium">
                Rate limits — <span className="capitalize">{data.plan.replace("_", " ")}</span> plan
              </p>
              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-2xl font-bold tabular-nums">{data.rate_limits.read_per_minute}</p>
                  <p className="text-xs text-muted-foreground">reads / min (GET)</p>
                </div>
                <div>
                  <p className="text-2xl font-bold tabular-nums">{data.rate_limits.write_per_minute}</p>
                  <p className="text-xs text-muted-foreground">writes / min (POST · PATCH)</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Limits are per API key in a {data.rate_limits.window_seconds}-second window.
                Exceeding a budget returns <code className="rounded bg-muted px-1">429</code> with a
                <code className="rounded bg-muted px-1">retry_after_seconds</code> hint.
              </p>
            </div>

            {data.summary.by_endpoint.length > 0 && (
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
                    {data.summary.by_endpoint.map((row) => (
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

            {data.summary.total_requests === 0 && (
              <p className="text-sm text-muted-foreground">
                No API calls yet. Try the free sandbox at{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  POST /api/v1/sandbox/grades
                </code>{" "}
                — it returns a sample grade and spends no credits.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Usage data is unavailable right now.</p>
        )}
      </CardContent>
    </Card>
  );
}

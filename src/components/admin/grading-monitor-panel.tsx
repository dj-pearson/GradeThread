import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Play,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";

// US-335: admin view of the automated grading regression monitor (US-327).
// Reads/triggers the monitor via the admin edge endpoints (the
// grading_monitor_runs table isn't in the typed supabase Database).

type Severity = "ok" | "warn" | "critical";

interface MonitorRun {
  id: string;
  trigger: string;
  severity: Severity;
  eval: {
    ran: boolean;
    skipped_reason?: string;
    prompt_version_name?: string;
    mean_absolute_error?: number;
    agreement_rate?: number;
    passed?: boolean;
    regression_vs_baseline?: boolean;
  };
  production: {
    human_reviews: number;
    agreement_rate: number;
    mean_absolute_error: number;
    intentional_misread_rate: number;
    graded_sales: number;
    dispute_rate: number;
  };
  alerts: Array<{ code: string; severity: string; message: string }>;
  alert_codes: string[];
  alerted: boolean;
  created_at: string;
}

const SEVERITY_META: Record<
  Severity,
  { label: string; badge: string; Icon: typeof CheckCircle2; tint: string }
> = {
  ok: {
    label: "Healthy",
    badge: "bg-green-100 text-green-800 border-green-200",
    Icon: CheckCircle2,
    tint: "text-green-600",
  },
  warn: {
    label: "Warning",
    badge: "bg-yellow-100 text-yellow-800 border-yellow-200",
    Icon: AlertTriangle,
    tint: "text-yellow-600",
  },
  critical: {
    label: "Critical",
    badge: "bg-red-100 text-red-800 border-red-200",
    Icon: ShieldAlert,
    tint: "text-red-600",
  },
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function timeAgo(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
}

export function GradingMonitorPanel() {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-grading-monitor-runs"],
    queryFn: async (): Promise<MonitorRun[]> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/admin/grading/monitor/runs`,
        { headers: await authHeaders() },
      );
      if (!res.ok) throw new Error(`Monitor runs unavailable (${res.status})`);
      const body = (await res.json()) as { runs?: MonitorRun[] };
      return body.runs ?? [];
    },
    staleTime: 30 * 1000,
  });

  async function handleRunNow() {
    setRunning(true);
    try {
      const res = await fetch(`${edgeApiUrl()}/api/admin/grading/monitor/run`, {
        method: "POST",
        headers: await authHeaders(),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
      const sev = (body.severity ?? "ok") as Severity;
      const count = Array.isArray(body.alerts) ? body.alerts.length : 0;
      toast.success("Monitor scan complete", {
        description:
          sev === "ok"
            ? "No quality regressions detected."
            : `${SEVERITY_META[sev].label}: ${count} alert${count === 1 ? "" : "s"} raised.`,
      });
      queryClient.invalidateQueries({ queryKey: ["admin-grading-monitor-runs"] });
    } catch (err) {
      toast.error("Monitor scan failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRunning(false);
    }
  }

  const runs = data ?? [];
  const latest = runs[0];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Activity className="h-4 w-4 text-brand-navy" />
            Quality Monitor
          </CardTitle>
          <CardDescription>
            Automated regression checks against the golden set and live review /
            dispute metrics. Runs on a schedule; trigger one any time.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={handleRunNow} disabled={running}>
          <Play className="mr-2 h-4 w-4" />
          {running ? "Running…" : "Run now"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Monitor data is temporarily unavailable.
          </p>
        ) : !latest ? (
          <p className="text-sm text-muted-foreground">
            No monitor runs yet. The scheduled cron records runs here, or use
            “Run now”.
          </p>
        ) : (
          <>
            {/* Latest run summary */}
            {(() => {
              const meta = SEVERITY_META[latest.severity] ?? SEVERITY_META.ok;
              const Icon = meta.Icon;
              return (
                <div className="rounded-lg border p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className={`h-5 w-5 ${meta.tint}`} />
                      <Badge variant="outline" className={meta.badge}>
                        {meta.label}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(latest.created_at)}
                    </span>
                  </div>

                  {/* Eval line */}
                  <p className="mt-3 text-sm">
                    <span className="font-medium">Golden-set eval:</span>{" "}
                    {latest.eval.ran ? (
                      <>
                        {latest.eval.prompt_version_name} — MAE{" "}
                        {latest.eval.mean_absolute_error?.toFixed(2)}, agreement{" "}
                        {latest.eval.agreement_rate != null
                          ? pct(latest.eval.agreement_rate)
                          : "—"}
                        ,{" "}
                        <span
                          className={
                            latest.eval.passed ? "text-green-600" : "text-red-600"
                          }
                        >
                          {latest.eval.passed ? "passed" : "FAILED"}
                        </span>
                        {latest.eval.regression_vs_baseline && (
                          <span className="text-yellow-700"> · regressed vs baseline</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        skipped ({latest.eval.skipped_reason ?? "n/a"})
                      </span>
                    )}
                  </p>

                  {/* Production metrics */}
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                    <Metric label="Agreement" value={pct(latest.production.agreement_rate)} />
                    <Metric label="MAE" value={latest.production.mean_absolute_error.toFixed(2)} />
                    <Metric label="Reviews" value={String(latest.production.human_reviews)} />
                    <Metric label="Misread rate" value={pct(latest.production.intentional_misread_rate)} />
                    <Metric label="Dispute rate" value={pct(latest.production.dispute_rate)} />
                    <Metric label="Graded sales" value={String(latest.production.graded_sales)} />
                  </div>

                  {/* Alerts */}
                  {latest.alerts.length > 0 && (
                    <ul className="mt-3 space-y-1.5 border-t pt-3">
                      {latest.alerts.map((a, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          <span
                            className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                              a.severity === "critical" ? "bg-red-500" : "bg-yellow-500"
                            }`}
                          />
                          <span className="text-muted-foreground">{a.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}

            {/* Recent runs */}
            {runs.length > 1 && (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Recent runs
                </p>
                <div className="overflow-hidden rounded-lg border">
                  <table className="w-full text-xs">
                    <tbody>
                      {runs.slice(0, 8).map((r) => {
                        const meta = SEVERITY_META[r.severity] ?? SEVERITY_META.ok;
                        return (
                          <tr key={r.id} className="border-t first:border-t-0">
                            <td className="px-3 py-2 text-muted-foreground">
                              {timeAgo(r.created_at)}
                            </td>
                            <td className="px-3 py-2">
                              <Badge variant="outline" className={meta.badge}>
                                {meta.label}
                              </Badge>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {r.alerts.length > 0
                                ? `${r.alerts.length} alert${r.alerts.length === 1 ? "" : "s"}`
                                : "—"}
                            </td>
                            <td className="px-3 py-2 text-right text-muted-foreground">
                              {r.eval.ran
                                ? r.eval.passed
                                  ? "eval ✓"
                                  : "eval ✗"
                                : "eval skipped"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

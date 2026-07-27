import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
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
  Server,
  RefreshCw,
  Loader2,
  Play,
  CheckCircle2,
  AlertTriangle,
  Clock,
  SkipForward,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

// US-881 — Operations console: background jobs & scheduler.
//
// Reads the cron registry joined with recent run stats from
// /api/admin/ops/jobs (last run, outcome, duration, rolling success rate,
// consecutive-failure count, next-due) and offers a super-admin "Run now"
// (MFA step-up gated server-side) for the /api/jobs/* crons.

type JobRunStatus = "succeeded" | "failed" | "skipped" | "running";

interface JobSummary {
  name: string;
  label: string;
  schedule: string;
  category: string;
  endpoint: string;
  recorded: boolean;
  runnable: boolean;
  running: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: JobRunStatus | null;
  last_http_status: number | null;
  last_duration_ms: number | null;
  last_rows_processed: number | null;
  last_triggered_by: string | null;
  runs_total: number;
  success_rate: number | null;
  consecutive_failures: number;
}

interface JobsResponse {
  jobs: JobSummary[];
  page: number;
  page_size: number;
  total: number;
  failing_count: number;
  server_now: string;
}

const FAILING_THRESHOLD = 2;
const PAGE_SIZE = 50;

function relativeAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) {
    const future = -ms;
    if (future < 60_000) return `in ${Math.round(future / 1000)}s`;
    if (future < 3_600_000) return `in ${Math.round(future / 60_000)}m`;
    if (future < 86_400_000) return `in ${Math.round(future / 3_600_000)}h`;
    return `in ${Math.round(future / 86_400_000)}d`;
  }
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function OutcomeCell({ job }: { job: JobSummary }) {
  if (job.running) {
    return (
      <span className="flex items-center gap-1 text-xs text-blue-600">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> running
      </span>
    );
  }
  if (job.last_status == null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (job.last_status === "succeeded") {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {job.last_duration_ms != null ? `${job.last_duration_ms}ms` : "ok"}
      </span>
    );
  }
  if (job.last_status === "skipped") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <SkipForward className="h-3.5 w-3.5" /> skipped
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-destructive">
      <AlertTriangle className="h-3.5 w-3.5" />
      {job.last_http_status ?? "failed"}
    </span>
  );
}

export function AdminOpsJobsPage() {
  const visible = useDocumentVisible();
  const [page, setPage] = useState(1);
  const [running, setRunning] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const jobsQuery = useQuery({
    queryKey: ["admin-ops-jobs", page],
    queryFn: () => getJson<JobsResponse>(`/api/admin/ops/jobs?page=${page}&page_size=${PAGE_SIZE}`),
    refetchInterval: visible ? 20_000 : false,
  });

  async function runJob(key: string) {
    setRunning(key);
    try {
      const res = await edgeFetch(`/api/admin/ops/jobs/${key}/run`, {
        method: "POST",
        json: {},
        silentGate: true,
      });
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
          setRetry(() => () => runJob(key));
          setStepUpOpen(true);
          return;
        }
        toast.error((j as { error?: string })?.error ?? "Forbidden");
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.message("Already running", { description: "This job is currently in progress." });
        return;
      }
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Run failed");
        return;
      }
      if ((j as { running?: boolean })?.running) {
        toast.success("Job started (still running)");
      } else {
        toast.success("Job ran");
      }
      void jobsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(null);
    }
  }

  const data = jobsQuery.data;
  const jobs = data?.jobs ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Background Jobs"
        subtitle={
          <>
            Every scheduled job: last run, outcome, success rate &amp; next due. Run any
            <code className="mx-1">/api/jobs/*</code> cron on demand.
          </>
        }
        icon={Server}
        actions={
          <div className="flex items-center gap-3">
            {(data?.failing_count ?? 0) > 0 && (
              <Badge variant="destructive">
                {data!.failing_count} failing
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void jobsQuery.refetch()}
              disabled={jobsQuery.isFetching}
            >
              {jobsQuery.isFetching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scheduled jobs</CardTitle>
          <CardDescription>
            Last run is captured for <code>/api/jobs/*</code> crons; eBay/Google crons (served
            under <code>/api/flipdesk/*</code>) show schedule &amp; next run only.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {jobsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : jobsQuery.isError ? (
            <p className="p-8 text-center text-sm text-destructive">
              {(jobsQuery.error as Error)?.message ?? "Failed to load jobs."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Success</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => {
                  const failing = job.consecutive_failures >= FAILING_THRESHOLD;
                  return (
                    <TableRow key={job.name} className={failing ? "bg-destructive/5" : undefined}>
                      <TableCell className="font-medium">
                        {job.label}
                        <span className="ml-1 text-xs text-muted-foreground">{job.category}</span>
                        {failing && (
                          <Badge variant="destructive" className="ml-2 text-[10px]">
                            {job.consecutive_failures}× failed
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{job.schedule}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {job.recorded ? relativeAge(job.last_run_at) : <span className="italic">n/a</span>}
                      </TableCell>
                      <TableCell>
                        <OutcomeCell job={job} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {job.success_rate == null
                          ? "—"
                          : `${Math.round(job.success_rate * 100)}% (${job.runs_total})`}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        <Clock className="mr-1 inline h-3 w-3" />
                        {relativeAge(job.next_run_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        {job.runnable ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={running === job.name || job.running}
                            onClick={() => void runJob(job.name)}
                          >
                            {running === job.name ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                            Run now
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => retry?.()}
      />
    </div>
  );
}

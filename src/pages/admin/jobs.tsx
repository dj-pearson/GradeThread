import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Activity,
  RefreshCw,
  Loader2,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { Link } from "react-router";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/error-state";

// US-584 — admin job/queue monitoring + manual retry/cancel.
//
// US-2558: cron health and dead letters USED to be tabs here, reading
// /api/admin/jobs/crons and /api/admin/jobs/dead-letters. Both were read-only
// copies of /admin/ops/jobs and /admin/ops/dead-letters, which carry the
// actions — Run-now behind an MFA step-up, and replay/re-queue/discard. An
// operator triaging from the copy could only watch. They link out now; folding
// the ops pages in here instead would have deleted those actions.

type JobKind = "grading" | "sync" | "autolister" | "publish" | "email" | "repricing";

interface JobRow {
  kind: JobKind;
  id: string;
  label: string;
  status: string;
  user_id: string | null;
  created_at: string;
  updated_at: string | null;
  last_error: string | null;
  attempts: number | null;
  sort_ts: string;
  can_retry: boolean;
  can_cancel: boolean;
}


// US-2558: the webhook + email families are gone from here. They were the same
// two /admin/ops/dead-letters shows WITH replay, and this page could only
// display them. What is left is the pair nothing else showed at all.
interface FailedBatches {
  failed_generation_batches: Array<{ id: string; user_id: string; item_count: number; failed_count: number; error: string | null; updated_at: string }>;
  failed_publish_batches: Array<{ id: string; user_id: string; item_count: number; failed_count: number; error: string | null; updated_at: string }>;
}

const KIND_LABELS: Record<JobKind | "all", string> = {
  all: "All jobs",
  grading: "Grading",
  sync: "eBay sync",
  autolister: "AutoLister",
  publish: "Publish",
  email: "Email outbox",
  repricing: "Repricing",
};

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

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "failed":
    case "dead_letter":
    case "error":
      return "destructive";
    case "processing":
    case "running":
    case "pending":
      return "secondary";
    case "completed":
    case "success":
    case "sent":
      return "default";
    default:
      return "outline";
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function AdminJobsPage() {
  const visible = useDocumentVisible();
  const [kind, setKind] = useState<JobKind | "all">("all");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [pending, setPending] = useState<{ row: JobRow; action: "retry" | "cancel" } | null>(null);
  const [acting, setActing] = useState(false);

  const jobsQuery = useQuery({
    queryKey: ["admin-jobs", kind, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (kind !== "all") params.set("kind", kind);
      if (statusFilter) params.set("status", statusFilter);
      const qs = params.toString();
      return getJson<{ jobs: JobRow[] }>(`/api/admin/jobs${qs ? `?${qs}` : ""}`);
    },
    refetchInterval: visible ? 20_000 : false,
  });

  const batchQuery = useQuery({
    queryKey: ["admin-jobs-failed-batches"],
    queryFn: () => getJson<FailedBatches>("/api/admin/jobs/failed-batches"),
    refetchInterval: visible ? 30_000 : false,
  });

  async function runAction() {
    if (!pending) return;
    setActing(true);
    try {
      const res = await edgeFetch(`/api/admin/jobs/${pending.action}`, {
        method: "POST",
        json: { kind: pending.row.kind, id: pending.row.id },
        silentGate: true,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      toast.success(`Job ${pending.action === "retry" ? "re-queued" : "cancelled"}`);
      setPending(null);
      void jobsQuery.refetch();
      // The failed-batch list is unaffected by a retry/cancel of a JOB, so it
      // is not refetched here — it used to be, because this line named the
      // dead-letter query that lived on the removed tab.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${pending.action} failed`);
    } finally {
      setActing(false);
    }
  }

  const jobs = jobsQuery.data?.jobs ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Jobs &amp; Queues"
        subtitle="Monitor grading, sync, AutoLister, publish, email &amp; repricing jobs; retry or cancel stuck work; watch cron health."
        icon={Activity}
        actions={
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3" />
            <span>Auto-refreshes</span>
          </div>
        }
      />

      <Tabs defaultValue="jobs">
        <TabsList>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="batches">Failed batches</TabsTrigger>
        </TabsList>

        {/* ── Jobs ── */}
        <TabsContent value="jobs" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={kind} onValueChange={(v) => setKind(v as JobKind | "all")}>
              <SelectTrigger className="w-44" aria-label="Filter jobs by kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABELS) as Array<JobKind | "all">).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              aria-label="Filter jobs by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value.trim())}
              placeholder="Status filter (e.g. failed)"
              className="h-9 w-52 rounded-md border bg-background px-3 text-sm"
            />
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

          <Card>
            <CardContent className="p-0">
              {/* US-2555: error first. `jobs` derives from data react-query
                  leaves undefined on an error, so a failed read said "No jobs
                  match this view" — an outage reported as a healthy queue, on
                  the page an operator opens to check exactly that. */}
              {jobsQuery.isError ? (
                <ErrorState
                  title="Couldn't load the job queue"
                  description="This is a read failure — it says nothing about whether jobs are running."
                  onRetry={() => void jobsQuery.refetch()}
                  retrying={jobsQuery.isFetching}
                />
              ) : jobsQuery.isLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-10" />
                  ))}
                </div>
              ) : jobs.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">No jobs match this view.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kind</TableHead>
                      <TableHead>Job</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Age</TableHead>
                      <TableHead>Last error</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((j) => (
                      <TableRow key={`${j.kind}-${j.id}`}>
                        <TableCell>
                          <Badge variant="outline">{KIND_LABELS[j.kind]}</Badge>
                        </TableCell>
                        <TableCell className="max-w-xs truncate font-medium" title={j.label}>
                          {j.label}
                          {j.attempts != null && j.attempts > 0 && (
                            <span className="ml-1 text-xs text-muted-foreground">·{j.attempts} att</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(j.status)}>{j.status}</Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          {relativeAge(j.sort_ts)}
                        </TableCell>
                        <TableCell className="max-w-sm truncate text-xs text-muted-foreground" title={j.last_error ?? ""}>
                          {j.last_error ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            {j.can_retry && (
                              <Button
                              aria-label={`Retry ${j.label}`}
                                size="sm"
                                variant="outline"
                                onClick={() => setPending({ row: j, action: "retry" })}
                              >
                                <RotateCcw className="h-3.5 w-3.5" /> Retry
                              </Button>
                            )}
                            {j.can_cancel && (
                              <Button
                              aria-label={`Cancel ${j.label}`}
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                                onClick={() => setPending({ row: j, action: "cancel" })}
                              >
                                <XCircle className="h-3.5 w-3.5" /> Cancel
                              </Button>
                            )}
                            {!j.can_retry && !j.can_cancel && (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Cron health ── */}
        {/* US-2558: Cron Health and Dead Letters were READ-ONLY copies of
            /admin/ops/jobs and /admin/ops/dead-letters. The ops pages carry the
            actions — a super-admin Run-now behind an MFA step-up, and real
            replay/re-queue/discard — so triaging from the copy meant looking at
            a problem you could not touch. They link out instead of folding the
            ops pages in here, which would have deleted those actions. */}
        <TabsContent value="batches" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Elsewhere</CardTitle>
              <CardDescription>
                Cron health, webhook dead-letters and dead-lettered emails live on
                the ops pages, which can act on them.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/ops/jobs">Cron health, with Run now</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/ops/dead-letters">Dead letters, with replay</Link>
              </Button>
            </CardContent>
          </Card>

          {/* These two were already being FETCHED by this page and rendered by
              nothing — two queries every 30 seconds for a blind spot. A failed
              batch is retried by its own reclaim cron, so this stays a read. */}
          <FailedBatchCard
            title="Failed AutoLister generations"
            description="Generation batches that ended in failed. The reclaim cron retries a stalled batch; these are the ones it gave up on."
            rows={batchQuery.data?.failed_generation_batches ?? []}
            loading={batchQuery.isLoading}
          />
          <FailedBatchCard
            title="Failed publish batches"
            description="Bulk publish batches that ended in failed."
            rows={batchQuery.data?.failed_publish_batches ?? []}
            loading={batchQuery.isLoading}
          />
        </TabsContent>
      </Tabs>

      {/* Confirm dialog */}
      <Dialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending?.action === "retry" ? "Retry job?" : "Cancel job?"}
            </DialogTitle>
            <DialogDescription>
              {pending?.action === "retry"
                ? "This re-queues the job for processing."
                : "This stops the job. Cancelled grades are refunded automatically."}
              {pending && (
                <span className="mt-2 block font-medium text-foreground">{pending.row.label}</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={acting}>
              Back
            </Button>
            <Button
              variant={pending?.action === "cancel" ? "destructive" : "default"}
              onClick={() => void runAction()}
              disabled={acting}
            >
              {acting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {pending?.action === "retry" ? "Retry" : "Cancel job"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface FailedBatchRow {
  id: string;
  user_id: string;
  item_count: number;
  failed_count: number;
  error: string | null;
  updated_at: string;
}

// US-2558: replaced DeadLetterCard, which rendered webhook + email rows this
// page no longer shows. The columns are the ones an operator needs to decide
// whether a failed batch is one seller's problem or everyone's: whose it is,
// how much of it failed, and what it said.
// The batch cards take `loading` and `rows`; a failed read is passed in as
// `error` so the card can say so where its rows would have been.
function FailedBatchCard({
  title,
  description,
  rows,
  loading,
}: {
  title: string;
  description: string;
  rows: FailedBatchRow[];
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            Nothing failed — all clear.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>Age</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">{b.id.slice(0, 8)}</TableCell>
                    <TableCell>
                      <Link
                        to={`/admin/users/${b.user_id}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {b.user_id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.failed_count} of {b.item_count}
                    </TableCell>
                    <TableCell
                      className="max-w-md truncate text-xs text-muted-foreground"
                      title={b.error ?? ""}
                    >
                      {b.error ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(b.updated_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

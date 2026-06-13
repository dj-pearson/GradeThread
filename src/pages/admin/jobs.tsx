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
  AlertTriangle,
  CheckCircle2,
  Clock,
} from "lucide-react";

// US-584 — admin job/queue monitoring + manual retry/cancel + cron health.

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

interface CronRow {
  name: string;
  label: string;
  schedule: string;
  category: string;
  endpoint: string;
  recorded: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_http_status: number | null;
  last_duration_ms: number | null;
}

interface DeadLetters {
  webhooks: Array<{
    id: string;
    provider: string;
    event_id: string;
    event_type: string | null;
    error_message: string | null;
    created_at: string;
  }>;
  emails: Array<{
    id: string;
    recipient: string;
    category: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    updated_at: string;
  }>;
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

  const cronQuery = useQuery({
    queryKey: ["admin-jobs-crons"],
    queryFn: () => getJson<{ crons: CronRow[]; server_now: string }>("/api/admin/jobs/crons"),
    refetchInterval: visible ? 30_000 : false,
  });

  const deadQuery = useQuery({
    queryKey: ["admin-jobs-dead-letters"],
    queryFn: () => getJson<DeadLetters>("/api/admin/jobs/dead-letters"),
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
      void deadQuery.refetch();
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6 text-brand-red-text" />
          <div>
            <h1 className="text-2xl font-bold">Jobs &amp; Queues</h1>
            <p className="text-sm text-muted-foreground">
              Monitor grading, sync, AutoLister, publish, email &amp; repricing jobs; retry or cancel stuck work; watch cron health.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3" />
          <span>Auto-refreshes</span>
        </div>
      </div>

      <Tabs defaultValue="jobs">
        <TabsList>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="crons">Cron Health</TabsTrigger>
          <TabsTrigger value="dead">Dead Letters</TabsTrigger>
        </TabsList>

        {/* ── Jobs ── */}
        <TabsContent value="jobs" className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={kind} onValueChange={(v) => setKind(v as JobKind | "all")}>
              <SelectTrigger className="w-44">
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
              {jobsQuery.isLoading ? (
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
                                size="sm"
                                variant="outline"
                                onClick={() => setPending({ row: j, action: "retry" })}
                              >
                                <RotateCcw className="h-3.5 w-3.5" /> Retry
                              </Button>
                            )}
                            {j.can_cancel && (
                              <Button
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
        <TabsContent value="crons">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Scheduled jobs</CardTitle>
              <CardDescription>
                Last run is captured for <code>/api/jobs/*</code> crons; eBay/Google crons show schedule &amp; next run only.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {cronQuery.isLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-10" />
                  ))}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Job</TableHead>
                      <TableHead>Schedule</TableHead>
                      <TableHead>Last run</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Next run</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(cronQuery.data?.crons ?? []).map((cr) => (
                      <TableRow key={cr.name}>
                        <TableCell className="font-medium">
                          {cr.label}
                          <span className="ml-1 text-xs text-muted-foreground">{cr.category}</span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{cr.schedule}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          {cr.recorded ? relativeAge(cr.last_run_at) : <span className="italic">n/a</span>}
                        </TableCell>
                        <TableCell>
                          {cr.last_status == null ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : cr.last_status === "success" ? (
                            <span className="flex items-center gap-1 text-xs text-emerald-600">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              {cr.last_duration_ms != null ? `${cr.last_duration_ms}ms` : "ok"}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-xs text-destructive">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              {cr.last_http_status ?? cr.last_status}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          <Clock className="mr-1 inline h-3 w-3" />
                          {relativeAge(cr.next_run_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Dead letters ── */}
        <TabsContent value="dead" className="space-y-4">
          <DeadLetterCard
            title="Webhook dead-letters"
            description="Provider events that failed handling and were parked for manual replay."
            empty={(deadQuery.data?.webhooks.length ?? 0) === 0}
            loading={deadQuery.isLoading}
          >
            {(deadQuery.data?.webhooks ?? []).map((w) => (
              <TableRow key={w.id}>
                <TableCell>
                  <Badge variant="outline">{w.provider}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{w.event_type ?? w.event_id}</TableCell>
                <TableCell className="max-w-md truncate text-xs text-muted-foreground" title={w.error_message ?? ""}>
                  {w.error_message ?? "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{relativeAge(w.created_at)}</TableCell>
              </TableRow>
            ))}
          </DeadLetterCard>

          <DeadLetterCard
            title="Dead-lettered emails"
            description="Transactional emails that exhausted their retry budget."
            empty={(deadQuery.data?.emails.length ?? 0) === 0}
            loading={deadQuery.isLoading}
          >
            {(deadQuery.data?.emails ?? []).map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <Badge variant="outline">{e.category}</Badge>
                </TableCell>
                <TableCell className="text-xs">{e.recipient}</TableCell>
                <TableCell className="max-w-md truncate text-xs text-muted-foreground" title={e.last_error ?? ""}>
                  {e.last_error ?? "—"} <span className="text-muted-foreground">({e.attempts}/{e.max_attempts})</span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{relativeAge(e.updated_at)}</TableCell>
              </TableRow>
            ))}
          </DeadLetterCard>
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

function DeadLetterCard({
  title,
  description,
  empty,
  loading,
  children,
}: {
  title: string;
  description: string;
  empty: boolean;
  loading: boolean;
  children: React.ReactNode;
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
        ) : empty ? (
          <p className="p-8 text-center text-sm text-muted-foreground">Nothing parked — all clear.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Age</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{children}</TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

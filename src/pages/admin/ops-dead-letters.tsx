import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Inbox,
  RefreshCw,
  Loader2,
  Play,
  Trash2,
  AlertTriangle,
  Mail,
  Webhook,
  Eye,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

// US-882 — Unified dead-letter console. Surfaces failed webhook deliveries
// (webhook_dead_letters) and dead-lettered transactional email (email_deliveries)
// in one queue with retry (re-enqueue through the normal handler) + discard
// (permanently abandon with a required reason). Retry/discard are super-admin +
// MFA step-up server-side; bulk runs durable bounded server-side batches.

type Source = "webhook" | "email";

interface DeadLetter {
  source: Source;
  id: string;
  provider: string;
  reference: string;
  payload_preview: string;
  last_error: string | null;
  attempt_count: number;
  age_seconds: number;
  created_at: string;
  status: string;
  replayable: boolean;
}

interface DeadLetterPage {
  items: DeadLetter[];
  page: number;
  page_size: number;
  total: number;
  providers: string[];
  server_now: string;
}

const PAGE_SIZE = 50;

function relativeAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function AdminOpsDeadLettersPage() {
  const visible = useDocumentVisible();
  const [tab, setTab] = useState<"all" | Source>("all");
  const [provider, setProvider] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeadLetter | null>(null);
  const [discardTarget, setDiscardTarget] = useState<DeadLetter | "bulk" | null>(null);
  const [reason, setReason] = useState("");
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const sourceParam = tab === "all" ? "" : `&source=${tab}`;
  const providerParam = provider === "all" ? "" : `&provider=${encodeURIComponent(provider)}`;

  const query = useQuery({
    queryKey: ["admin-ops-dead-letters", tab, provider, page],
    queryFn: () =>
      getJson<DeadLetterPage>(
        `/api/admin/ops/dead-letters?page=${page}&page_size=${PAGE_SIZE}${sourceParam}${providerParam}`,
      ),
    refetchInterval: visible ? 30_000 : false,
  });

  const data = query.data;
  const items = data?.items ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  // Run an action, surfacing the MFA step-up dialog on a 403 STEP_UP_REQUIRED and
  // replaying the same action once verified (mirrors ops-jobs).
  async function withStepUp(path: string, init: RequestInit & { json?: unknown }, after: () => void) {
    const res = await edgeFetch(path, { ...init, silentGate: true });
    if (res.status === 403) {
      const j = await res.json().catch(() => ({}));
      if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
        setRetry(() => () => void runAction(path, init, after));
        setStepUpOpen(true);
        return;
      }
      toast.error((j as { error?: string })?.error ?? "Forbidden");
      return;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error((j as { error?: string })?.error ?? "Action failed");
      return;
    }
    after();
  }

  async function runAction(path: string, init: RequestInit & { json?: unknown }, after: () => void) {
    setBusy(path);
    try {
      await withStepUp(path, init, after);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  function onRetry(item: DeadLetter) {
    void runAction(
      `/api/admin/ops/dead-letters/${item.source}/${item.id}/retry`,
      { method: "POST", json: {} },
      () => {
        toast.success(item.source === "email" ? "Re-queued to the outbox" : "Replayed");
        void query.refetch();
      },
    );
  }

  function confirmDiscard() {
    const trimmed = reason.trim();
    if (!trimmed) {
      toast.error("A reason is required");
      return;
    }
    if (discardTarget === "bulk") {
      void drainBulk("discard", trimmed);
      setDiscardTarget(null);
      setReason("");
      return;
    }
    const item = discardTarget;
    if (!item) return;
    void runAction(
      `/api/admin/ops/dead-letters/${item.source}/${item.id}/discard`,
      { method: "POST", json: { reason: trimmed } },
      () => {
        toast.success("Discarded");
        void query.refetch();
      },
    );
    setDiscardTarget(null);
    setReason("");
  }

  // Drain a filtered selection through repeated bounded server-side batches. Each
  // POST processes ≤ BULK_BATCH_LIMIT rows server-side and reports how many
  // remain; we re-issue ticks until the queue is drained (capped to avoid an
  // unbounded client loop on persistent failures).
  async function drainBulk(action: "retry" | "discard", bulkReason?: string) {
    setBusy("bulk");
    let succeeded = 0;
    let failed = 0;
    try {
      for (let tick = 0; tick < 50; tick++) {
        const res = await edgeFetch("/api/admin/ops/dead-letters/bulk", {
          method: "POST",
          json: {
            action,
            ...(tab === "all" ? {} : { source: tab }),
            ...(provider === "all" ? {} : { provider }),
            ...(bulkReason ? { reason: bulkReason } : {}),
          },
          silentGate: true,
        });
        if (res.status === 403) {
          const j = await res.json().catch(() => ({}));
          if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
            setRetry(() => () => void drainBulk(action, bulkReason));
            setStepUpOpen(true);
            return;
          }
          toast.error((j as { error?: string })?.error ?? "Forbidden");
          return;
        }
        const j = (await res.json().catch(() => ({}))) as {
          processed?: number;
          succeeded?: number;
          failed?: number;
          remaining?: number;
        };
        if (!res.ok) {
          toast.error("Bulk action failed");
          return;
        }
        succeeded += j.succeeded ?? 0;
        failed += j.failed ?? 0;
        if ((j.remaining ?? 0) <= 0 || (j.processed ?? 0) === 0) break;
      }
      toast.success(`Bulk ${action}: ${succeeded} ok${failed ? `, ${failed} failed` : ""}`);
      void query.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dead-Letter Queue"
        subtitle={
          <>
            Failed webhook deliveries &amp; dead-lettered email across every provider. Inspect,
            retry, or discard — no SQL.
          </>
        }
        icon={Inbox}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">Open dead letters</CardTitle>
              <CardDescription>
                {data ? `${data.total} item${data.total === 1 ? "" : "s"} in this view` : "Loading…"}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Tabs
                value={tab}
                onValueChange={(v) => {
                  setTab(v as "all" | Source);
                  setProvider("all");
                  setPage(1);
                }}
              >
                <TabsList>
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="webhook">
                    <Webhook className="mr-1 h-3.5 w-3.5" /> Webhooks
                  </TabsTrigger>
                  <TabsTrigger value="email">
                    <Mail className="mr-1 h-3.5 w-3.5" /> Email
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <Select
                value={provider}
                onValueChange={(v) => {
                  setProvider(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-[160px]" aria-label="Filter by provider">
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  {(data?.providers ?? []).map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {items.length > 0 && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === "bulk"}
                onClick={() => void drainBulk("retry")}
              >
                {busy === "bulk" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Retry all (filtered)
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === "bulk"}
                onClick={() => {
                  setDiscardTarget("bulk");
                  setReason("");
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Discard all (filtered)
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : query.isError ? (
            <p className="p-8 text-center text-sm text-destructive">
              {(query.error as Error)?.message ?? "Failed to load dead letters."}
            </p>
          ) : items.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No open dead letters in this view. 🎉
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const rowBusy =
                    busy === `/api/admin/ops/dead-letters/${item.source}/${item.id}/retry`;
                  return (
                    <TableRow key={`${item.source}:${item.id}`}>
                      <TableCell>
                        <Badge variant="outline" className="gap-1">
                          {item.source === "email" ? (
                            <Mail className="h-3 w-3" />
                          ) : (
                            <Webhook className="h-3 w-3" />
                          )}
                          {item.source}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.provider}</TableCell>
                      <TableCell className="max-w-[220px] truncate text-sm">
                        {item.reference}
                      </TableCell>
                      <TableCell className="max-w-[260px] truncate text-xs text-destructive">
                        <AlertTriangle className="mr-1 inline h-3 w-3" />
                        {item.last_error ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {relativeAge(item.age_seconds)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" aria-label={`View details for ${item.source} ${item.id}`} onClick={() => setDetail(item)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!item.replayable || rowBusy}
                            title={item.replayable ? "Retry" : "No replay path for this provider"}
                            onClick={() => onRetry(item)}
                          >
                            {rowBusy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                            Retry
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => {
                              setDiscardTarget(item);
                              setReason("");
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
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

      {/* Payload / error detail */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detail?.reference}</DialogTitle>
            <DialogDescription>
              {detail?.source} · {detail?.provider} · {detail ? relativeAge(detail.age_seconds) : ""} old
            </DialogDescription>
          </DialogHeader>
          {detail?.last_error && (
            <div className="rounded-md bg-destructive/5 p-3 text-xs text-destructive">
              {detail.last_error}
            </div>
          )}
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
            {detail?.payload_preview}
          </pre>
        </DialogContent>
      </Dialog>

      {/* Discard (single or bulk) — reason required */}
      <Dialog open={!!discardTarget} onOpenChange={(o) => !o && setDiscardTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {discardTarget === "bulk" ? "Discard all filtered dead letters" : "Discard dead letter"}
            </DialogTitle>
            <DialogDescription>
              This permanently abandons {discardTarget === "bulk" ? "every item in the current view" : "this item"}.
              A reason is required and the action is audited.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="discard-reason">Reason</Label>
            <Textarea
              id="discard-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. superseded by a manual fix; payload no longer valid"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDiscardTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDiscard} disabled={!reason.trim()}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}

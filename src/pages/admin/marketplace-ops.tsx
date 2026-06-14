// US-898: eBay sync & conflict-resolution console (all tenants).
//
// Cross-tenant view of FlipDesk sync runs (with a config-driven STUCK flag),
// open cross-source conflicts, and orphaned eBay sales — plus the operator
// resolution actions (re-run a failed sync, accept the eBay/FlipDesk side of a
// conflict, manually match an orphan sale to an inventory item). Reads are
// admin; every mutation is super_admin + MFA step-up (enforced server-side).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  Ban,
  GitMerge,
  Link2,
  RefreshCw,
  Unplug,
  Workflow,
} from "lucide-react";

interface PageMeta {
  page: number;
  limit: number;
  total: number;
}

interface SyncRunRow {
  id: string;
  user_id: string;
  owner_email: string | null;
  marketplace: string;
  status: string;
  listings_total: number;
  listings_matched: number;
  sales_new: number;
  sales_updated: number;
  error_count: number;
  errors: unknown;
  started_at: string | null;
  finished_at: string | null;
  stuck: boolean;
}

interface SyncRunsResponse {
  runs: SyncRunRow[];
  summary: {
    running: number;
    failed: number;
    partial: number;
    stuck: number;
    stuck_threshold_min: number;
  };
  page: PageMeta;
}

interface ConflictRow {
  id: string;
  user_id: string;
  owner_email: string | null;
  listing_id: string;
  field_name: string;
  flipdesk_value: string | null;
  ebay_value: string | null;
  sheets_value: string | null;
  listing_title: string | null;
  item_title: string | null;
  detected_at: string;
}

interface ConflictsResponse {
  conflicts: ConflictRow[];
  page: PageMeta;
}

interface OrphanRow {
  id: string;
  user_id: string;
  owner_email: string | null;
  platform_order_id: string;
  ebay_item_id: string | null;
  sku: string | null;
  title: string | null;
  sale_price: number | null;
  buyer_username: string | null;
  sold_at: string | null;
  match_status: string;
  matched_item_id: string | null;
}

interface OrphansResponse {
  orphans: OrphanRow[];
  page: PageMeta;
}

// ── US-899: pipeline oversight ──
interface PipelineBatchRow {
  kind: "generation" | "publish";
  id: string;
  user_id: string;
  owner_email: string | null;
  status: string;
  item_count: number;
  succeeded_count: number;
  failed_count: number;
  error: string | null;
  updated_at: string | null;
  age_ms: number | null;
  stuck: boolean;
  can_retry: boolean;
  can_cancel: boolean;
}

interface PipelineBatchesResponse {
  batches: PipelineBatchRow[];
  page: PageMeta;
}

interface PipelineJobRow {
  id: string;
  batch_id: string;
  batch_status: string | null;
  inventory_item_id: string;
  item_title: string | null;
  user_id: string | null;
  owner_email: string | null;
  error: string | null;
  attempts: number;
  age_ms: number | null;
}

interface PipelineJobsResponse {
  jobs: PipelineJobRow[];
  page: PageMeta;
}

interface PipelineListingRow {
  id: string;
  user_id: string;
  owner_email: string | null;
  listing_title: string | null;
  inventory_item_id: string | null;
  state: "failed" | "sending";
  publish_error: string | null;
  age_ms: number | null;
}

interface PipelineListingsResponse {
  listings: PipelineListingRow[];
  page: PageMeta;
}

interface PipelineCounts {
  failedGenerationBatches: number;
  stuckGenerationBatches: number;
  failedGenerationJobs: number;
  failedPublishBatches: number;
  stuckPublishBatches: number;
  failedListings: number;
  stuckListings: number;
  total: number;
}

const LIMIT = 25;

function fmtAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ownerCell(email: string | null, userId: string) {
  return (
    <div>
      <div className="truncate">{email ?? "—"}</div>
      <div className="font-mono text-xs text-muted-foreground">{userId.slice(0, 8)}…</div>
    </div>
  );
}

function Pagination({
  page,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  if (total <= LIMIT) return null;
  return (
    <div className="mt-4 flex items-center justify-between">
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages} · {total} total
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={onPrev}>
          Previous
        </Button>
        <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function AdminMarketplaceOpsPage() {
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";
  const qc = useQueryClient();

  const [tab, setTab] = useState<"sync-runs" | "conflicts" | "orphan-sales" | "pipeline">(
    "sync-runs",
  );
  const [runPage, setRunPage] = useState(1);
  const [conflictPage, setConflictPage] = useState(1);
  const [orphanPage, setOrphanPage] = useState(1);
  const [pipelineView, setPipelineView] = useState<
    "generation-batches" | "generation-jobs" | "publish-batches" | "listings"
  >("generation-batches");
  const [genBatchPage, setGenBatchPage] = useState(1);
  const [genJobPage, setGenJobPage] = useState(1);
  const [pubBatchPage, setPubBatchPage] = useState(1);
  const [listingPage, setListingPage] = useState(1);

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const runsQuery = useQuery({
    queryKey: ["admin-marketplace-sync-runs", runPage],
    queryFn: async (): Promise<SyncRunsResponse> => {
      const res = await edgeFetch(
        `/api/admin/marketplace/sync-runs?page=${runPage}&limit=${LIMIT}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load sync runs.");
      return json;
    },
    enabled: tab === "sync-runs",
    staleTime: 30_000,
  });

  const conflictsQuery = useQuery({
    queryKey: ["admin-marketplace-conflicts", conflictPage],
    queryFn: async (): Promise<ConflictsResponse> => {
      const res = await edgeFetch(
        `/api/admin/marketplace/conflicts?page=${conflictPage}&limit=${LIMIT}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load conflicts.");
      return json;
    },
    enabled: tab === "conflicts",
    staleTime: 30_000,
  });

  const orphansQuery = useQuery({
    queryKey: ["admin-marketplace-orphans", orphanPage],
    queryFn: async (): Promise<OrphansResponse> => {
      const res = await edgeFetch(
        `/api/admin/marketplace/orphan-sales?page=${orphanPage}&limit=${LIMIT}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load orphan sales.");
      return json;
    },
    enabled: tab === "orphan-sales",
    staleTime: 30_000,
  });

  const pipelineCountsQuery = useQuery({
    queryKey: ["admin-pipeline-counts"],
    queryFn: async (): Promise<PipelineCounts> => {
      const res = await edgeFetch("/api/admin/marketplace/pipeline/counts");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load pipeline counts.");
      return json;
    },
    enabled: tab === "pipeline",
    staleTime: 30_000,
  });

  const genBatchesQuery = useQuery({
    queryKey: ["admin-pipeline-generation-batches", genBatchPage],
    queryFn: async (): Promise<PipelineBatchesResponse> => {
      const res = await edgeFetch(
        `/api/admin/marketplace/pipeline/generation-batches?page=${genBatchPage}&limit=${LIMIT}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load batches.");
      return json;
    },
    enabled: tab === "pipeline" && pipelineView === "generation-batches",
    staleTime: 30_000,
  });

  const genJobsQuery = useQuery({
    queryKey: ["admin-pipeline-generation-jobs", genJobPage],
    queryFn: async (): Promise<PipelineJobsResponse> => {
      const res = await edgeFetch(
        `/api/admin/marketplace/pipeline/generation-jobs?page=${genJobPage}&limit=${LIMIT}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load jobs.");
      return json;
    },
    enabled: tab === "pipeline" && pipelineView === "generation-jobs",
    staleTime: 30_000,
  });

  const pubBatchesQuery = useQuery({
    queryKey: ["admin-pipeline-publish-batches", pubBatchPage],
    queryFn: async (): Promise<PipelineBatchesResponse> => {
      const res = await edgeFetch(
        `/api/admin/marketplace/pipeline/publish-batches?page=${pubBatchPage}&limit=${LIMIT}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load batches.");
      return json;
    },
    enabled: tab === "pipeline" && pipelineView === "publish-batches",
    staleTime: 30_000,
  });

  const listingsQuery = useQuery({
    queryKey: ["admin-pipeline-listings", listingPage],
    queryFn: async (): Promise<PipelineListingsResponse> => {
      const res = await edgeFetch(
        `/api/admin/marketplace/pipeline/listings?page=${listingPage}&limit=${LIMIT}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load listings.");
      return json;
    },
    enabled: tab === "pipeline" && pipelineView === "listings",
    staleTime: 30_000,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["admin-marketplace-sync-runs"] });
    qc.invalidateQueries({ queryKey: ["admin-marketplace-conflicts"] });
    qc.invalidateQueries({ queryKey: ["admin-marketplace-orphans"] });
    qc.invalidateQueries({ queryKey: ["admin-marketplace-ops-counts"] });
    qc.invalidateQueries({ queryKey: ["admin-pipeline-counts"] });
    qc.invalidateQueries({ queryKey: ["admin-pipeline-generation-batches"] });
    qc.invalidateQueries({ queryKey: ["admin-pipeline-generation-jobs"] });
    qc.invalidateQueries({ queryKey: ["admin-pipeline-publish-batches"] });
    qc.invalidateQueries({ queryKey: ["admin-pipeline-listings"] });
  };

  // Step-up-aware mutation runner (mirrors the connections console).
  async function run(id: string, doFetch: () => Promise<Response>, onOk: () => void) {
    setWorkingId(id);
    try {
      const res = await doFetch();
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
          setRetry(() => () => run(id, doFetch, onOk));
          setStepUpOpen(true);
          return;
        }
        toast.error((j as { error?: string })?.error ?? "Forbidden");
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string }).error ?? "Action failed");
        return;
      }
      onOk();
    } finally {
      setWorkingId(null);
    }
  }

  const rerunSync = (row: SyncRunRow) =>
    run(
      row.id,
      () =>
        edgeFetch(`/api/admin/marketplace/sync-runs/${row.id}/rerun`, {
          method: "POST",
          silentGate: true,
        }),
      () => {
        toast.success("Re-sync started for the seller");
        invalidateAll();
      },
    );

  const resolveConflict = (row: ConflictRow, source: "ebay" | "flipdesk") =>
    run(
      row.id,
      () =>
        edgeFetch(`/api/admin/marketplace/conflicts/${row.id}/resolve`, {
          method: "POST",
          json: { source },
          silentGate: true,
        }),
      () => {
        toast.success(`Resolved — kept the ${source === "ebay" ? "eBay" : "FlipDesk"} value`);
        invalidateAll();
      },
    );

  const matchOrphan = (row: OrphanRow) => {
    const itemId = window
      .prompt(
        `Match this orphan sale to an inventory item.\n\nEnter the inventory_item_id (must belong to ${row.owner_email ?? row.user_id.slice(0, 8)}):`,
      )
      ?.trim();
    if (!itemId) return;
    run(
      row.id,
      () =>
        edgeFetch(`/api/admin/marketplace/orphan-sales/${row.id}/match`, {
          method: "POST",
          json: { inventory_item_id: itemId },
          silentGate: true,
        }),
      () => {
        toast.success("Orphan sale linked to the item");
        invalidateAll();
      },
    );
  };

  const retryBatch = (row: PipelineBatchRow) =>
    run(
      row.id,
      () =>
        edgeFetch(`/api/admin/marketplace/pipeline/${row.kind}-batches/${row.id}/retry`, {
          method: "POST",
          silentGate: true,
        }),
      () => {
        toast.success("Re-running the batch's incomplete jobs");
        invalidateAll();
      },
    );

  const cancelBatch = (row: PipelineBatchRow) => {
    const reason = window
      .prompt("Cancel this batch — fail its open jobs. Reason (optional):")
      ?.trim();
    if (reason === undefined) return; // prompt cancelled
    run(
      row.id,
      () =>
        edgeFetch(`/api/admin/marketplace/pipeline/${row.kind}-batches/${row.id}/cancel`, {
          method: "POST",
          json: { reason },
          silentGate: true,
        }),
      () => {
        toast.success("Batch cancelled");
        invalidateAll();
      },
    );
  };

  // A failed generation job's recovery is to re-run its parent batch (the US-559
  // helper re-runs only the failed/incomplete jobs in the batch).
  const retryJobBatch = (row: PipelineJobRow) =>
    run(
      row.id,
      () =>
        edgeFetch(`/api/admin/marketplace/pipeline/generation-batches/${row.batch_id}/retry`, {
          method: "POST",
          silentGate: true,
        }),
      () => {
        toast.success("Re-running the parent batch's failed jobs");
        invalidateAll();
      },
    );

  const summary = runsQuery.data?.summary;
  const pc = pipelineCountsQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Marketplace Sync &amp; Conflicts</h1>
        <p className="text-sm text-muted-foreground">
          Cross-tenant eBay sync runs, cross-source conflicts and orphaned sales — so a
          reconciliation failure never silently loses a sale or desyncs inventory.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="space-y-4">
        <TabsList>
          <TabsTrigger value="sync-runs">Sync runs</TabsTrigger>
          <TabsTrigger value="conflicts">Conflicts</TabsTrigger>
          <TabsTrigger value="orphan-sales">Orphan sales</TabsTrigger>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
        </TabsList>

        {/* ── Sync runs ── */}
        <TabsContent value="sync-runs" className="space-y-4">
          {summary && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {(
                [
                  { label: "Running", value: summary.running },
                  { label: "Failed", value: summary.failed },
                  { label: "Partial", value: summary.partial },
                  { label: `Stuck (>${summary.stuck_threshold_min}m)`, value: summary.stuck },
                ] as const
              ).map((s) => (
                <Card key={s.label}>
                  <CardContent className="p-4">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {s.label}
                    </div>
                    <div className="mt-1 text-2xl font-bold">{s.value}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <RefreshCw className="h-5 w-5" />
                Sync runs
              </CardTitle>
              <CardDescription>
                A run stuck in “running” past the threshold is flagged — re-run it to unblock.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {runsQuery.isError ? (
                <div className="py-8 text-center text-sm text-destructive">
                  Failed to load sync runs.
                </div>
              ) : runsQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : (runsQuery.data?.runs.length ?? 0) === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No sync runs.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Owner</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Listings</TableHead>
                      <TableHead>Sales</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Finished</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runsQuery.data!.runs.map((row) => {
                      const busy = workingId === row.id;
                      const canRerun = row.status === "failed" || row.status === "partial" || row.stuck;
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="max-w-[14rem]">{ownerCell(row.owner_email, row.user_id)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Badge
                                variant="outline"
                                className={
                                  row.status === "failed"
                                    ? "border-red-200 bg-red-100 text-red-800"
                                    : row.status === "partial"
                                      ? "border-amber-200 bg-amber-100 text-amber-800"
                                      : row.status === "running"
                                        ? "border-blue-200 bg-blue-100 text-blue-800"
                                        : "border-emerald-200 bg-emerald-100 text-emerald-800"
                                }
                              >
                                {row.status}
                              </Badge>
                              {row.stuck && (
                                <Badge variant="outline" className="gap-1 border-red-200 bg-red-100 text-red-800">
                                  <AlertTriangle className="h-3 w-3" />
                                  stuck
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {row.listings_matched}/{row.listings_total}
                          </TableCell>
                          <TableCell>+{row.sales_new}</TableCell>
                          <TableCell>{fmtDate(row.started_at)}</TableCell>
                          <TableCell>{fmtDate(row.finished_at)}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!isSuperAdmin || busy || !canRerun}
                              title={
                                !isSuperAdmin
                                  ? "Super admin required"
                                  : !canRerun
                                    ? "Only failed / partial / stuck runs can be re-run"
                                    : "Re-run this sync for the seller"
                              }
                              onClick={() => rerunSync(row)}
                            >
                              <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                              <span className="ml-1 hidden sm:inline">Re-run</span>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              <Pagination
                page={runPage}
                total={runsQuery.data?.page.total ?? 0}
                onPrev={() => setRunPage((p) => Math.max(1, p - 1))}
                onNext={() => setRunPage((p) => p + 1)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Conflicts ── */}
        <TabsContent value="conflicts" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GitMerge className="h-5 w-5" />
                Cross-source conflicts
              </CardTitle>
              <CardDescription>
                Where FlipDesk and eBay disagree on a field. Accept a side to apply it and pin
                the source of truth.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {conflictsQuery.isError ? (
                <div className="py-8 text-center text-sm text-destructive">
                  Failed to load conflicts.
                </div>
              ) : conflictsQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : (conflictsQuery.data?.conflicts.length ?? 0) === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No open conflicts.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Owner</TableHead>
                      <TableHead>Listing</TableHead>
                      <TableHead>Field</TableHead>
                      <TableHead>FlipDesk</TableHead>
                      <TableHead>eBay</TableHead>
                      <TableHead className="text-right">Resolve</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {conflictsQuery.data!.conflicts.map((row) => {
                      const busy = workingId === row.id;
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="max-w-[12rem]">{ownerCell(row.owner_email, row.user_id)}</TableCell>
                          <TableCell className="max-w-[12rem] truncate" title={row.listing_title ?? row.item_title ?? ""}>
                            {row.listing_title ?? row.item_title ?? "—"}
                          </TableCell>
                          <TableCell className="font-medium">{row.field_name}</TableCell>
                          <TableCell className="font-mono text-xs">{row.flipdesk_value ?? "—"}</TableCell>
                          <TableCell className="font-mono text-xs">{row.ebay_value ?? "—"}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!isSuperAdmin || busy}
                                title={isSuperAdmin ? "Keep the FlipDesk value" : "Super admin required"}
                                onClick={() => resolveConflict(row, "flipdesk")}
                              >
                                FlipDesk
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!isSuperAdmin || busy}
                                title={isSuperAdmin ? "Keep the eBay value" : "Super admin required"}
                                onClick={() => resolveConflict(row, "ebay")}
                              >
                                eBay
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              <Pagination
                page={conflictPage}
                total={conflictsQuery.data?.page.total ?? 0}
                onPrev={() => setConflictPage((p) => Math.max(1, p - 1))}
                onNext={() => setConflictPage((p) => p + 1)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Orphan sales ── */}
        <TabsContent value="orphan-sales" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Unplug className="h-5 w-5" />
                Orphaned eBay sales
              </CardTitle>
              <CardDescription>
                eBay sales the pull couldn’t match to a FlipDesk item by SKU. Match one to an
                inventory item to create the missing sale.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {orphansQuery.isError ? (
                <div className="py-8 text-center text-sm text-destructive">
                  Failed to load orphan sales.
                </div>
              ) : orphansQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : (orphansQuery.data?.orphans.length ?? 0) === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No unmatched orphan sales.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Owner</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Sold</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orphansQuery.data!.orphans.map((row) => {
                      const busy = workingId === row.id;
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="max-w-[12rem]">{ownerCell(row.owner_email, row.user_id)}</TableCell>
                          <TableCell className="max-w-[14rem] truncate" title={row.title ?? ""}>
                            {row.title ?? "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{row.sku ?? "—"}</TableCell>
                          <TableCell>{row.sale_price != null ? `$${row.sale_price}` : "—"}</TableCell>
                          <TableCell>{fmtDate(row.sold_at)}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!isSuperAdmin || busy || row.match_status === "matched"}
                              title={
                                !isSuperAdmin
                                  ? "Super admin required"
                                  : row.match_status === "matched"
                                    ? "Already matched"
                                    : "Match this sale to an inventory item"
                              }
                              onClick={() => matchOrphan(row)}
                            >
                              <Link2 className="h-3.5 w-3.5" />
                              <span className="ml-1 hidden sm:inline">Match</span>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              <Pagination
                page={orphanPage}
                total={orphansQuery.data?.page.total ?? 0}
                onPrev={() => setOrphanPage((p) => Math.max(1, p - 1))}
                onNext={() => setOrphanPage((p) => p + 1)}
              />
            </CardContent>
          </Card>
        </TabsContent>
        {/* ── Pipeline (US-899) ── */}
        <TabsContent value="pipeline" className="space-y-4">
          {pc && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {(
                [
                  { label: "Failed gen batches", value: pc.failedGenerationBatches },
                  { label: "Failed gen jobs", value: pc.failedGenerationJobs },
                  { label: "Failed publish batches", value: pc.failedPublishBatches },
                  { label: "Stuck / failed listings", value: pc.failedListings + pc.stuckListings },
                ] as const
              ).map((s) => (
                <Card key={s.label}>
                  <CardContent className="p-4">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {s.label}
                    </div>
                    <div className="mt-1 text-2xl font-bold">{s.value}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Workflow className="h-5 w-5" />
                Listing pipeline
              </CardTitle>
              <CardDescription>
                Failed or stuck AI-generation and bulk-publish work across every tenant. Re-run a
                batch's incomplete jobs or cancel a stuck batch — actions are idempotent and run
                through the same bounded publish worker.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs
                value={pipelineView}
                onValueChange={(v) => setPipelineView(v as typeof pipelineView)}
                className="space-y-4"
              >
                <TabsList>
                  <TabsTrigger value="generation-batches">Gen batches</TabsTrigger>
                  <TabsTrigger value="generation-jobs">Gen jobs</TabsTrigger>
                  <TabsTrigger value="publish-batches">Publish batches</TabsTrigger>
                  <TabsTrigger value="listings">Listings</TabsTrigger>
                </TabsList>

                {/* Generation + publish batches share a layout. */}
                {(
                  [
                    {
                      key: "generation-batches" as const,
                      query: genBatchesQuery,
                      page: genBatchPage,
                      setPage: setGenBatchPage,
                    },
                    {
                      key: "publish-batches" as const,
                      query: pubBatchesQuery,
                      page: pubBatchPage,
                      setPage: setPubBatchPage,
                    },
                  ]
                ).map(({ key, query, page, setPage }) => (
                  <TabsContent key={key} value={key}>
                    {query.isError ? (
                      <div className="py-8 text-center text-sm text-destructive">
                        Failed to load.
                      </div>
                    ) : query.isLoading ? (
                      <div className="space-y-2">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Skeleton key={i} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : (query.data?.batches.length ?? 0) === 0 ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">
                        No failed or stuck batches.
                      </div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Owner</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Progress</TableHead>
                            <TableHead>Age</TableHead>
                            <TableHead>Error</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {query.data!.batches.map((row) => {
                            const busy = workingId === row.id;
                            return (
                              <TableRow key={row.id}>
                                <TableCell className="max-w-[12rem]">
                                  {ownerCell(row.owner_email, row.user_id)}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1">
                                    <Badge
                                      variant="outline"
                                      className={
                                        row.status === "failed"
                                          ? "border-red-200 bg-red-100 text-red-800"
                                          : row.status === "partial"
                                            ? "border-amber-200 bg-amber-100 text-amber-800"
                                            : "border-blue-200 bg-blue-100 text-blue-800"
                                      }
                                    >
                                      {row.status}
                                    </Badge>
                                    {row.stuck && (
                                      <Badge
                                        variant="outline"
                                        className="gap-1 border-red-200 bg-red-100 text-red-800"
                                      >
                                        <AlertTriangle className="h-3 w-3" />
                                        stuck
                                      </Badge>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  {row.succeeded_count}/{row.item_count}
                                  {row.failed_count > 0 && (
                                    <span className="text-destructive"> · {row.failed_count} failed</span>
                                  )}
                                </TableCell>
                                <TableCell>{fmtAge(row.age_ms)}</TableCell>
                                <TableCell className="max-w-[14rem] truncate" title={row.error ?? ""}>
                                  {row.error ?? "—"}
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex justify-end gap-2">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={!isSuperAdmin || busy || !row.can_retry}
                                      title={
                                        !isSuperAdmin
                                          ? "Super admin required"
                                          : !row.can_retry
                                            ? "Nothing incomplete to re-run"
                                            : "Re-run incomplete jobs"
                                      }
                                      onClick={() => retryBatch(row)}
                                    >
                                      <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                                      <span className="ml-1 hidden sm:inline">Retry</span>
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={!isSuperAdmin || busy || !row.can_cancel}
                                      title={
                                        !isSuperAdmin
                                          ? "Super admin required"
                                          : !row.can_cancel
                                            ? "Batch is not open"
                                            : "Cancel — fail open jobs"
                                      }
                                      onClick={() => cancelBatch(row)}
                                    >
                                      <Ban className="h-3.5 w-3.5" />
                                      <span className="ml-1 hidden sm:inline">Cancel</span>
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    )}
                    <Pagination
                      page={page}
                      total={query.data?.page.total ?? 0}
                      onPrev={() => setPage((p) => Math.max(1, p - 1))}
                      onNext={() => setPage((p) => p + 1)}
                    />
                  </TabsContent>
                ))}

                {/* Generation jobs */}
                <TabsContent value="generation-jobs">
                  {genJobsQuery.isError ? (
                    <div className="py-8 text-center text-sm text-destructive">Failed to load.</div>
                  ) : genJobsQuery.isLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  ) : (genJobsQuery.data?.jobs.length ?? 0) === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      No failed generation jobs.
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Owner</TableHead>
                          <TableHead>Item</TableHead>
                          <TableHead>Attempts</TableHead>
                          <TableHead>Age</TableHead>
                          <TableHead>Error</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {genJobsQuery.data!.jobs.map((row) => {
                          const busy = workingId === row.id;
                          return (
                            <TableRow key={row.id}>
                              <TableCell className="max-w-[12rem]">
                                {ownerCell(row.owner_email, row.user_id ?? "")}
                              </TableCell>
                              <TableCell className="max-w-[12rem] truncate" title={row.item_title ?? ""}>
                                {row.item_title ?? "—"}
                              </TableCell>
                              <TableCell>{row.attempts}</TableCell>
                              <TableCell>{fmtAge(row.age_ms)}</TableCell>
                              <TableCell className="max-w-[14rem] truncate" title={row.error ?? ""}>
                                {row.error ?? "—"}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!isSuperAdmin || busy}
                                  title={
                                    isSuperAdmin
                                      ? "Re-run this job's parent batch"
                                      : "Super admin required"
                                  }
                                  onClick={() => retryJobBatch(row)}
                                >
                                  <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                                  <span className="ml-1 hidden sm:inline">Retry batch</span>
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                  <Pagination
                    page={genJobPage}
                    total={genJobsQuery.data?.page.total ?? 0}
                    onPrev={() => setGenJobPage((p) => Math.max(1, p - 1))}
                    onNext={() => setGenJobPage((p) => p + 1)}
                  />
                </TabsContent>

                {/* Listings stuck sending / failed */}
                <TabsContent value="listings">
                  {listingsQuery.isError ? (
                    <div className="py-8 text-center text-sm text-destructive">Failed to load.</div>
                  ) : listingsQuery.isLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  ) : (listingsQuery.data?.listings.length ?? 0) === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      No stuck or failed listings.
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Owner</TableHead>
                          <TableHead>Listing</TableHead>
                          <TableHead>State</TableHead>
                          <TableHead>Age</TableHead>
                          <TableHead>Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {listingsQuery.data!.listings.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="max-w-[12rem]">
                              {ownerCell(row.owner_email, row.user_id)}
                            </TableCell>
                            <TableCell className="max-w-[14rem] truncate" title={row.listing_title ?? ""}>
                              {row.listing_title ?? "—"}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={
                                  row.state === "failed"
                                    ? "border-red-200 bg-red-100 text-red-800"
                                    : "border-amber-200 bg-amber-100 text-amber-800"
                                }
                              >
                                {row.state === "failed" ? "failed" : "stuck sending"}
                              </Badge>
                            </TableCell>
                            <TableCell>{fmtAge(row.age_ms)}</TableCell>
                            <TableCell className="max-w-[16rem] truncate" title={row.publish_error ?? ""}>
                              {row.publish_error ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  <Pagination
                    page={listingPage}
                    total={listingsQuery.data?.page.total ?? 0}
                    onPrev={() => setListingPage((p) => Math.max(1, p - 1))}
                    onNext={() => setListingPage((p) => p + 1)}
                  />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}

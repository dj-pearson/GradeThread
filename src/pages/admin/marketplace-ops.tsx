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
  GitMerge,
  Link2,
  RefreshCw,
  Unplug,
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

const LIMIT = 25;

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

  const [tab, setTab] = useState<"sync-runs" | "conflicts" | "orphan-sales">("sync-runs");
  const [runPage, setRunPage] = useState(1);
  const [conflictPage, setConflictPage] = useState(1);
  const [orphanPage, setOrphanPage] = useState(1);

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

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["admin-marketplace-sync-runs"] });
    qc.invalidateQueries({ queryKey: ["admin-marketplace-conflicts"] });
    qc.invalidateQueries({ queryKey: ["admin-marketplace-orphans"] });
    qc.invalidateQueries({ queryKey: ["admin-marketplace-ops-counts"] });
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

  const summary = runsQuery.data?.summary;

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
      </Tabs>

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}

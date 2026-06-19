import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Scale,
  AlertTriangle,
  CheckCircle2,
  Upload,
  Loader2,
  FileText,
  Download,
  History,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useItemsFull } from "@/hooks/use-items-full";
import { detectDiscrepancies } from "@/lib/pnl";
import {
  useImportPayoutsCsv,
  usePayoutImports,
  useReconciliationDismiss,
  useReconciliationMatch,
  useReconciliationQueue,
  useReconciliationRun,
  type QueueEntry,
} from "@/hooks/use-payouts";
import { downloadSalesCsv } from "@/lib/csv-export";
import {
  useEbaySyncRuns,
  useSyncEbayListings,
  type EbaySyncRun,
} from "@/hooks/use-ebay";
import type { SaleRow } from "@/types/database";

const STEPS = [
  {
    title: "Ingest payout rows",
    body: "Two ingestion paths: live eBay webhooks via the edge service and CSV upload from the eBay seller dashboard. Both land in payout_imports.",
  },
  {
    title: "Auto-match to sales",
    body: "The reconciliation-matcher edge function matches payout rows to listings by listing ID and timestamp window. Matched rows update the linked sale row with per-fee breakdowns.",
  },
  {
    title: "Manual review queue",
    body: "Anything unmatched stays in a review queue with a side-by-side compare UI. Matches are an explicit user action — never silent.",
  },
];

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  // Treat ISO date as local — eBay payout dates are date-only.
  const t = new Date(`${d}T00:00:00`);
  if (Number.isNaN(t.getTime())) return d;
  return t.toLocaleDateString();
}

// Compact "2m ago" / "3h ago" / date for older runs. Used by the sync history.
function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}

// Payouts & fees tab content (CSV import, review queue, discrepancies, and the
// eBay sync history). US-963 merged the standalone Reconciliation page into the
// unified Reconcile area; this is the "Payouts & fees" tab. The eBay SKU match
// and Cross-source flows are sibling tabs rendered by FlipdeskReconcilePage.
export function ReconciliationPayoutsTab() {
  const user = useAuthStore((s) => s.user);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const importPayouts = useImportPayoutsCsv();
  const { data: payoutImports = [], isLoading: payoutsLoading } =
    usePayoutImports();
  const { data: queue = [], isLoading: queueLoading } = useReconciliationQueue();

  async function handlePayoutFile(file: File) {
    setImporting(true);
    try {
      const csv = await file.text();
      const res = await importPayouts.mutateAsync({ csv });
      const parts = [`Imported ${res.imported}`];
      if (res.duplicates > 0) parts.push(`${res.duplicates} dup${res.duplicates === 1 ? "" : "s"}`);
      if (res.skipped > 0) parts.push(`${res.skipped} skipped`);
      if (res.imported === 0 && res.duplicates > 0) {
        toast.info(parts.join(" · "));
      } else if (res.imported === 0) {
        toast.warning(`No payouts imported. ${parts.slice(1).join(" · ")}`);
      } else {
        toast.success(parts.join(" · "));
      }
    } catch {
      /* surfaced by hook */
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ["sales_all", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<SaleRow[]> => {
      const { data, error } = await supabase
        .from("sales")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SaleRow[];
    },
  });

  // Cached items_full gives us titles without another round-trip — shared
  // single source of truth across FlipDesk (US-419).
  const { data: items = [] } = useItemsFull();

  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) m.set(it.id, it.item_title);
    return m;
  }, [items]);

  const flagged = useMemo(
    () =>
      sales
        .map((s) => ({ sale: s, issues: detectDiscrepancies(s) }))
        .filter((r) => r.issues.length > 0),
    [sales],
  );

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button
          variant="outline"
          onClick={() => downloadSalesCsv(sales, titleById)}
          disabled={sales.length === 0}
        >
          <Download className="mr-2 h-4 w-4" />
          Export sales CSV
        </Button>
      </div>

      {/* CSV import */}
          <Card>
            <CardHeader>
              <CardTitle>Import payouts</CardTitle>
              <CardDescription>
                In eBay Seller Hub go to <strong>Payments → Payouts</strong>,
                pick a date range, and download the report. FlipDesk reads the
                Payout ID, date, and amount and deduplicates against your
                existing rows automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handlePayoutFile(f);
                }}
              />
              <Button
                onClick={() => fileRef.current?.click()}
                disabled={importing}
              >
                {importing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Upload payouts CSV
              </Button>
              <span className="text-xs text-muted-foreground">
                {payoutImports.length} payout
                {payoutImports.length === 1 ? "" : "s"} imported
                {payoutImports.length > 0 && (
                  <>
                    {" · "}
                    {
                      payoutImports.filter((p) => !p.reconciled).length
                    }{" "}
                    awaiting match
                  </>
                )}
              </span>
            </CardContent>
          </Card>

          {/* Recent imports preview */}
          {payoutImports.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Recent payout rows
                </CardTitle>
                <CardDescription>
                  Last 25. Use the review queue (coming next) to link each one
                  to a sale.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Payout ID</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reconciled</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payoutsLoading ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-3">
                          <LoadingRegion label="Loading payouts">
                            <SkeletonRows rows={4} />
                          </LoadingRegion>
                        </TableCell>
                      </TableRow>
                    ) : (
                      payoutImports.slice(0, 25).map((p) => {
                        const id = String(
                          (p.raw_payload as Record<string, unknown>)
                            ?.payoutid ?? "—",
                        );
                        const status =
                          (p.raw_payload as Record<string, unknown>)?.status;
                        return (
                          <TableRow key={p.id}>
                            <TableCell className="font-mono text-[11px]">
                              {id.slice(0, 18)}
                              {id.length > 18 ? "…" : ""}
                            </TableCell>
                            <TableCell>{fmtDate(p.payout_date)}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtMoney(p.amount)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {typeof status === "string" ? status : "—"}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  p.reconciled ? "default" : "secondary"
                                }
                                className="text-[10px]"
                              >
                                {p.reconciled ? "matched" : "queued"}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Review queue */}
          <ReviewQueueCard queue={queue} loading={queueLoading} />

          {/* Discrepancies */}
          <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Fee &amp; shipping discrepancies
              </CardTitle>
              <CardDescription>
                Sales where marketplace fees exceed 15% of the sale price, or
                shipping cost runs more than $2 over what the buyer paid.
              </CardDescription>
            </div>
            <Badge variant={flagged.length > 0 ? "destructive" : "outline"}>
              {flagged.length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingRegion label="Loading sales">
              <SkeletonRows rows={4} />
            </LoadingRegion>
          ) : flagged.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              No discrepancies. Fees and shipping look clean.
            </div>
          ) : (
            <ul className="space-y-2">
              {flagged.map(({ sale, issues }) => (
                <li
                  key={sale.id}
                  className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">
                      {titleById.get(sale.inventory_item_id) ?? "Item"}
                    </div>
                    <div className="font-mono text-xs tabular-nums text-muted-foreground">
                      Sold ${(sale.sale_price ?? 0).toFixed(2)}
                    </div>
                  </div>
                  {issues.map((d, i) => (
                    <div
                      key={i}
                      className="mt-1 text-xs text-destructive"
                    >
                      • {d}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How reconciliation works</CardTitle>
          <CardDescription>
            The flow runs in the consolidated edge service. Imports never
            auto-apply without a recorded match.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-xs font-bold text-white">
                  {i + 1}
                </div>
                <div>
                  <div className="font-semibold">{step.title}</div>
                  <div className="text-sm text-muted-foreground">
                    {step.body}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
          </Card>

      {/* eBay sync history — stats from each background pull, newest first. */}
      <SyncHistoryCard />
    </div>
  );
}

// Maps a run status to its badge presentation.
function runStatusBadge(status: EbaySyncRun["status"]) {
  switch (status) {
    case "success":
      return {
        label: "Success",
        className: "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
        Icon: CheckCircle2,
      };
    case "partial":
      return {
        label: "Partial",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        Icon: AlertTriangle,
      };
    case "failed":
      return {
        label: "Failed",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
        Icon: XCircle,
      };
    default:
      return {
        label: "Running",
        className: "border-muted-foreground/30 bg-muted text-muted-foreground",
        Icon: Loader2,
      };
  }
}

// eBay sync history — one row per background pull, newest first. Surfaces the
// stats the sync computes (listings pulled/matched, sales created/updated,
// fee enrichment, errors) which were previously only in the container logs.
function SyncHistoryCard() {
  const { data: runs = [], isLoading, isFetching, refetch } = useEbaySyncRuns();
  const sync = useSyncEbayListings();

  // US-457: a run stuck in 'running' (e.g. a crashed worker) shouldn't block the
  // UI. The server's claim-lock reclaims a stale 'running' row, so "Sync now"
  // stays enabled; we just flag the stale run so the user knows it's recoverable.
  const latest = runs[0];
  const STUCK_MS = 10 * 60_000;
  const latestStuck =
    latest?.status === "running" &&
    Date.now() - new Date(latest.started_at).getTime() > STUCK_MS;

  async function handleSyncNow() {
    try {
      await sync.mutateAsync();
      // The pull runs in the background (202); give it a moment, then refresh
      // the history so the new 'running' row appears.
      window.setTimeout(() => void refetch(), 1500);
      toast.success("Sync started — results land here in ~1–2 minutes.");
    } catch {
      /* surfaced by the hook's onError toast */
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4" />
              eBay sync history
            </CardTitle>
            <CardDescription>
              Stats from each background sync. Start one here or from the{" "}
              <strong>Marketplaces</strong> page — results land when it finishes
              (a sync takes ~1–2 minutes).
              {latestStuck && (
                <span className="mt-1 block text-amber-600 dark:text-amber-400">
                  The last sync looks stuck — running another will reclaim it.
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void handleSyncNow()}
              disabled={sync.isPending}
            >
              <RefreshCw
                className={`mr-2 h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`}
              />
              Sync now
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCw
                className={`mr-2 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {isLoading ? (
          <LoadingRegion label="Loading sync history" className="px-4">
            <SkeletonRows rows={5} />
          </LoadingRegion>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-8 text-center text-sm text-muted-foreground">
            <History className="h-5 w-5 opacity-50" />
            No syncs yet. Run one from the Marketplaces page and its stats will
            show up here.
          </div>
        ) : (
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Listings</TableHead>
                <TableHead className="text-right">Matched</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Fees synced</TableHead>
                <TableHead className="text-right">Issues</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const badge = runStatusBadge(run.status);
                const salesTouched = run.sales_new + run.sales_updated;
                return (
                  <TableRow key={run.id}>
                    <TableCell
                      className="whitespace-nowrap text-muted-foreground"
                      title={new Date(run.started_at).toLocaleString()}
                    >
                      {fmtRelative(run.started_at)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`gap-1 text-[10px] ${badge.className}`}
                      >
                        <badge.Icon
                          className={`h-3 w-3 ${run.status === "running" ? "animate-spin" : ""}`}
                        />
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {run.listings_total}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className="text-emerald-700 dark:text-emerald-300">
                        {run.listings_matched}
                      </span>
                      {run.listings_unmatched > 0 && (
                        <span className="text-muted-foreground">
                          {" "}
                          / {run.listings_unmatched} new
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {salesTouched > 0 || (run.sales_reversed ?? 0) > 0 ? (
                        <span
                          title={`${run.sales_new} new · ${run.sales_updated} updated${
                            (run.sales_reversed ?? 0) > 0
                              ? ` · ${run.sales_reversed} cancelled/returned`
                              : ""
                          }`}
                        >
                          {run.sales_new > 0 && (
                            <span className="text-emerald-700 dark:text-emerald-300">
                              +{run.sales_new}
                            </span>
                          )}
                          {run.sales_new > 0 && run.sales_updated > 0 && " "}
                          {run.sales_updated > 0 && (
                            <span className="text-muted-foreground">
                              ~{run.sales_updated}
                            </span>
                          )}
                          {(run.sales_reversed ?? 0) > 0 && (
                            <>
                              {(run.sales_new > 0 || run.sales_updated > 0) && " "}
                              <span className="text-rose-700 dark:text-rose-300">
                                -{run.sales_reversed}
                              </span>
                            </>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {run.sales_enriched > 0 ? run.sales_enriched : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.error_count > 0 ? (
                        <span
                          className="text-destructive"
                          title={run.errors.slice(0, 5).join("\n")}
                        >
                          {run.error_count}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
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
  );
}

function ReviewQueueCard({
  queue,
  loading,
}: {
  queue: QueueEntry[];
  loading: boolean;
}) {
  const matchMutation = useReconciliationMatch();
  const dismissMutation = useReconciliationDismiss();
  const runMutation = useReconciliationRun();
  const [busyPayoutId, setBusyPayoutId] = useState<string | null>(null);

  async function doAutoMatch() {
    try {
      const r = await runMutation.mutateAsync();
      const parts: string[] = [];
      parts.push(`Auto-matched ${r.auto_matched}`);
      if (r.ambiguous > 0) parts.push(`${r.ambiguous} ambiguous`);
      if (r.no_candidates > 0) parts.push(`${r.no_candidates} no match`);
      if (r.auto_matched === 0) {
        toast.warning(parts.join(" · "), { duration: 10_000 });
      } else {
        toast.success(parts.join(" · "), { duration: 8_000 });
      }
    } catch {
      /* surfaced by hook */
    }
  }

  async function doMatch(payoutId: string, saleId: string) {
    setBusyPayoutId(payoutId);
    try {
      await matchMutation.mutateAsync({
        payoutImportId: payoutId,
        saleId,
      });
      toast.success("Payout linked to sale.");
    } catch (err) {
      const e = err as Error & {
        status?: number;
        existingPayoutReference?: string;
      };
      if (e.status === 409 && e.existingPayoutReference) {
        toast.error(
          `Sale already linked to payout ${e.existingPayoutReference.slice(0, 18)}…. Un-match it first.`,
          { duration: 12_000 },
        );
      } else {
        toast.error(e.message);
      }
    } finally {
      setBusyPayoutId(null);
    }
  }

  async function doDismiss(payoutId: string) {
    setBusyPayoutId(payoutId);
    try {
      await dismissMutation.mutateAsync({ payoutImportId: payoutId });
      toast.success("Payout dismissed.");
    } catch {
      /* surfaced by the hook's onError */
    } finally {
      setBusyPayoutId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-4 w-4" />
              Review queue
            </CardTitle>
            <CardDescription>
              Unreconciled payouts with the closest candidate sales scored by
              amount + date. Match or dismiss each row, or auto-match the
              clearly-unambiguous ones.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={queue.length > 0 ? "destructive" : "outline"}>
              {queue.length}
            </Badge>
            {queue.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={doAutoMatch}
                disabled={runMutation.isPending}
              >
                {runMutation.isPending ? (
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-3 w-3" />
                )}
                Auto-match
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <LoadingRegion label="Loading queue">
            <SkeletonRows rows={4} />
          </LoadingRegion>
        ) : queue.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            All payouts are reconciled.
          </div>
        ) : (
          queue.map((entry) => {
            const isBusy = busyPayoutId === entry.payout_import.id;
            return (
              <div
                key={entry.payout_import.id}
                className="rounded-lg border bg-card p-3 space-y-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-3">
                    <span className="text-sm font-semibold tabular-nums">
                      {fmtMoney(entry.payout_import.amount)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {fmtDate(entry.payout_import.payout_date)}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {String(
                        entry.payout_import.raw_payload?.payoutid ?? "—",
                      ).slice(0, 22)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {entry.candidates.length} candidate
                      {entry.candidates.length === 1 ? "" : "s"}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[10px]"
                      onClick={() => doDismiss(entry.payout_import.id)}
                      disabled={isBusy}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>

                {entry.candidates.length === 0 ? (
                  <div className="rounded border border-dashed py-3 text-center text-xs text-muted-foreground">
                    No candidate sales within tolerance. Dismiss if this payout
                    doesn&apos;t correspond to a tracked sale.
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {entry.candidates.map((c) => (
                      <li
                        key={c.sale_id}
                        className="flex items-center gap-3 rounded border bg-background p-2 text-xs"
                      >
                        <div className="w-10 shrink-0 text-right font-mono tabular-nums text-brand-navy dark:text-foreground">
                          {(c.score * 100).toFixed(0)}%
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {c.item_title ?? "Untitled item"}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {c.reasons.join(" · ")}
                          </div>
                        </div>
                        <div className="text-right tabular-nums">
                          <div className="font-semibold">
                            {fmtMoney(c.payout_amount ?? c.sale_price)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {fmtDate(c.sale_date)}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          className="h-7 px-2 text-[10px]"
                          onClick={() => doMatch(entry.payout_import.id, c.sale_id)}
                          disabled={isBusy}
                        >
                          {isBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            "Match"
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

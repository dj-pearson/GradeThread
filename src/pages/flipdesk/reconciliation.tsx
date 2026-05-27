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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EbaySkuMatch } from "@/components/flipdesk/ebay-sku-match";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
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
import type { SaleRow, ItemFullRow } from "@/types/database";

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

export function FlipdeskReconciliationPage() {
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

  // Cached items_full gives us titles without another round-trip.
  const { data: items = [] } = useQuery({
    queryKey: ["items_full", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ItemFullRow[]> => {
      const { data, error } = await (
        supabase.from as unknown as (
          name: "items_full",
        ) => {
          select: (cols: string) => {
            order: (
              col: string,
              opts?: { ascending?: boolean },
            ) => Promise<{ data: ItemFullRow[] | null; error: Error | null }>;
          };
        }
      )("items_full")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

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
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
          <Scale className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Close the loop between eBay and FlipDesk — SKUs, payouts, and
            per-item profit.
          </p>
        </div>
      </div>

      <Tabs defaultValue="ebay">
        <TabsList>
          <TabsTrigger value="ebay">eBay SKU match</TabsTrigger>
          <TabsTrigger value="payouts">Payouts &amp; fees</TabsTrigger>
        </TabsList>

        <TabsContent value="ebay" className="mt-6">
          <EbaySkuMatch />
        </TabsContent>

        <TabsContent value="payouts" className="mt-6 space-y-6">
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
                        <TableCell colSpan={5} className="text-center py-6">
                          Loading…
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
            <div className="py-6 text-center text-sm text-muted-foreground">
              Loading sales…
            </div>
          ) : flagged.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
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
        </TabsContent>
      </Tabs>
    </div>
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
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading queue…
          </div>
        ) : queue.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
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
                        <div className="w-10 shrink-0 text-right font-mono tabular-nums text-brand-navy">
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

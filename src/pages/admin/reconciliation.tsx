import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { AdminSavedViews } from "@/components/admin/admin-saved-views";
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
import {
  AlertTriangle,
  CreditCard,
  Loader2,
  Mail,
  RefreshCcw,
  RefreshCw,
  Scale,
} from "lucide-react";

// ── US-893: Stripe reconciliation & dunning console ──────────────────
//
// Operator surface for revenue leaks: past-due/paused accounts, recent failed
// invoices, and Stripe-vs-DB subscription divergences precomputed by the
// scheduled billing-reconciliation job. Per-account recovery: re-sync from live
// Stripe state, send a dunning nudge, or mark a divergence resolved. Every write
// is audited + MFA-step-up gated server-side; this UI just retries after the
// step-up dialog.

interface PastDueRow {
  id: string;
  email: string;
  full_name: string | null;
  flipdesk_plan: string | null;
  subscription_status: string | null;
  past_due_since: string | null;
  flipdesk_period_end: string | null;
  flipdesk_subscription_id: string | null;
  stripe_customer_id: string | null;
}

interface FailedInvoiceRow {
  id: string;
  user_id: string;
  email: string | null;
  created_at: string;
  detail: Record<string, unknown>;
}

interface DivergenceRow {
  id: string;
  subject_user_id: string;
  kind: string;
  db_status: string | null;
  expected_status: string | null;
  db_plan: string | null;
  expected_plan: string | null;
  latest_event_type: string | null;
  detail: { email?: string; reasons?: string[] } & Record<string, unknown>;
  detected_at: string;
  last_seen_at: string;
}

interface ReconciliationResponse {
  pastDue: { data: PastDueRow[]; total: number; limit: number; offset: number };
  failedInvoices: FailedInvoiceRow[];
  divergences: { data: DivergenceRow[]; total: number };
  lastScanAt: string | null;
}

const PAGE_SIZE = 25;

function statusBadge(status: string | null) {
  if (status === "past_due") return <Badge variant="destructive">Past due</Badge>;
  if (status === "paused")
    return (
      <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
        Paused
      </Badge>
    );
  return <Badge variant="outline">{status ?? "—"}</Badge>;
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export function AdminReconciliationPage() {
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["admin-reconciliation", offset],
    queryFn: async (): Promise<ReconciliationResponse> => {
      const res = await edgeFetch(
        `/api/admin/billing/reconciliation?limit=${PAGE_SIZE}&offset=${offset}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load reconciliation data");
      return json as ReconciliationResponse;
    },
    staleTime: 30_000,
  });

  // Step-up: remember the action to retry after the authenticator dialog. Track
  // the busy row so per-row buttons spin independently.
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const pendingAction = useRef<null | (() => void)>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["admin-reconciliation"] });
  }

  // Generic audited-write runner with step-up retry.
  async function runAction(
    key: string,
    path: string,
    successMsg: string,
    retry: () => void,
  ) {
    setBusyKey(key);
    try {
      const res = await edgeFetch(path, { method: "POST", silentGate: true });
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        if (body?.code === "STEP_UP_REQUIRED") {
          pendingAction.current = retry;
          setStepUpOpen(true);
          return;
        }
        throw new Error(body?.error ?? "Forbidden");
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Action failed");
      toast.success(successMsg);
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyKey(null);
    }
  }

  const resync = (userId: string) =>
    runAction(
      `resync:${userId}`,
      `/api/admin/billing/reconciliation/users/${userId}/resync`,
      "Re-synced from Stripe.",
      () => void resync(userId),
    );
  const dunning = (userId: string) =>
    runAction(
      `dunning:${userId}`,
      `/api/admin/billing/reconciliation/users/${userId}/dunning-email`,
      "Dunning email sent.",
      () => void dunning(userId),
    );
  const resolveFlag = (flagId: string) =>
    runAction(
      `flag:${flagId}`,
      `/api/admin/billing/reconciliation/flags/${flagId}/resolve`,
      "Divergence marked resolved.",
      () => void resolveFlag(flagId),
    );

  const pastDue = data?.pastDue;
  const pastDueTotal = pastDue?.total ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Scale className="h-6 w-6 text-brand-red-text" />
          <div>
            <h1 className="text-2xl font-bold">Stripe Reconciliation &amp; Dunning</h1>
            <p className="text-sm text-muted-foreground">
              Past-due accounts, failed invoices, and Stripe-vs-DB divergences —
              with re-sync, dunning, and resolve actions.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {data?.lastScanAt && (
            <span className="text-xs text-muted-foreground">
              Last scan: {fmtDate(data.lastScanAt)}
            </span>
          )}
          <AdminSavedViews
            surface="reconciliation"
            currentFilter={{}}
            onApply={() => setOffset(0)}
          />
          <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-red-600 dark:text-red-400">
            {error instanceof Error ? error.message : "Failed to load reconciliation data"}
          </CardContent>
        </Card>
      )}

      {/* ── Divergences (precomputed by the scheduled job) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Stripe-vs-DB divergences
            {data && data.divergences.total > 0 && (
              <Badge variant="destructive">{data.divergences.total}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Accounts whose cached status/plan disagrees with the latest recorded
            Stripe event (likely a missed webhook). Re-sync pulls live state from
            Stripe; resolve clears a false positive.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !data || data.divergences.data.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No open divergences. 🎉
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Divergence</TableHead>
                    <TableHead>Latest event</TableHead>
                    <TableHead>Detected</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.divergences.data.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="text-xs">
                        {d.detail?.email ?? d.subject_user_id}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="space-y-0.5">
                          <div>
                            <span className="text-muted-foreground">status:</span>{" "}
                            <span className="font-mono">{d.db_status ?? "—"}</span> →{" "}
                            <span className="font-mono font-semibold">{d.expected_status ?? "—"}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">plan:</span>{" "}
                            <span className="font-mono">{d.db_plan ?? "—"}</span> →{" "}
                            <span className="font-mono font-semibold">{d.expected_plan ?? "—"}</span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {d.latest_event_type ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {fmtDate(d.detected_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void resync(d.subject_user_id)}
                            disabled={busyKey !== null}
                          >
                            {busyKey === `resync:${d.subject_user_id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3.5 w-3.5" />
                            )}
                            <span className="ml-1">Re-sync</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void resolveFlag(d.id)}
                            disabled={busyKey !== null}
                          >
                            {busyKey === `flag:${d.id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              "Resolve"
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Past-due / paused accounts (paginated) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            Past-due &amp; paused accounts
            {pastDueTotal > 0 && <Badge variant="secondary">{pastDueTotal}</Badge>}
          </CardTitle>
          <CardDescription>
            Subscriptions in dunning or paused. Re-sync to reconcile from Stripe,
            or send a dunning nudge to recover the payment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !pastDue || pastDue.data.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No past-due or paused accounts.
            </p>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Past due since</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pastDue.data.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="text-xs">{u.email}</TableCell>
                        <TableCell className="text-xs capitalize">{u.flipdesk_plan ?? "—"}</TableCell>
                        <TableCell>{statusBadge(u.subscription_status)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {fmtDate(u.past_due_since)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void resync(u.id)}
                              disabled={busyKey !== null}
                            >
                              {busyKey === `resync:${u.id}` ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                              )}
                              <span className="ml-1">Re-sync</span>
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void dunning(u.id)}
                              disabled={busyKey !== null}
                            >
                              {busyKey === `dunning:${u.id}` ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Mail className="h-3.5 w-3.5" />
                              )}
                              <span className="ml-1">Dunning</span>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {pastDueTotal > PAGE_SIZE && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {offset + 1}–{Math.min(offset + PAGE_SIZE, pastDueTotal)} of {pastDueTotal}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset((o) => Math.max(o - PAGE_SIZE, 0))}
                      disabled={offset === 0 || isFetching}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset((o) => o + PAGE_SIZE)}
                      disabled={offset + PAGE_SIZE >= pastDueTotal || isFetching}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Recent failed invoices ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            Recent failed invoices
          </CardTitle>
          <CardDescription>
            Failed-payment events recorded in the last 30 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !data || data.failedInvoices.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No failed invoices in the last 30 days.
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.failedInvoices.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="text-xs">{f.email ?? f.user_id}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {fmtDate(f.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void dunning(f.user_id)}
                          disabled={busyKey !== null}
                        >
                          {busyKey === `dunning:${f.user_id}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Mail className="h-3.5 w-3.5" />
                          )}
                          <span className="ml-1">Dunning</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step-up re-auth, then retry the pending action. */}
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          const action = pendingAction.current;
          pendingAction.current = null;
          if (action) action();
        }}
      />
    </div>
  );
}

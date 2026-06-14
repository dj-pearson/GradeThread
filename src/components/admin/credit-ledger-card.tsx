import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import type { GradeCreditReason } from "@/types/database";
import {
  AlertTriangle,
  Coins,
  Loader2,
  Minus,
  Plus,
  RefreshCcw,
  RotateCcw,
} from "lucide-react";

// ── CreditLedgerCard (US-892) ────────────────────────────────────
//
// Embedded in /admin/users/:id. Inspect the append-only grade-credit ledger and
// issue an audited manual credit / debit / correction, or a Stripe pack refund
// that writes the offsetting ledger row in one idempotent flow. Extends the
// comp-credits / charge-refund actions in BillingActionsCard — this is the read
// surface plus the signed adjustments those endpoints can't express.

interface LedgerRow {
  id: string;
  delta: number;
  reason: GradeCreditReason;
  balance_after: number | null;
  submission_id: string | null;
  stripe_payment_intent_id: string | null;
  notes: string | null;
  idempotency_key: string | null;
  created_at: string;
}

interface LedgerResponse {
  user: { id: string; email: string; grade_credit_balance: number };
  data: LedgerRow[];
  page: { limit: number; offset: number; total: number };
  invariant_ok: boolean | null;
}

const PAGE_SIZE = 25;

const REASON_LABELS: Record<GradeCreditReason, string> = {
  pack_purchase: "Pack purchase",
  grade_debit: "Grade debit",
  included_grant: "Included grade",
  admin_grant: "Admin grant",
  refund: "Refund",
  expiration: "Expiration",
  correction: "Correction",
};

interface CreditLedgerCardProps {
  userId: string;
}

export function CreditLedgerCard({ userId }: CreditLedgerCardProps) {
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);

  const ledger = useQuery({
    queryKey: ["admin-credit-ledger", userId, offset],
    queryFn: async (): Promise<LedgerResponse> => {
      const res = await edgeFetch(
        `/api/admin/billing/users/${userId}/ledger?limit=${PAGE_SIZE}&offset=${offset}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load ledger.");
      return json;
    },
    staleTime: 30_000,
  });

  // ── Adjustment form ──
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [reason, setReason] = useState<"admin_grant" | "correction" | "refund">("admin_grant");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [adjusting, setAdjusting] = useState(false);

  // ── Pack refund ──
  const [chargeId, setChargeId] = useState("");
  const [refunding, setRefunding] = useState(false);

  // Step-up: remember which action to retry after the authenticator dialog.
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const pendingAction = useRef<null | (() => void)>(null);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["admin-credit-ledger", userId] });
    qc.invalidateQueries({ queryKey: ["admin-user-detail", userId] });
  }

  async function submitAdjust() {
    const num = Number.parseInt(amount, 10);
    if (!Number.isInteger(num) || num <= 0) {
      toast.error("Enter a positive whole number of credits.");
      return;
    }
    if (!notes.trim()) {
      toast.error("A reason note is required.");
      return;
    }
    const delta = direction === "add" ? num : -num;
    setAdjusting(true);
    try {
      const res = await edgeFetch(`/api/admin/billing/users/${userId}/adjust`, {
        method: "POST",
        json: { delta, reason, notes: notes.trim() },
        silentGate: true,
      });
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        if (body?.code === "STEP_UP_REQUIRED") {
          pendingAction.current = () => void submitAdjust();
          setStepUpOpen(true);
          return;
        }
        throw new Error(body?.error ?? "Forbidden");
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to adjust credits.");
      toast.success(
        `Adjusted by ${delta > 0 ? "+" : ""}${delta}. New balance: ${json.newBalance}.`,
      );
      setAmount("");
      setNotes("");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to adjust credits.");
    } finally {
      setAdjusting(false);
    }
  }

  async function submitRefundPack() {
    const id = chargeId.trim();
    if (!id) {
      toast.error("Enter a Stripe charge id (ch_…).");
      return;
    }
    setRefunding(true);
    try {
      const res = await edgeFetch(`/api/admin/billing/users/${userId}/refund-pack`, {
        method: "POST",
        json: { charge_id: id },
        silentGate: true,
      });
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        if (body?.code === "STEP_UP_REQUIRED") {
          pendingAction.current = () => void submitRefundPack();
          setStepUpOpen(true);
          return;
        }
        throw new Error(body?.error ?? "Forbidden");
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Pack refund failed.");
      toast.success(
        `Refunded. Clawed back ${json.revoked} credit(s)` +
          (json.shortfall ? `, ${json.shortfall} already spent.` : "."),
      );
      setChargeId("");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pack refund failed.");
    } finally {
      setRefunding(false);
    }
  }

  const rows = ledger.data?.data ?? [];
  const total = ledger.data?.page.total ?? 0;
  const balance = ledger.data?.user.grade_credit_balance;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5" />
          Credits &amp; Ledger
        </CardTitle>
        <CardDescription>
          Append-only grade-credit ledger. Manual adjustments and pack refunds are
          audited, require a fresh authenticator confirmation, and keep the wallet
          balance consistent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ── Balance + invariant ── */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Current balance</p>
            <p className="mt-0.5 text-2xl font-bold">
              {balance === undefined ? "—" : balance}
            </p>
          </div>
          {ledger.data?.invariant_ok === true && (
            <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300">
              Ledger consistent
            </Badge>
          )}
          {ledger.data?.invariant_ok === false && (
            <Badge variant="destructive">
              <AlertTriangle className="mr-1 h-3 w-3" />
              Ledger drift detected
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => ledger.refetch()}
            disabled={ledger.isFetching}
          >
            <RefreshCcw className={`mr-2 h-3.5 w-3.5 ${ledger.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* ── Manual adjustment ── */}
        <section className="space-y-3">
          <div className="text-sm font-semibold">Manual adjustment</div>
          <div className="grid gap-2 sm:grid-cols-[140px_160px_110px_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label className="text-xs">Direction</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as "add" | "remove")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="add">Add credits</SelectItem>
                  <SelectItem value="remove">Remove credits</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as typeof reason)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin_grant">Admin grant</SelectItem>
                  <SelectItem value="correction">Correction</SelectItem>
                  <SelectItem value="refund">Refund</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Credits</Label>
              <Input
                type="number"
                min="1"
                max="10000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Note (required)</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. goodwill credit for support ticket #1234"
              />
            </div>
            <Button onClick={() => void submitAdjust()} disabled={adjusting || !amount || !notes.trim()}>
              {adjusting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : direction === "add" ? (
                <Plus className="mr-2 h-4 w-4" />
              ) : (
                <Minus className="mr-2 h-4 w-4" />
              )}
              Apply
            </Button>
          </div>
        </section>

        <Separator />

        {/* ── Pack refund ── */}
        <section className="space-y-3">
          <div className="text-sm font-semibold">Refund a credit-pack charge</div>
          <p className="text-xs text-muted-foreground">
            Issues the Stripe refund AND the offsetting ledger reversal in one
            idempotent flow. Copy the charge id (ch_…) from Recent Stripe charges
            above. Subscription charges use Recent charges → Refund instead.
          </p>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label className="text-xs">Stripe charge id</Label>
              <Input
                value={chargeId}
                onChange={(e) => setChargeId(e.target.value)}
                placeholder="ch_..."
              />
            </div>
            <Button
              variant="destructive"
              onClick={() => void submitRefundPack()}
              disabled={refunding || !chargeId.trim()}
            >
              {refunding ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              Refund pack
            </Button>
          </div>
        </section>

        <Separator />

        {/* ── Ledger table ── */}
        <section className="space-y-3">
          <div className="text-sm font-semibold">
            Transactions{total > 0 ? ` (${total})` : ""}
          </div>
          {ledger.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : ledger.error ? (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" />
              {(ledger.error as Error).message}
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transactions yet.</p>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead className="text-right">Δ</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {new Date(r.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {REASON_LABELS[r.reason] ?? r.reason}
                          </Badge>
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono font-semibold ${
                            r.delta > 0
                              ? "text-green-600 dark:text-green-400"
                              : r.delta < 0
                                ? "text-red-600 dark:text-red-400"
                                : "text-muted-foreground"
                          }`}
                        >
                          {r.delta > 0 ? `+${r.delta}` : r.delta}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {r.balance_after ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                          {r.notes ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {total > PAGE_SIZE && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset((o) => Math.max(o - PAGE_SIZE, 0))}
                      disabled={offset === 0 || ledger.isFetching}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset((o) => o + PAGE_SIZE)}
                      disabled={offset + PAGE_SIZE >= total || ledger.isFetching}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </CardContent>

      {/* Step-up re-auth for adjust / pack-refund, then retry the pending action. */}
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          const action = pendingAction.current;
          pendingAction.current = null;
          if (action) action();
        }}
      />
    </Card>
  );
}

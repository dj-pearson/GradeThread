import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Users,
  Plus,
  Pencil,
  Loader2,
  PenLine,
  CreditCard,
  Banknote,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  LoadingRegion,
  SkeletonRows,
  TableLoadingSkeleton,
} from "@/components/ui/skeletons";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { edgeFetch } from "@/lib/edge-fetch";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  useConsignors,
  useConsignorPayouts,
  type ConsignorWithPnl,
} from "@/hooks/use-consignors";
import {
  CONSIGNOR_STATUSES,
  CONSIGNOR_STATUS_LABELS,
  CONSIGNOR_PAYOUT_STATUS_LABELS,
} from "@/lib/constants";
import type { ConsignorStatus } from "@/types/database";
import { PageHelp } from "@/components/help/page-help";
import { Term } from "@/components/help/term";

function money(n: number | null | undefined): string {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

// US-1123: signed delta (reconciled actual − estimate) for the discrepancy hint.
function signedMoney(n: number | null | undefined): string {
  const v = Number(n) || 0;
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
}

interface FormState {
  id: string | null;
  name: string;
  email: string;
  phone: string;
  split_pct: string;
  status: ConsignorStatus;
  notes: string;
}

const EMPTY: FormState = {
  id: null,
  name: "",
  email: "",
  phone: "",
  split_pct: "50",
  status: "active",
  notes: "",
};

export function FlipdeskConsignmentPage() {
  const { can } = useWorkspace();
  const qc = useQueryClient();
  const { data: consignors = [], isLoading, error } = useConsignors();

  const [editing, setEditing] = useState<FormState | null>(null);
  const [intakeFor, setIntakeFor] = useState<ConsignorWithPnl | null>(null);
  const [payFor, setPayFor] = useState<ConsignorWithPnl | null>(null);
  const [historyFor, setHistoryFor] = useState<ConsignorWithPnl | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canManage = can("manage_inventory");

  const totals = useMemo(() => {
    let owed = 0;
    let gross = 0;
    let paid = 0;
    let shareDelta = 0;
    let unreconciled = 0;
    for (const c of consignors) {
      owed += Number(c.pnl?.balance_owed ?? 0);
      gross += Number(c.pnl?.gross_revenue ?? 0);
      paid += Number(c.pnl?.payouts_paid ?? 0);
      shareDelta += Number(c.pnl?.consignor_share_delta ?? 0);
      unreconciled += Number(c.pnl?.items_unreconciled ?? 0);
    }
    return { owed, gross, paid, shareDelta, unreconciled };
  }, [consignors]);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["consignors"] });
    void qc.invalidateQueries({ queryKey: ["consignor-payouts"] });
  }

  async function startConnect(c: ConsignorWithPnl) {
    setBusyId(c.id);
    try {
      const res = await edgeFetch(
        `/api/flipdesk/consignment/consignors/${c.id}/connect`,
        { method: "POST", json: {} },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) {
        throw new Error(body.error ?? "Could not start Stripe onboarding");
      }
      window.location.href = body.url as string;
    } catch (err) {
      toastError(err, "Onboarding failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Users}
        title="Consignment"
        subtitle={
          <>
            <Term name="Consignment" /> means selling someone else's garment and
            splitting the money. Manage consignors, splits, agreements and
            payouts here.
          </>
        }
        actions={
          <>
            <PageHelp slug="taking-in-consignment" />
            <Button onClick={() => setEditing({ ...EMPTY })} disabled={!canManage}>
              <Plus className="mr-2 h-4 w-4" />
              New consignor
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Gross consigned sales</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {money(totals.gross)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Paid to consignors</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {money(totals.paid)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Balance owed</CardDescription>
            <CardTitle className="text-2xl tabular-nums text-brand-red-text">
              {money(totals.owed)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {(Math.abs(totals.shareDelta) >= 0.005 || totals.unreconciled > 0) && (
        <div className="rounded-md border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          Shares are computed from reconciled marketplace payouts when available.
          {Math.abs(totals.shareDelta) >= 0.005 && (
            <>
              {" "}
              Reconciled vs. estimated adjustment across all consignors:{" "}
              <span
                className={
                  totals.shareDelta >= 0 ? "text-green-600" : "text-brand-red-text"
                }
              >
                {signedMoney(totals.shareDelta)}
              </span>
              .
            </>
          )}
          {totals.unreconciled > 0 && (
            <> {totals.unreconciled} sold item{totals.unreconciled === 1 ? "" : "s"} still on estimates (awaiting payout reconciliation).</>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {consignors.length} consignor{consignors.length === 1 ? "" : "s"}
          </CardTitle>
          <CardDescription>
            Every item you take in gets its own GradeThread grade, and you set
            how the money is split.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <LoadingRegion label="Loading consignors" className="px-4">
              <TableLoadingSkeleton rows={5} columns={5} />
            </LoadingRegion>
          ) : error ? (
            <div className="py-12 text-center text-sm text-destructive">
              Failed to load consignors: {String(error)}
            </div>
          ) : consignors.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No consignors yet"
              description="Add a consignor to run consignment on GradeThread: set their split, capture an intake e-signature, and pay them out via Stripe Connect."
              action={
                canManage
                  ? {
                      label: "New consignor",
                      onClick: () => setEditing({ ...EMPTY }),
                      icon: Plus,
                    }
                  : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Split</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Owed</TableHead>
                  <TableHead>Intake</TableHead>
                  <TableHead>Payouts</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {consignors.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {c.name}
                      {c.contact_email && (
                        <div className="text-xs text-muted-foreground">
                          {c.contact_email}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {c.default_split_pct}%
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={c.status === "active" ? "default" : "outline"}
                      >
                        {CONSIGNOR_STATUS_LABELS[c.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.pnl?.total_items ?? 0}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(c.pnl?.gross_revenue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {money(c.pnl?.balance_owed)}
                      {Math.abs(Number(c.pnl?.consignor_share_delta ?? 0)) >=
                        0.005 && (
                        <div
                          className={`text-xs font-normal ${
                            Number(c.pnl?.consignor_share_delta) >= 0
                              ? "text-green-600"
                              : "text-brand-red-text"
                          }`}
                          title="Reconciled payout vs. sale-price estimate"
                        >
                          {signedMoney(c.pnl?.consignor_share_delta)} vs est.
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {c.intake_signed_at ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Signed
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setIntakeFor(c)}
                          aria-label={`Sign the intake agreement for ${c.name}`}
                          disabled={!canManage}
                        >
                          <PenLine className="mr-1 h-3.5 w-3.5" /> Sign
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>
                      {c.payouts_enabled ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => startConnect(c)}
                          disabled={!canManage || busyId === c.id}
                        >
                          {busyId === c.id ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CreditCard className="mr-1 h-3.5 w-3.5" />
                          )}
                          Connect
                        </Button>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setPayFor(c)}
                        disabled={!canManage}
                        aria-label={`Pay ${c.name}`}
                      >
                        <Banknote className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setHistoryFor(c)}
                        aria-label={`Payout history for ${c.name}`}
                      >
                        History
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          setEditing({
                            id: c.id,
                            name: c.name,
                            email: c.contact_email ?? "",
                            phone: c.contact_phone ?? "",
                            split_pct: String(c.default_split_pct),
                            status: c.status,
                            notes: c.notes ?? "",
                          })
                        }
                        disabled={!canManage}
                        aria-label={`Edit ${c.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConsignorEditDialog
        state={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
      <IntakeDialog
        consignor={intakeFor}
        onClose={() => setIntakeFor(null)}
        onSaved={() => {
          setIntakeFor(null);
          refresh();
        }}
      />
      <PayoutDialog
        consignor={payFor}
        onClose={() => setPayFor(null)}
        onSaved={() => {
          setPayFor(null);
          refresh();
        }}
      />
      <PayoutHistoryDialog
        consignor={historyFor}
        onClose={() => setHistoryFor(null)}
      />
    </div>
  );
}

function ConsignorEditDialog({
  state,
  onClose,
  onSaved,
}: {
  state: FormState | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<FormState | null>(state);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(state), [state]);
  if (!draft || !state) return null;

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error("Name is required.");
      return;
    }
    const splitNum = Number(draft.split_pct);
    if (!Number.isFinite(splitNum) || splitNum < 0 || splitNum > 100) {
      toast.error("Split must be between 0 and 100.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name,
        contact_email: draft.email.trim() || null,
        contact_phone: draft.phone.trim() || null,
        default_split_pct: splitNum,
        notes: draft.notes.trim() || null,
        ...(draft.id ? { status: draft.status } : {}),
      };
      const res = draft.id
        ? await edgeFetch(`/api/flipdesk/consignment/consignors/${draft.id}`, {
            method: "PATCH",
            json: payload,
          })
        : await edgeFetch(`/api/flipdesk/consignment/consignors`, {
            method: "POST",
            json: payload,
          });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Save failed");
      }
      toast.success(draft.id ? "Consignor updated." : "Consignor created.");
      onSaved();
    } catch (err) {
      toastError(err, "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state.id ? "Edit consignor" : "New consignor"}
          </DialogTitle>
          <DialogDescription>
            The split is the consignor's percentage of each item's gross sale
            price.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="c-name">Name *</Label>
            <Input id="c-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Jane Doe"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="c-email">Email</Label>
              <Input id="c-email"
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="jane@example.com"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-phone">Phone</Label>
              <Input id="c-phone"
                value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                placeholder="(555) 555-5555"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="c-split-consignors-share">Split % (consignor's share)</Label>
              <Input id="c-split-consignors-share"
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={draft.split_pct}
                onChange={(e) =>
                  setDraft({ ...draft, split_pct: e.target.value })
                }
              />
            </div>
            {state.id && (
              <div className="space-y-1">
                <Label htmlFor="c-status">Status</Label>
                <Select
                  value={draft.status}
                  onValueChange={(v) =>
                    setDraft({ ...draft, status: v as ConsignorStatus })
                  }
                >
                  <SelectTrigger id="c-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONSIGNOR_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {CONSIGNOR_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="c-notes">Notes</Label>
            <Textarea id="c-notes"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={3}
              placeholder="Terms, contact preferences, etc."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !draft.name.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {state.id ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IntakeDialog({
  consignor,
  onClose,
  onSaved,
}: {
  consignor: ConsignorWithPnl | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(consignor?.name ?? "");
    setAgreed(false);
  }, [consignor]);

  if (!consignor) return null;

  async function submit() {
    if (!consignor) return;
    if (!name.trim() || !agreed) {
      toast.error("Type the signature name and accept the agreement.");
      return;
    }
    setSaving(true);
    try {
      const res = await edgeFetch(
        `/api/flipdesk/consignment/consignors/${consignor.id}/intake`,
        { method: "POST", json: { signature_name: name.trim(), agreement_version: "v1" } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not record signature");
      }
      toast.success("Intake agreement signed.");
      onSaved();
    } catch (err) {
      toastError(err, "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!consignor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Consignment intake agreement</DialogTitle>
          <DialogDescription>
            Record {consignor.name}'s e-signature accepting the consignment terms
            (split {consignor.default_split_pct}%).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            By signing, the consignor authorizes GradeThread/FlipDesk to list,
            grade, sell, and ship the consigned items, and agrees to receive{" "}
            {consignor.default_split_pct}% of each item's net sale proceeds, paid
            out via the connected payout method after a sale clears.
          </div>
          <div className="space-y-1">
            <Label htmlFor="c-signature-type-full-name">Signature (type full name) *</Label>
            <Input id="c-signature-type-full-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full legal name"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            I agree to the consignment terms above.
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim() || !agreed}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sign agreement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PayoutDialog({
  consignor,
  onClose,
  onSaved,
}: {
  consignor: ConsignorWithPnl | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAmount(
      consignor?.pnl?.balance_owed
        ? Number(consignor.pnl.balance_owed).toFixed(2)
        : "",
    );
    setNote("");
  }, [consignor]);

  if (!consignor) return null;

  async function submit() {
    if (!consignor) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Enter a positive amount.");
      return;
    }
    setSaving(true);
    try {
      const res = await edgeFetch(`/api/flipdesk/consignment/payouts`, {
        method: "POST",
        json: { consignor_id: consignor.id, amount: amt, note: note.trim() || undefined },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? "Payout failed");
      }
      toast.success(
        body.transferred
          ? "Payout sent via Stripe."
          : "Payout recorded (pending — connect Stripe to send automatically).",
      );
      onSaved();
    } catch (err) {
      toastError(err, "Payout failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!consignor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pay {consignor.name}</DialogTitle>
          <DialogDescription>
            Balance owed: {money(consignor.pnl?.balance_owed)}.{" "}
            {consignor.payouts_enabled
              ? "A Stripe transfer will be sent to their connected account."
              : "No Stripe account connected — this will be recorded as a pending (manual) payout."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="c-amount-usd">Amount (USD) *</Label>
            <Input id="c-amount-usd"
              type="number"
              min={0}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="c-note">Note</Label>
            <Input id="c-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. March payout"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !amount}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {consignor.payouts_enabled ? "Send payout" : "Record payout"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PayoutHistoryDialog({
  consignor,
  onClose,
}: {
  consignor: ConsignorWithPnl | null;
  onClose: () => void;
}) {
  const { data: payouts = [], isLoading } = useConsignorPayouts(consignor?.id);

  return (
    <Dialog open={!!consignor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Payout history — {consignor?.name}</DialogTitle>
          <DialogDescription>
            All recorded payouts for this consignor.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <LoadingRegion label="Loading payouts">
            <SkeletonRows rows={3} />
          </LoadingRegion>
        ) : payouts.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No payouts yet.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payouts.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-sm">
                    {new Date(p.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(p.amount)}
                  </TableCell>
                  <TableCell>
                    {/* US-2022: a clawback-pending row is real money the seller
                        is out until someone recovers it, so it reads as
                        destructive rather than as just another status. */}
                    <Badge
                      variant={
                        p.status === "clawback_pending"
                          ? "destructive"
                          : p.status === "paid"
                            ? "default"
                            : "outline"
                      }
                    >
                      {CONSIGNOR_PAYOUT_STATUS_LABELS[p.status]}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

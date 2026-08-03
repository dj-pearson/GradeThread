import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { splitByOpenState } from "@/pages/flipdesk/post-sale-state";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Loader2,
  PackageX,
  Paperclip,
  RotateCcw,
  ShieldAlert,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
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
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  useEbayCancellations,
  useEbayConnection,
  useEbayDecideCancellation,
  useEbayAddDisputeEvidence,
  useEbayDecideReturn,
  useEbayPaymentDisputes,
  useEbayRefundReturn,
  useEbayResolveDispute,
  useEbayReturns,
  type EbayCancellation,
  type EbayPaymentDispute,
  type EbayReturn,
} from "@/hooks/use-ebay";

// US-1043 + US-1049: web surface for post-sale issues — returns, cancellations,
// and payment disputes — with the accept/decline/refund/contest actions.
export function FlipdeskPostSalePage() {
  const { data: connection, isLoading: connLoading } = useEbayConnection();
  const connected = !!connection;

  if (connLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 py-12 text-center">
        <h1 className="text-xl font-semibold">Returns & Disputes</h1>
        <p className="text-sm text-muted-foreground">
          Connect your eBay account to manage returns, cancellations, and payment
          disputes.
        </p>
        <Button asChild variant="outline">
          <a href="/dashboard/flipdesk/marketplaces">Go to Marketplaces</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Returns & Disputes"
        subtitle="Handle eBay returns, buyer cancellations, and payment disputes before their deadlines — responses are pushed straight to eBay."
      />
      <DisputesCard />
      <ReturnsCard />
      <CancellationsCard />
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

// Days until a deadline (negative = overdue). null when no date.
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

function EmptyRow({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

// ── Payment disputes (most urgent — deadline-driven) ────────────────

function DisputesCard() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: disputes = [], isLoading } = useEbayPaymentDisputes();
  const resolve = useEbayResolveDispute();
  const [busy, setBusy] = useState<string | null>(null);
  // The dispute currently being contested (drives the note dialog), plus its note.
  const [contestFor, setContestFor] = useState<EbayPaymentDispute | null>(null);
  // US-2227 AC3: same unfiltered-list defect as Returns. A dispute eBay has
  // closed still rendered Accept / Contest buttons against a respond-by
  // deadline that has already passed.
  const [showClosed, setShowClosed] = useState(false);
  const { open: openDisputes, closed: closedDisputes } = useMemo(
    () => splitByOpenState(disputes),
    [disputes],
  );
  const visible = showClosed ? closedDisputes : openDisputes;
  const [contestNote, setContestNote] = useState("");

  async function runResolve(
    d: EbayPaymentDispute,
    action: "accept" | "contest",
    note: string | undefined,
  ) {
    setBusy(`${d.paymentDisputeId}:${action}`);
    try {
      await resolve.mutateAsync({
        disputeId: d.paymentDisputeId,
        action,
        note,
        orderId: d.orderId ?? undefined,
      });
      toast.success(
        action === "accept" ? "Dispute accepted (buyer refunded)." : "Dispute contested.",
      );
      await qc.invalidateQueries({ queryKey: ["ebay_payment_disputes"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  async function acceptDispute(d: EbayPaymentDispute) {
    const amount =
      d.amount != null ? ` ${d.currency ?? "$"} ${d.amount.toFixed(2)}` : "";
    const ok = await confirm({
      title: "Accept dispute and refund the buyer?",
      description: `This refunds the buyer${amount} on eBay immediately and closes the dispute. This can't be undone.`,
      confirmLabel: "Accept & refund",
      destructive: true,
    });
    if (!ok) return;
    await runResolve(d, "accept", undefined);
  }

  function openContest(d: EbayPaymentDispute) {
    setContestNote("");
    setContestFor(d);
  }

  async function submitContest() {
    const d = contestFor;
    if (!d) return;
    const note = contestNote.trim() || undefined;
    setContestFor(null);
    await runResolve(d, "contest", note);
  }

  return (
    <Card className="border-brand-red/30">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-brand-red" />
            Payment disputes
          </span>
          {closedDisputes.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 text-xs font-normal"
              onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? `Show open (${openDisputes.length})` : `Show closed (${closedDisputes.length})`}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : visible.length === 0 ? (
          <EmptyRow text={showClosed ? "No closed payment disputes." : "No open payment disputes."} />
        ) : (
          visible.map((d) => {
            const days = daysUntil(d.respondByDate);
            const overdue = days != null && days < 0;
            return (
              <div
                key={d.paymentDisputeId}
                className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {d.reason?.replace(/_/g, " ") ?? "Payment dispute"}
                    </span>
                    {d.amount != null && (
                      <Badge variant="secondary">
                        {d.currency ?? "$"} {d.amount.toFixed(2)}
                      </Badge>
                    )}
                    {d.respondByDate && (
                      <Badge variant={overdue ? "destructive" : "outline"}>
                        {overdue
                          ? "Overdue"
                          : `Respond by ${fmtDate(d.respondByDate)}${
                              days != null ? ` (${days}d)` : ""
                            }`}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Order {d.orderId ?? "—"}
                    {d.buyerUsername ? ` · ${d.buyerUsername}` : ""}
                  </p>
                </div>
                {/* US-2227: a closed dispute keeps no actions — Accept refunds the
                    buyer, and Contest is meaningless once eBay has decided. */}
                {!showClosed && (
                <div className="flex shrink-0 gap-2">
                  <EvidenceUploader disputeId={d.paymentDisputeId} disabled={!!busy} />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => openContest(d)}
                  >
                    {busy === `${d.paymentDisputeId}:contest` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <AlertTriangle className="mr-1 h-4 w-4" />
                    )}
                    Contest
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!!busy}
                    onClick={() => acceptDispute(d)}
                  >
                    {busy === `${d.paymentDisputeId}:accept` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-1 h-4 w-4" />
                    )}
                    Accept &amp; refund
                  </Button>
                </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>

      <Dialog
        open={!!contestFor}
        onOpenChange={(open) => {
          if (!open) setContestFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Contest payment dispute</DialogTitle>
            <DialogDescription>
              Add a short note for eBay explaining why you're contesting this
              dispute. It's sent to eBay with your response.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="contest-note">Note to eBay</Label>
            <Textarea
              id="contest-note"
              value={contestNote}
              onChange={(e) => setContestNote(e.target.value)}
              placeholder="e.g. Tracking confirms the item was delivered and signed for on 2026-07-20."
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setContestFor(null)}>
              Cancel
            </Button>
            <Button onClick={submitContest}>Contest dispute</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// Uploads a supporting-evidence image (e.g. a delivery scan) and attaches it to
// the dispute on eBay. The seller can attach evidence and then Contest.
function EvidenceUploader({
  disputeId,
  disabled,
}: {
  disputeId: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addEvidence = useEbayAddDisputeEvidence();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      await addEvidence.mutateAsync({ disputeId, file });
      toast.success("Evidence uploaded to eBay.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Evidence upload failed.");
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        onChange={onPick}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || addEvidence.isPending}
        onClick={() => inputRef.current?.click()}
      >
        {addEvidence.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Paperclip className="mr-1 h-4 w-4" />
        )}
        Evidence
      </Button>
    </>
  );
}

// ── Returns ─────────────────────────────────────────────────────────

function ReturnsCard() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: returns = [], isLoading } = useEbayReturns();
  // US-2227 AC3: the list arrived unfiltered and every row got Approve /
  // Decline / Refund buttons, so a case eBay had already closed looked exactly
  // like one waiting on the seller — with a destructive action attached.
  const [showClosed, setShowClosed] = useState(false);
  const { open: openReturns, closed: closedReturns } = useMemo(
    () => splitByOpenState(returns),
    [returns],
  );
  const visible = showClosed ? closedReturns : openReturns;
  const decide = useEbayDecideReturn();
  const refund = useEbayRefundReturn();
  const [busy, setBusy] = useState<string | null>(null);

  async function decideReturn(r: EbayReturn, decision: "approve" | "decline") {
    if (decision === "approve") {
      const ok = await confirm({
        title: "Approve this return?",
        description:
          "This approves the buyer's return request on eBay — they'll be able to send the item back for a refund.",
        confirmLabel: "Approve return",
      });
      if (!ok) return;
    }
    setBusy(`${r.returnId}:${decision}`);
    try {
      await decide.mutateAsync({
        returnId: r.returnId,
        decision,
        orderId: r.orderId ?? undefined,
      });
      toast.success(decision === "approve" ? "Return approved." : "Return declined.");
      await qc.invalidateQueries({ queryKey: ["ebay_returns"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  async function refundReturn(r: EbayReturn) {
    const ok = await confirm({
      title: "Issue a refund for this return?",
      description:
        "This issues a refund to the buyer on eBay immediately. This can't be undone.",
      confirmLabel: "Issue refund",
      destructive: true,
    });
    if (!ok) return;
    setBusy(`${r.returnId}:refund`);
    try {
      await refund.mutateAsync({ returnId: r.returnId, orderId: r.orderId ?? undefined });
      toast.success("Refund issued.");
      await qc.invalidateQueries({ queryKey: ["ebay_returns"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refund failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4" />
            Returns
          </span>
          {closedReturns.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs font-normal"
              onClick={() => setShowClosed((v) => !v)}
            >
              {showClosed
                ? `Show open (${openReturns.length})`
                : `Show closed (${closedReturns.length})`}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : visible.length === 0 ? (
          <EmptyRow
            text={showClosed ? "No closed returns." : "No open returns."}
          />
        ) : (
          visible.map((r) => (
            <div
              key={r.returnId}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {r.reason?.replace(/_/g, " ") ?? "Return request"}
                  </span>
                  {r.state && <Badge variant="outline">{r.state.replace(/_/g, " ")}</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  Return {r.returnId} · opened {fmtDate(r.creationDate)}
                </p>
              </div>
              {/* US-2227: no actions on a closed case. Offering Refund on a
                  case eBay has already resolved is an invitation to a
                  destructive no-op, and its confirm text promises otherwise. */}
              {!showClosed && (
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => decideReturn(r, "decline")}
                >
                  {busy === `${r.returnId}:decline` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="mr-1 h-4 w-4" />
                  )}
                  Decline
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => decideReturn(r, "approve")}
                >
                  {busy === `${r.returnId}:approve` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-1 h-4 w-4" />
                  )}
                  Approve
                </Button>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => refundReturn(r)}
                >
                  {busy === `${r.returnId}:refund` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-1 h-4 w-4" />
                  )}
                  Refund
                </Button>
              </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Cancellations ───────────────────────────────────────────────────

function CancellationsCard() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: cancellations = [], isLoading } = useEbayCancellations();
  const decide = useEbayDecideCancellation();
  const [busy, setBusy] = useState<string | null>(null);
  // US-2227 AC3: third instance of the same unfiltered-list defect.
  const [showClosed, setShowClosed] = useState(false);
  const { open: openCancels, closed: closedCancels } = useMemo(
    () => splitByOpenState(cancellations),
    [cancellations],
  );
  const visible = showClosed ? closedCancels : openCancels;

  async function act(ca: EbayCancellation, action: "approve" | "reject") {
    if (action === "approve") {
      const ok = await confirm({
        title: "Approve cancellation and cancel the order?",
        description:
          "This cancels the order on eBay and refunds the buyer. This can't be undone.",
        confirmLabel: "Approve & cancel",
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(`${ca.cancelId}:${action}`);
    try {
      await decide.mutateAsync({
        cancelId: ca.cancelId,
        action,
        orderId: ca.orderId ?? undefined,
      });
      toast.success(action === "approve" ? "Cancellation approved." : "Cancellation rejected.");
      await qc.invalidateQueries({ queryKey: ["ebay_cancellations"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <PackageX className="h-4 w-4" />
            Cancellation requests
          </span>
          {closedCancels.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 text-xs font-normal"
              onClick={() => setShowClosed((v) => !v)}>
              {showClosed ? `Show open (${openCancels.length})` : `Show closed (${closedCancels.length})`}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : visible.length === 0 ? (
          <EmptyRow text={showClosed ? "No closed cancellation requests." : "No open cancellation requests."} />
        ) : (
          visible.map((ca) => (
            <div
              key={ca.cancelId}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {ca.reason?.replace(/_/g, " ") ?? "Cancellation"}
                  </span>
                  {ca.requestorType && (
                    <Badge variant="outline">{ca.requestorType.toLowerCase()}</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Order {ca.orderId ?? "—"} · {fmtDate(ca.creationDate)}
                </p>
              </div>
              {/* US-2227: no Approve/Reject on a cancellation eBay has settled. */}
              {!showClosed && (
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => act(ca, "reject")}
                >
                  {busy === `${ca.cancelId}:reject` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="mr-1 h-4 w-4" />
                  )}
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!!busy}
                  onClick={() => act(ca, "approve")}
                >
                  {busy === `${ca.cancelId}:approve` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-1 h-4 w-4" />
                  )}
                  Approve &amp; cancel
                </Button>
              </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

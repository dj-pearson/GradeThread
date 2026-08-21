import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { daysUntil, splitByOpenState } from "@/pages/flipdesk/post-sale-state";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Loader2,
  PackageCheck,
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
import { Input } from "@/components/ui/input";
import {
  centsToEbayValue,
  isFullRefund,
  validateRefundAmount,
} from "@/lib/refund-amount";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PlatformCoverageNote } from "@/components/flipdesk/platform-coverage-note";
import { CaseItemSummary } from "@/components/flipdesk/case-item-summary";
import { ReturnEvidencePanel } from "@/components/flipdesk/return-evidence-panel";
import {
  caseItemKey,
  ebayOrderUrl,
  ebayReturnUrl,
  useCaseItems,
} from "@/hooks/use-case-items";
import {
  useEbayCancellations,
  useEbayConnection,
  useEbayDecideCancellation,
  useEbayAddDisputeEvidence,
  useEbayDecideReturn,
  useEbayPaymentDisputes,
  useEbayIssueOrderRefund,
  useEbayOrderTotal,
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
      {/* US-2541: same reasoning as the offers screen. An empty returns list
          is the one a seller most wants to trust. */}
      <PlatformCoverageNote
        feature="post_sale"
        noun="Returns, cancellations and disputes"
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

// US-2541: was a bare paragraph. These three lists are the ones a seller
// checks to confirm NOTHING is waiting on them, so "nothing here" has to read
// as an answer rather than as a list that failed to draw.
function EmptyRow({ text }: { text: string }) {
  return (
    <EmptyState
      className="py-8"
      icon={PackageCheck}
      title={text}
      description="eBay cases only — GradeThread does not read your other marketplaces."
    />
  );
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
            <ShieldAlert className="h-4 w-4 text-brand-red-text" />
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
  // US-2521: what each case is actually about. Resolved for every return, not
  // just the visible ones, so toggling open/closed does not refetch.
  const { data: caseItems } = useCaseItems(
    returns.map((r) => ({ orderId: r.orderId, itemId: r.itemId })),
  );
  const decide = useEbayDecideReturn();
  const refund = useEbayRefundReturn();
  const partialRefund = useEbayIssueOrderRefund();
  const [busy, setBusy] = useState<string | null>(null);
  // US-2227: which return's partial-refund row is open, and what is typed in it.
  const [partialFor, setPartialFor] = useState<string | null>(null);
  // US-2706: which return's evidence panel is open. One at a time — two open
  // packs is two complaint boxes and a good way to send the wrong one.
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
  const [partialAmount, setPartialAmount] = useState("");
  const partialOrderId = useMemo(
    () => returns.find((r) => r.returnId === partialFor)?.orderId ?? null,
    [returns, partialFor],
  );
  const { data: orderTotal } = useEbayOrderTotal(partialOrderId);

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

  // US-2227 AC1/AC2. NOT the return route — that one calls eBay's Post-Order
  // issue_refund, which carries no amount and refunds the return in full. The
  // amount-carrying route is POST /orders/:orderId/refund (US-1978), which
  // shipped with no frontend caller at all. See src/lib/refund-amount.ts.
  async function issuePartialRefund(r: EbayReturn) {
    if (!r.orderId) {
      toast.error("This return has no order id, so we can't refund against it.");
      return;
    }
    const v = validateRefundAmount(partialAmount, orderTotal ?? null);
    if (!v.ok) {
      toast.error(v.error ?? "Enter a valid refund amount.");
      return;
    }
    // A full amount through this route refunds the buyer and leaves the return
    // sitting OPEN — two different eBay conversations. Send the seller to the
    // button that closes the case instead of quietly doing the wrong one.
    if (isFullRefund(v.cents, orderTotal ?? null)) {
      toast.error("That is the whole order — use Refund to close the return instead.");
      return;
    }
    const ok = await confirm({
      title: `Refund ${centsToEbayValue(v.cents)} to the buyer?`,
      description:
        "This sends a partial refund on eBay immediately and leaves the return open. This can't be undone.",
      confirmLabel: "Send refund",
      destructive: true,
    });
    if (!ok) return;
    setBusy(`${r.returnId}:partial`);
    try {
      await partialRefund.mutateAsync({
        orderId: r.orderId,
        reason: "ITEM_NOT_AS_DESCRIBED",
        amountValue: centsToEbayValue(v.cents),
      });
      toast.success(`Refunded ${centsToEbayValue(v.cents)}.`);
      setPartialFor(null);
      setPartialAmount("");
      await qc.invalidateQueries({ queryKey: ["ebay_returns"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refund failed.");
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
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {r.reason?.replace(/_/g, " ") ?? "Return request"}
                  </span>
                  {r.state && <Badge variant="outline">{r.state.replace(/_/g, " ")}</Badge>}
                </div>
                {/* US-2521: the garment, its sale price and the way through to
                    both the eBay case and the local item. Approving a refund
                    from a return id alone is how the wrong one gets approved. */}
                <CaseItemSummary
                  item={caseItems?.get(
                    caseItemKey({ orderId: r.orderId, itemId: r.itemId }) ?? "",
                  )}
                  caseUrl={ebayReturnUrl(r.returnId)}
                  caseLabel={`Return ${r.returnId} on eBay`}
                />
                <p className="text-xs text-muted-foreground">
                  Opened {fmtDate(r.creationDate)}
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
                {/* US-2227: the keep-it discount. Separate from Refund because
                    it is a different eBay call with a different outcome — this
                    one leaves the return open. */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => {
                    setPartialAmount("");
                    setPartialFor(partialFor === r.returnId ? null : r.returnId);
                  }}
                >
                  Partial…
                </Button>
                {/* US-2706: the grade evidence. Opens a review panel and sends
                    nothing until the seller reads the verdict and clicks — the
                    useful outcome of this feature is often "do not fight". */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() =>
                    setEvidenceFor(evidenceFor === r.returnId ? null : r.returnId)}
                >
                  Evidence…
                </Button>
              </div>
              )}
              {evidenceFor === r.returnId && !showClosed && (
                <ReturnEvidencePanel returnId={r.returnId} orderId={r.orderId} />
              )}
              {partialFor === r.returnId && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
                  <Label htmlFor={`partial-${r.returnId}`} className="text-xs">
                    Refund amount
                  </Label>
                  <Input
                    id={`partial-${r.returnId}`}
                    className="h-8 w-28"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={partialAmount}
                    onChange={(e) => setPartialAmount(e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">
                    {orderTotal != null
                      ? `of ${orderTotal.toFixed(2)}`
                      : "order total unavailable"}
                  </span>
                  <Button
                    size="sm"
                    disabled={!!busy}
                    onClick={() => issuePartialRefund(r)}
                  >
                    {busy === `${r.returnId}:partial` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Send
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
  // US-2521: a cancellation identified only by an order id is a refund button
  // with no subject.
  const { data: caseItems } = useCaseItems(
    cancellations.map((c) => ({ orderId: c.orderId, itemId: null })),
  );

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
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {ca.reason?.replace(/_/g, " ") ?? "Cancellation"}
                  </span>
                  {ca.requestorType && (
                    <Badge variant="outline">{ca.requestorType.toLowerCase()}</Badge>
                  )}
                </div>
                {/* US-2521: same problem as the returns rows — Approve here
                    cancels an order and refunds a buyer. */}
                {ca.orderId && (
                  <CaseItemSummary
                    item={caseItems?.get(ca.orderId)}
                    caseUrl={ebayOrderUrl(ca.orderId)}
                    caseLabel={`Order ${ca.orderId} on eBay`}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  {fmtDate(ca.creationDate)}
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

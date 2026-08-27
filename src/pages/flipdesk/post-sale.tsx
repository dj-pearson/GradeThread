import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  byDeadline,
  canMarkReceived,
  daysUntil,
  deadlineBucket,
  deadlineLabel,
  splitByOpenState,
} from "@/pages/flipdesk/post-sale-state";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  AlertTriangle,
  Check,
  Loader2,
  Gavel,
  PackageCheck,
  PackageX,
  Truck,
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
  type CaseItem,
  caseItemKey,
  ebayOrderUrl,
  ebayReturnUrl,
  useCaseItems,
} from "@/hooks/use-case-items";
import {
  useEbayCancellations,
  useEbayCaseAction,
  useEbayCases,
  useEbayConnection,
  useEbayDecideCancellation,
  useEbayAddDisputeEvidence,
  useEbayDecideReturn,
  useEbayPaymentDisputes,
  useEbayInquiries,
  useEbayInquiryAction,
  useEbayIssueOrderRefund,
  useEbayMarkReturnReceived,
  useEbayReadReturnShipment,
  useEbaySendReturnMessage,
  useEbayOrderTotal,
  useEbayRefundReturn,
  useEbayResolveDispute,
  useEbayReturns,
  type EbayCancellation,
  type EbayCase,
  type EbayInquiry,
  type EbayPaymentDispute,
  type EbayReturn,
} from "@/hooks/use-ebay";
import { PageHelp } from "@/components/help/page-help";
import {
  centsToDisplay,
  suggestKeepItRefund,
} from "@/pages/flipdesk/keep-it-offer";

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
          Connect your eBay account. Then handle cases, returns and disputes
          from here.
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
        subtitle="Every eBay case waiting on you, in the order it runs out. Your answer goes straight to eBay."
              actions={<PageHelp slug="returns-and-disputes" />}
      />
      {/* US-2541: same reasoning as the offers screen. An empty returns list
          is the one a seller most wants to trust. */}
      <PlatformCoverageNote
        feature="post_sale"
        noun="Returns, cancellations and disputes"
      />
      <DisputesCard />
      <CasesCard />
      <InquiriesCard />
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
  const visible = useMemo(
    () => byDeadline(showClosed ? closedDisputes : openDisputes, (d) => d.respondByDate),
    [showClosed, closedDisputes, openDisputes],
  );
  const [contestNote, setContestNote] = useState("");
  // US-2707: which dispute's grade-pack panel is open. One at a time, same as
  // returns — two open packs is two complaint boxes and a good way to send the
  // wrong one.
  const [packFor, setPackFor] = useState<string | null>(null);

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
      toastError(err, "Action failed.");
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
                  {/* US-2707: the same review-before-send pack the returns list
                      offers. The rarer path is not the one where GradeThread
                      hands the seller a file picker and no verdict. */}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    aria-label={`Grade pack for order ${d.orderId ?? "unknown"}`}
                    onClick={() =>
                      setPackFor(
                        packFor === d.paymentDisputeId ? null : d.paymentDisputeId,
                      )}
                  >
                    Grade pack…
                  </Button>
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
                {packFor === d.paymentDisputeId && !showClosed && (
                  <ReturnEvidencePanel
                    caseId={d.paymentDisputeId}
                    orderId={d.orderId}
                    kind="dispute"
                  />
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
      toastError(err, "Evidence upload failed.");
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
  const visible = useMemo(
    () => byDeadline(showClosed ? closedReturns : openReturns, (r) => r.respondBy),
    [showClosed, closedReturns, openReturns],
  );
  // US-2521: what each case is actually about. Resolved for every return, not
  // just the visible ones, so toggling open/closed does not refetch.
  const { data: caseItems } = useCaseItems(
    returns.map((r) => ({ orderId: r.orderId, itemId: r.itemId })),
  );
  const decide = useEbayDecideReturn();
  const markReceived = useEbayMarkReturnReceived();
  const readShipment = useEbayReadReturnShipment();
  const refund = useEbayRefundReturn();
  const partialRefund = useEbayIssueOrderRefund();
  const sendMessage = useEbaySendReturnMessage();
  const [busy, setBusy] = useState<string | null>(null);
  // US-2227: which return's partial-refund row is open, and what is typed in it.
  const [partialFor, setPartialFor] = useState<string | null>(null);
  // US-2706: which return's evidence panel is open. One at a time — two open
  // packs is two complaint boxes and a good way to send the wrong one.
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
  const [partialAmount, setPartialAmount] = useState("");
  // US-2932: which return's buyer-message box is open, and what is in it.
  const [messageFor, setMessageFor] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const partialOrderId = useMemo(
    () => returns.find((r) => r.returnId === partialFor)?.orderId ?? null,
    [returns, partialFor],
  );
  const { data: orderTotal } = useEbayOrderTotal(partialOrderId);

  // US-2930. Confirmed, because telling eBay an item is back stops a clock and
  // is a statement of fact the seller is on record for.
  async function markReturnReceived(r: EbayReturn) {
    const ok = await confirm({
      title: "Mark this return received?",
      description:
        "This tells eBay the item is back with you. Only do it once you actually have it — eBay records it as your statement.",
      confirmLabel: "Mark received",
    });
    if (!ok) return;
    setBusy(`${r.returnId}:received`);
    try {
      await markReceived.mutateAsync({ returnId: r.returnId });
      toast.success("eBay has been told the item arrived.");
      await qc.invalidateQueries({ queryKey: ["ebay_returns"] });
    } catch (err) {
      toastError(err, "Marking the return received failed.");
    } finally {
      setBusy(null);
    }
  }

  // US-2931. One call, for the return the seller is deciding about.
  async function checkShipment(r: EbayReturn) {
    setBusy(`${r.returnId}:shipment`);
    try {
      const { label } = await readShipment.mutateAsync({ returnId: r.returnId });
      toast.success(
        label?.trackingNumber
          ? `Tracking ${label.trackingNumber} on ${label.carrier ?? "the carrier"}.`
          : "eBay has no shipment for this return yet.",
      );
      await qc.invalidateQueries({ queryKey: ["ebay_returns"] });
    } catch (err) {
      toastError(err, "Couldn't read the return shipment.");
    } finally {
      setBusy(null);
    }
  }

  // US-2932: the return-scoped thread. eBay reads THIS one when it decides a
  // case, so a keep-it agreement made in the Offers inbox is invisible to it.
  async function sendReturnNote(r: EbayReturn) {
    const text = messageText.trim();
    if (!text) return;
    setBusy(`${r.returnId}:message`);
    try {
      await sendMessage.mutateAsync({ returnId: r.returnId, message: text });
      toast.success("Message sent to the buyer on eBay.");
      setMessageFor(null);
      setMessageText("");
    } catch (err) {
      toastError(err, "The message did not send.");
    } finally {
      setBusy(null);
    }
  }

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
      toastError(err, "Action failed.");
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
      toastError(err, "Refund failed.");
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
      toastError(err, "Refund failed.");
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
                  <DeadlineBadge respondBy={r.respondBy} />
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
                {/* US-2931: whether the buyer has actually posted it. `label`
                    is undefined until someone looks; null once eBay has been
                    asked and said no — three states, not two, because "we have
                    not checked" and "they have not shipped" are different
                    answers to the question the seller is asking. */}
                {r.label !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    {r.label?.trackingNumber
                      ? `${r.label.carrier ?? "Carrier"} ${r.label.trackingNumber}${
                          r.label.deliveredAt
                            ? ` — delivered ${fmtDate(r.label.deliveredAt)}`
                            : r.label.shippedAt
                              ? ` — shipped ${fmtDate(r.label.shippedAt)}`
                              : ""
                        }`
                      : "The buyer has not shipped it yet."}
                  </p>
                )}
              </div>
              {/* US-2227: no actions on a closed case. Offering Refund on a
                  case eBay has already resolved is an invitation to a
                  destructive no-op, and its confirm text promises otherwise. */}
              {!showClosed && (
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  aria-label={`Check the return shipment for ${r.reason?.replace(/_/g, " ") ?? "this return"}`}
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => checkShipment(r)}
                >
                  {busy === `${r.returnId}:shipment` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Truck className="mr-1 h-4 w-4" />
                  )}
                  Check shipment
                </Button>
                {/* US-2930: only once the item is actually moving. Offering it
                    on a return the buyer has not posted invites the seller to
                    tell eBay a parcel arrived that was never sent. */}
                {canMarkReceived(r.state, !!r.label?.trackingNumber) && (
                  <Button
                    aria-label={`Mark received: ${r.reason?.replace(/_/g, " ") ?? "this return"}`}
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => markReturnReceived(r)}
                  >
                    {busy === `${r.returnId}:received` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PackageCheck className="mr-1 h-4 w-4" />
                    )}
                    Mark received
                  </Button>
                )}
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
                {/* US-2932: message the buyer inside the RETURN. eBay reads
                    this thread when it decides a case; the Offers inbox is a
                    different conversation it cannot see. */}
                <Button
                  aria-label={`Message the buyer about ${r.reason?.replace(/_/g, " ") ?? "this return"}`}
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => {
                    setMessageText("");
                    setMessageFor(messageFor === r.returnId ? null : r.returnId);
                  }}
                >
                  Message…
                </Button>
                {/* US-2227: the keep-it discount. Separate from Refund because
                    it is a different eBay call with a different outcome — this
                    one leaves the return open. */}
                <Button
                aria-label={`Partial refund for ${r.reason?.replace(/_/g, " ") ?? "the return"}`}
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
                aria-label={`Evidence for ${r.reason?.replace(/_/g, " ") ?? "the return"}`}
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
                <ReturnEvidencePanel
                  caseId={r.returnId}
                  orderId={r.orderId}
                  kind="return"
                />
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
                  {/* US-2932: a suggestion, with the arithmetic behind it and a
                      click to accept. Absent — not zeroed — when the item's cost
                      is unknown, because a number with nothing behind it reads
                      exactly like one that was computed. */}
                  <KeepItHint
                    item={caseItems?.get(
                      caseItemKey({ orderId: r.orderId, itemId: r.itemId }) ?? "",
                    )}
                    onUse={(cents) => setPartialAmount((cents / 100).toFixed(2))}
                  />
                </div>
              )}
              {messageFor === r.returnId && (
                <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2">
                  <Label htmlFor={`msg-${r.returnId}`} className="text-xs">
                    Message the buyer on eBay
                  </Label>
                  <Textarea
                    id={`msg-${r.returnId}`}
                    rows={3}
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    placeholder="Keep it and I'll refund you $14 — that saves us both the postage."
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={!messageText.trim() || !!busy}
                      onClick={() => sendReturnNote(r)}
                    >
                      {busy === `${r.returnId}:message` ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : null}
                      Send message
                    </Button>
                  </div>
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
  // Cancellations carry no respondByDate on eBay's summary, so there is nothing
  // to sort them by. Left in eBay's order rather than sorted by a field that
  // does not exist.
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
      toastError(err, "Action failed.");
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

// ── Item Not Received inquiries + escalated cases (US-2928 / US-2929) ─
//
// These two sit ABOVE returns on the page because they are the ones with the
// shorter fuse. A return is a decision the seller controls; an inquiry becomes
// a case if ignored, and a case is decided by eBay and counts as a defect.
//
// Both share a shape, so one shared row renderer serves them. What is NOT
// shared is the copy: the whole reason a case is not "a return with a different
// state" is that the seller has to know eBay decides it.

/** Add-tracking dialog. The action that settles most INR inquiries and cases. */
function TrackingDialog({
  open,
  onOpenChange,
  onSubmit,
  busy,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (carrier: string, trackingNumber: string, comments: string) => void;
  busy: boolean;
}) {
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [comments, setComments] = useState("");
  const ready = carrier.trim().length > 0 && tracking.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send tracking to eBay</DialogTitle>
          <DialogDescription>
            eBay accepts this as proof the parcel is on its way. It is what closes
            most item-not-received cases without a refund.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="po-carrier">Carrier</Label>
            <Input
              id="po-carrier"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              placeholder="USPS"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="po-tracking">Tracking number</Label>
            <Input
              id="po-tracking"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              placeholder="9400 1000 0000 0000 0000 00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="po-comments">Note to the buyer (optional)</Label>
            <Textarea
              id="po-comments"
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!ready || busy}
            onClick={() => onSubmit(carrier.trim(), tracking.trim(), comments.trim())}
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Send tracking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * US-2933: the deadline badge every post-sale card uses.
 *
 * No date renders NO badge — never "Overdue". A case eBay gave no deadline for
 * and a case the seller has already lost must not look the same, or they go
 * hunting for work that is not there.
 *
 * The bucket is rendered as TEXT, not as colour alone.
 */
function DeadlineBadge({ respondBy }: { respondBy: string | null | undefined }) {
  const bucket = deadlineBucket(respondBy);
  const label = deadlineLabel(respondBy);
  if (!bucket || !label) return null;
  return (
    <Badge variant={bucket === "overdue" || bucket === "imminent" ? "destructive" : "outline"}>
      {label}
    </Badge>
  );
}

function InquiriesCard() {
  const { data: inquiries = [], isLoading } = useEbayInquiries();
  const act = useEbayInquiryAction();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [trackingFor, setTrackingFor] = useState<EbayInquiry | null>(null);
  const { open: openOnes, closed: closedOnes } = useMemo(
    () => splitByOpenState(inquiries),
    [inquiries],
  );
  // US-2933: soonest deadline first, undated last. The seller opens this page
  // to find what runs out first, not what eBay happened to list first.
  const visible = useMemo(
    () => byDeadline(showClosed ? closedOnes : openOnes, (i) => i.respondBy),
    [showClosed, closedOnes, openOnes],
  );
  const { data: caseItems } = useCaseItems(
    inquiries.map((i) => ({ orderId: i.orderId, itemId: i.itemId })),
  );

  async function run(
    inq: EbayInquiry,
    action: "shipment" | "refund" | "close",
    extra?: { carrier?: string; trackingNumber?: string; comments?: string },
  ) {
    if (action === "refund") {
      const ok = await confirm({
        title: "Refund the buyer?",
        description:
          "This refunds the order on eBay and settles the inquiry. It can't be undone.",
        confirmLabel: "Refund",
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(`${inq.inquiryId}:${action}`);
    try {
      await act.mutateAsync({
        inquiryId: inq.inquiryId,
        action,
        orderId: inq.orderId ?? undefined,
        ...extra,
      });
      toast.success(
        action === "shipment"
          ? "Tracking sent to eBay."
          : action === "refund"
            ? "Buyer refunded."
            : "Inquiry closed.",
      );
      setTrackingFor(null);
    } catch (err) {
      toastError(err, "The inquiry action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Truck className="h-4 w-4" />
            Item not received
          </span>
          {closedOnes.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs font-normal"
              onClick={() => setShowClosed((v) => !v)}
            >
              {showClosed
                ? `Show open (${openOnes.length})`
                : `Show closed (${closedOnes.length})`}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : visible.length === 0 ? (
          <EmptyRow
            text={showClosed ? "No closed inquiries." : "No open item-not-received inquiries."}
          />
        ) : (
          visible.map((inq) => (
            <div
              key={inq.inquiryId}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {inq.reason?.replace(/_/g, " ") ?? "Item not received"}
                  </span>
                  <DeadlineBadge respondBy={inq.respondBy} />
                </div>
                {inq.orderId && (
                  <CaseItemSummary
                    item={caseItems?.get(caseItemKey({ orderId: inq.orderId, itemId: inq.itemId }) ?? "")}
                    caseUrl={ebayOrderUrl(inq.orderId)}
                    caseLabel={`Order ${inq.orderId} on eBay`}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  Opened {fmtDate(inq.creationDate)}
                  {inq.buyerUsername ? ` by ${inq.buyerUsername}` : ""}
                </p>
              </div>
              {!showClosed && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    aria-label={`Add tracking for order ${inq.orderId ?? inq.inquiryId}`}
                    size="sm"
                    disabled={!!busy}
                    onClick={() => setTrackingFor(inq)}
                  >
                    <Truck className="mr-1 h-4 w-4" />
                    Add tracking
                  </Button>
                  <Button
                    aria-label={`Close the inquiry on order ${inq.orderId ?? inq.inquiryId}`}
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => run(inq, "close")}
                  >
                    {busy === `${inq.inquiryId}:close` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-1 h-4 w-4" />
                    )}
                    Close
                  </Button>
                  <Button
                    aria-label={`Refund the buyer on order ${inq.orderId ?? inq.inquiryId}`}
                    size="sm"
                    variant="destructive"
                    disabled={!!busy}
                    onClick={() => run(inq, "refund")}
                  >
                    {busy === `${inq.inquiryId}:refund` ? (
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
      <TrackingDialog
        open={!!trackingFor}
        onOpenChange={(v) => !v && setTrackingFor(null)}
        busy={!!busy}
        onSubmit={(carrier, trackingNumber, comments) => {
          if (trackingFor) {
            void run(trackingFor, "shipment", { carrier, trackingNumber, comments });
          }
        }}
      />
    </Card>
  );
}

function CasesCard() {
  const { data: cases = [], isLoading } = useEbayCases();
  const act = useEbayCaseAction();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [trackingFor, setTrackingFor] = useState<EbayCase | null>(null);
  const [appealFor, setAppealFor] = useState<EbayCase | null>(null);
  const [appealText, setAppealText] = useState("");
  const { open: openOnes, closed: closedOnes } = useMemo(
    () => splitByOpenState(cases),
    [cases],
  );
  const visible = useMemo(
    () => byDeadline(showClosed ? closedOnes : openOnes, (k) => k.respondBy),
    [showClosed, closedOnes, openOnes],
  );
  const { data: caseItems } = useCaseItems(
    cases.map((k) => ({ orderId: k.orderId, itemId: k.itemId })),
  );

  async function run(
    kase: EbayCase,
    action: "shipment" | "refund" | "appeal" | "close",
    extra?: { carrier?: string; trackingNumber?: string; comments?: string },
  ) {
    if (action === "refund") {
      const ok = await confirm({
        title: "Refund the buyer and settle the case?",
        description:
          "This refunds the order on eBay and closes the case. It can't be undone.",
        confirmLabel: "Refund",
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(`${kase.caseId}:${action}`);
    try {
      await act.mutateAsync({
        caseId: kase.caseId,
        action,
        orderId: kase.orderId ?? undefined,
        ...extra,
      });
      toast.success(
        action === "shipment"
          ? "Tracking sent to eBay."
          : action === "refund"
            ? "Buyer refunded."
            : action === "appeal"
              ? "Appeal submitted."
              : "Case closed.",
      );
      setTrackingFor(null);
      setAppealFor(null);
      setAppealText("");
    } catch (err) {
      toastError(err, "The case action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Gavel className="h-4 w-4" />
            eBay cases
          </span>
          {closedOnes.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs font-normal"
              onClick={() => setShowClosed((v) => !v)}
            >
              {showClosed
                ? `Show open (${openOnes.length})`
                : `Show closed (${closedOnes.length})`}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* The distinction the seller has to have. A return is theirs to decide;
            a case is eBay's, and a case decided against them is a defect. */}
        <p className="text-xs text-muted-foreground">
          A case is a return or inquiry the buyer escalated. eBay decides it, and a
          case decided against you counts as a defect on your seller account.
        </p>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : visible.length === 0 ? (
          <EmptyRow text={showClosed ? "No closed cases." : "No open eBay cases."} />
        ) : (
          visible.map((kase) => (
            <div
              key={kase.caseId}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {kase.reason?.replace(/_/g, " ") ?? "eBay case"}
                  </span>
                  <DeadlineBadge respondBy={kase.respondBy} />
                </div>
                {kase.orderId && (
                  <CaseItemSummary
                    item={caseItems?.get(caseItemKey({ orderId: kase.orderId, itemId: kase.itemId }) ?? "")}
                    caseUrl={ebayOrderUrl(kase.orderId)}
                    caseLabel={`Order ${kase.orderId} on eBay`}
                  />
                )}
                {/* US-2929: one thread, not two rows. A seller looking at a
                    return and a case on the same order has no way to tell they
                    are the same argument unless we say so. */}
                {kase.escalatedFrom && (
                  <p className="text-xs text-muted-foreground">
                    Escalated from{" "}
                    <a
                      className="underline"
                      href={ebayReturnUrl(kase.escalatedFrom)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {kase.escalatedFrom}
                    </a>
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Opened {fmtDate(kase.creationDate)}
                  {kase.buyerUsername ? ` by ${kase.buyerUsername}` : ""}
                </p>
              </div>
              {!showClosed && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    aria-label={`Add tracking for case ${kase.caseId}`}
                    size="sm"
                    disabled={!!busy}
                    onClick={() => setTrackingFor(kase)}
                  >
                    <Truck className="mr-1 h-4 w-4" />
                    Add tracking
                  </Button>
                  <Button
                    aria-label={`Appeal case ${kase.caseId}`}
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => setAppealFor(kase)}
                  >
                    <Gavel className="mr-1 h-4 w-4" />
                    Appeal
                  </Button>
                  <Button
                    aria-label={`Refund the buyer on case ${kase.caseId}`}
                    size="sm"
                    variant="destructive"
                    disabled={!!busy}
                    onClick={() => run(kase, "refund")}
                  >
                    {busy === `${kase.caseId}:refund` ? (
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
      <TrackingDialog
        open={!!trackingFor}
        onOpenChange={(v) => !v && setTrackingFor(null)}
        busy={!!busy}
        onSubmit={(carrier, trackingNumber, comments) => {
          if (trackingFor) {
            void run(trackingFor, "shipment", { carrier, trackingNumber, comments });
          }
        }}
      />
      <Dialog open={!!appealFor} onOpenChange={(v) => !v && setAppealFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Appeal this case</DialogTitle>
            <DialogDescription>
              eBay rejects an appeal with no argument, so say what it got wrong and
              point at the evidence. The appeal window is short.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Your appeal argument"
            value={appealText}
            onChange={(e) => setAppealText(e.target.value)}
            rows={5}
            placeholder="Tracking shows delivered on 12 August, signed for."
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAppealFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={!appealText.trim() || !!busy}
              onClick={() => {
                if (appealFor) void run(appealFor, "appeal", { comments: appealText.trim() });
              }}
            >
              {busy?.endsWith(":appeal") ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              Submit appeal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}


/**
 * US-2932: the keep-it suggestion, with its arithmetic on show.
 *
 * Renders NOTHING when the item's cost basis is unknown. That is the whole
 * discipline of this component: a suggested refund with no cost behind it looks
 * identical to one that was computed, and it sits next to a button that moves
 * money. Silence is the honest output.
 */
function KeepItHint({
  item,
  onUse,
}: {
  item: CaseItem | undefined;
  onUse: (cents: number) => void;
}) {
  const suggestion = suggestKeepItRefund({
    salePriceCents: item?.salePrice != null ? Math.round(item.salePrice * 100) : null,
    acquiredPriceCents: item?.acquiredPrice != null
      ? Math.round(item.acquiredPrice * 100)
      : null,
  });
  if (!suggestion) return null;
  return (
    <div className="basis-full text-xs text-muted-foreground">
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => onUse(suggestion.suggestedCents)}
        aria-label={`Use the suggested keep-it refund of ${centsToDisplay(suggestion.suggestedCents)}`}
      >
        Suggest {centsToDisplay(suggestion.suggestedCents)}
      </button>{" "}
      — taking this return back costs you about{" "}
      {centsToDisplay(suggestion.ceilingCents)} once you add{" "}
      {centsToDisplay(suggestion.returnShippingCents)} of return postage, so
      anything under that is the cheaper outcome.
    </div>
  );
}

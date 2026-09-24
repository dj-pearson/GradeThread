import { useEffect, useMemo, useRef, useState } from "react";
import {
  byDeadline,
  canMarkReceived,
  deadlineBucket,
  deadlineLabel,
  isNotAsDescribed,
  returnAllows,
  returnWaitingOnBuyer,
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
  orderTotalLabel,
  refundReasonFor,
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
import { QueueBody } from "@/components/flipdesk/post-sale/queue-body";
import { InlineRetry } from "@/components/flipdesk/inline-retry";
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
import { ReturnAnalyticsCard } from "@/components/flipdesk/return-analytics-card";
import { ShipQueueCard } from "@/components/flipdesk/ship-queue-card";
import { useSearchParams } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNeedsYou } from "@/hooks/use-needs-you";
import { useFocusParam } from "@/hooks/use-focus-param";
import {
  DEFAULT_POST_SALE_TAB,
  POST_SALE_QUEUES,
  POST_SALE_TABS,
  postSaleTabCounts,
  QUEUE_NOUN,
  resolvePostSaleTabId,
  type PostSaleTabId,
  tabForKind,
  tabLoadState,
  type TabLoadState,
} from "@/pages/flipdesk/post-sale-tabs";
import {
  centsToDisplay,
  suggestKeepItRefund,
} from "@/pages/flipdesk/keep-it-offer";
import {
  detectCarrier,
  normalizeTracking,
  SHIP_CARRIERS,
  stripUspsZipPrefix,
  type ShipCarrier,
} from "@/pages/flipdesk/ship-queue";

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
    // US-3190: the ship queue still renders. It reads the seller's own sales
    // rows rather than calling eBay, so a seller recording sales by hand has
    // the same deadline list as a connected one — and shipping late costs them
    // just as much.
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-3 py-8 text-center">
          <h1 className="text-xl font-semibold">Sold & Shipping</h1>
          <p className="text-sm text-muted-foreground">
            Connect your eBay account. Then handle cases, returns and disputes
            from here.
          </p>
          <Button asChild variant="outline">
            <a href="/dashboard/flipdesk/marketplaces">Go to Marketplaces</a>
          </Button>
        </div>
        <ShipQueueCard />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Sold & Shipping"
        subtitle="Pack what sold, then handle anything the buyer raised. The number on each tab is what is waiting on you."
              actions={<PageHelp slug="returns-and-disputes" />}
      />
      {/* US-2541: same reasoning as the offers screen. An empty returns list
          is the one a seller most wants to trust. */}
      <PlatformCoverageNote
        feature="post_sale"
        noun="Returns, cancellations and disputes"
      />
      <PostSaleTabs />
    </div>
  );
}

/**
 * US-3208: one section on screen, chosen by a tab, instead of seven stacked.
 *
 * The page used to render every card at once: 47,811px of content in a 911px
 * window, which is fifty-two screens, with the ship queue starting on screen 16
 * and payment disputes on screen 48. Nothing about the cards was wrong; there
 * were simply seven of them and no one had measured the total.
 *
 * WHAT REPLACED THE 215-ROW LIST. NeedsYouCard opened the page with every open
 * item across all seven queues, ranked. A seller read it to answer "where is the
 * work", and the tab badges answer that in six numbers instead of two hundred
 * rows — from the SAME merged list, so a badge cannot disagree with what its tab
 * opens. The ranked list itself still exists on the Overview attention rail,
 * which is where a cross-page ranking belongs.
 *
 * The tab lives in `?tab=`, like the inventory table, so a tab is a link a
 * seller can bookmark or send to a teammate. Old `#payment-disputes` style
 * anchors resolve too (see resolvePostSaleTabId).
 */
function PostSaleTabs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: PostSaleTabId =
    resolvePostSaleTabId(searchParams.get("tab")) ?? DEFAULT_POST_SALE_TAB;

  // One hook for every badge. It is the same merged query the ranked card used,
  // so opening this page costs no more reads than it did before.
  // PS-11: offers are not on this page, so they are neither fetched nor
  // polled here, and cannot hold the page in a loading state.
  const needsYou = useNeedsYou(true, true, { include: POST_SALE_QUEUES });
  const counts = postSaleTabCounts(needsYou.items);
  const failedQueues = POST_SALE_QUEUES.filter((q) => needsYou.queues[q]?.isError);

  function setTab(next: PostSaleTabId, keepFocus = false) {
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    // A tab the seller picks drops ?focus=: the link's job is done, and a
    // focus left in the URL would keep pulling them back to its tab.
    if (!keepFocus) params.delete("focus");
    // replace: tabbing is looking around, not navigation. Twelve taps through
    // the tabs should not mean twelve presses of the back button to leave.
    setSearchParams(params, { replace: true });
  }

  // DASH-15: `?focus=<id>` from a Needs-you row on the Overview. Open the tab
  // that owns the item (a link without `?tab=` still lands right), then the
  // hook scrolls to the row, highlights it and moves focus to it.
  const focusParam = searchParams.get("focus");
  const focusItem = focusParam
    ? needsYou.items.find((i) => i.id === focusParam) ?? null
    : null;
  const focusTab = focusItem ? tabForKind(focusItem.kind) : null;
  useEffect(() => {
    if (focusTab && focusTab !== tab) setTab(focusTab, true);
    // setTab is recreated each render; the tab it moves to is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTab, tab]);
  const queuesLoaded = !needsYou.isLoading && needsYou.pending.length === 0;
  useFocusParam({
    ready: queuesLoaded,
    // Only once its tab is showing, so the row exists to be found.
    known: focusItem != null && (focusTab == null || focusTab === tab),
  });
  // Not while a queue failed: the item may be in the queue that did not
  // answer, and "no longer open" would be a guess stated as fact.
  const focusMissing = !!focusParam && queuesLoaded && !needsYou.isPartial &&
    focusItem == null;

  return (
    <>
      {focusMissing ? (
        <p className="mb-3 text-sm text-muted-foreground" role="status">
          This case is no longer open. It may have been resolved or closed on
          eBay.
        </p>
      ) : null}
      {/* PS-11: which queues did not answer, in words, with one Retry. A tab
          that failed carries a warning mark, and this line says what it is. */}
      {failedQueues.length > 0 ? (
        <div className="mb-3">
          <InlineRetry
            message={`Couldn't load ${joinWords(failedQueues.map((q) => QUEUE_NOUN[q]))}. What is waiting there may not be counted.`}
            onRetry={needsYou.refetch}
          />
        </div>
      ) : null}
      <Tabs value={tab} onValueChange={(v) => setTab(v as PostSaleTabId)}>
        <TabsList className="flex flex-wrap">
          {POST_SALE_TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="gap-2">
              {t.label}
              {t.kinds.length > 0 ? (
                <TabMarker
                  load={tabLoadState(t.id, needsYou.queues)}
                  count={counts[t.id]}
                  active={tab === t.id}
                />
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === "ship" && <ShipQueueCard />}
      {tab === "disputes" && <DisputesCard />}
      {/* eBay files these two separately; a seller does not. */}
      {tab === "cases" && (
        <>
          <CasesCard />
          <InquiriesCard />
        </>
      )}
      {tab === "returns" && <ReturnsCard />}
      {tab === "cancellations" && <CancellationsCard />}
      {tab === "insights" && <ReturnAnalyticsCard />}
    </>
  );
}

/**
 * PS-11: one tab's marker. Loading and failed each say so, and a count only
 * appears once every queue behind the tab has answered. A "0" that is really
 * "not known yet" reads as "nothing waiting", which is the one wrong answer
 * this page must not give, so an answered zero shows no badge at all.
 */
function TabMarker({
  load,
  count,
  active,
}: {
  load: TabLoadState;
  count: number;
  active: boolean;
}) {
  if (load === "loading") {
    return (
      <span className="text-xs text-muted-foreground">
        <span aria-hidden="true">...</span>
        <span className="sr-only">loading</span>
      </span>
    );
  }
  if (load === "error") {
    return (
      <span className="inline-flex items-center">
        <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 text-destructive" />
        <span className="sr-only">could not load</span>
      </span>
    );
  }
  if (count <= 0) return null;
  return (
    <Badge
      variant={active ? "default" : "secondary"}
      className="px-1.5 py-0 text-[10px] tabular-nums"
    >
      {count.toLocaleString()}
      <span className="sr-only"> waiting on you</span>
    </Badge>
  );
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

// ── Payment disputes (most urgent — deadline-driven) ────────────────

function DisputesCard() {
  const confirm = useConfirm();
  const disputesQuery = useEbayPaymentDisputes();
  const { data: disputes = [] } = disputesQuery;
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
  ): Promise<boolean> {
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
      return true;
    } catch (err) {
      toastError(err, "Action failed.");
      return false;
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
    // US-2935: contesting is the moment the grade report is the argument.
    // PS-13: the pack now opens INSIDE the Contest dialog (below), because the
    // inline one this used to open sat under the modal, and the seller wrote
    // the note blind to the verdict.
    setPackFor(null);
    setContestFor(d);
  }

  async function submitContest() {
    const d = contestFor;
    if (!d) return;
    const note = contestNote.trim() || undefined;
    // PS-13: the dialog stays open until eBay answers, so a failure leaves the
    // note where the seller typed it instead of throwing it away.
    if (await runResolve(d, "contest", note)) setContestFor(null);
  }

  return (
    <Card id="payment-disputes" className="border-brand-red/30">
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
        <QueueBody
          isLoading={disputesQuery.isLoading}
          isError={disputesQuery.isError}
          isSuccess={disputesQuery.isSuccess}
          refetch={disputesQuery.refetch}
          source={disputesQuery.source}
          updatedAt={disputesQuery.dataUpdatedAt}
          isEmpty={visible.length === 0}
          emptyText={showClosed ? "No closed payment disputes." : "No open payment disputes."}
          kind="payment disputes"
        >
          {visible.map((d) => {
            const orderLabel = d.orderId ?? d.paymentDisputeId;
            return (
              // PS-13: stacked like the returns rows. Side by side, five buttons
              // in a row that could not wrap ran off a 375px screen.
              <div
                key={d.paymentDisputeId}
                data-focus-id={d.paymentDisputeId}
                className="flex flex-col gap-3 rounded-md border p-3 data-[focused=true]:ring-2 data-[focused=true]:ring-primary focus-visible:outline-none"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {d.reason?.replace(/_/g, " ") ?? "Payment dispute"}
                    </span>
                    {d.amount != null && (
                      <Badge variant="secondary">
                        {d.currency ?? "$"} {d.amount.toFixed(2)}
                      </Badge>
                    )}
                    <DeadlineBadge respondBy={d.respondByDate} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Order {d.orderId ?? "—"}
                    {d.buyerUsername ? ` · ${d.buyerUsername}` : ""}
                  </p>
                </div>
                {/* US-2227: a closed dispute keeps no actions — Accept refunds the
                    buyer, and Contest is meaningless once eBay has decided. */}
                {!showClosed && (
                <div className="flex flex-wrap gap-2">
                  <EvidenceUploader disputeId={d.paymentDisputeId} disabled={!!busy} />
                  {/* US-2707: the same review-before-send pack the returns list
                      offers. The rarer path is not the one where GradeThread
                      hands the seller a file picker and no verdict. */}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    aria-label={`Grade pack for order ${d.orderId ?? "unknown"}`}
                    aria-expanded={packFor === d.paymentDisputeId}
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
                    aria-label={`Contest the dispute on order ${orderLabel}`}
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
                    aria-label={`Accept and refund order ${orderLabel}`}
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
                    initialComplaint={d.reason ?? ""}
                    autoCheck={isNotAsDescribed(d.reason)}
                  />
                )}
              </div>
            );
          })}
        </QueueBody>
      </CardContent>

      <Dialog
        open={!!contestFor}
        onOpenChange={(open) => {
          if (!open && !busy) setContestFor(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Contest payment dispute</DialogTitle>
            <DialogDescription>
              {contestFor?.orderId ? `Order ${contestFor.orderId}. ` : ""}
              Add a short note for eBay explaining why you're contesting this
              dispute. It's sent to eBay with your response.
            </DialogDescription>
          </DialogHeader>
          {/* PS-13: the grade pack, in view while the seller writes the
              argument it is evidence for. */}
          {contestFor && (
            <ReturnEvidencePanel
              caseId={contestFor.paymentDisputeId}
              orderId={contestFor.orderId}
              kind="dispute"
              initialComplaint={contestFor.reason ?? ""}
              autoCheck={isNotAsDescribed(contestFor.reason)}
            />
          )}
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
            <Button variant="outline" disabled={!!busy} onClick={() => setContestFor(null)}>
              Cancel
            </Button>
            <Button disabled={!!busy} onClick={submitContest}>
              {busy?.endsWith(":contest") ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              Contest dispute
            </Button>
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
  const confirm = useConfirm();
  const returnsQuery = useEbayReturns();
  const { data: returns = [] } = returnsQuery;
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
  const { data: orderTotalInfo, isError: orderTotalError, isLoading: orderTotalLoading, refetch: reloadOrderTotal } = useEbayOrderTotal(partialOrderId);
  // PS-05: across every line of the order, not one sales row.
  const orderTotal = orderTotalInfo?.total ?? null;
  const orderCurrency = orderTotalInfo?.currency ?? null;
  // PS-05: the validation message sits under the box it is about, instead of
  // only in a toast that is gone before the seller reads it.
  const [partialError, setPartialError] = useState<string | null>(null);

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
    // US-2935: declining a condition complaint is the moment the grade report
    // is worth reading, and it is the moment a seller is least likely to go
    // looking for it. First press opens the pack, already checked; the second
    // declines. A read, not a send — nothing leaves for eBay here.
    if (
      decision === "decline" &&
      isNotAsDescribed(r.reason) &&
      r.orderId &&
      evidenceFor !== r.returnId
    ) {
      setEvidenceFor(r.returnId);
      toast.info("Checked your grade report below. Press Decline again to go ahead.");
      return;
    }
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
    if (orderTotalError || orderTotalLoading) {
      toast.error("Wait for the order total to load before sending a refund.");
      return;
    }
    if (!r.orderId) {
      toast.error("This return has no order id, so we can't refund against it.");
      return;
    }
    const v = validateRefundAmount(partialAmount, orderTotal);
    if (!v.ok) {
      setPartialError(v.error ?? "Enter a valid refund amount.");
      return;
    }
    // A full amount through this route refunds the buyer and leaves the return
    // sitting OPEN — two different eBay conversations. Send the seller to the
    // button that closes the case instead of quietly doing the wrong one.
    if (isFullRefund(v.cents, orderTotal)) {
      setPartialError("That is the whole order. Use Refund to close the return instead.");
      return;
    }
    // PS-05: the amount goes to eBay in the sale's own currency. Lines that
    // disagree leave it unknown, and a guess here would move the wrong money.
    if (!orderCurrency) {
      setPartialError(
        "This order's lines are in different currencies, so we can't send a partial refund. Refund from eBay directly.",
      );
      return;
    }
    setPartialError(null);
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
        reason: refundReasonFor(r.reason),
        amountValue: centsToEbayValue(v.cents),
        currency: orderCurrency,
      });
      toast.success(`Refunded ${centsToEbayValue(v.cents)}.`);
      setPartialFor(null);
      setPartialAmount("");
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
    } catch (err) {
      toastError(err, "Refund failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card id="returns">
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
        <QueueBody
          isLoading={returnsQuery.isLoading}
          isError={returnsQuery.isError}
          isSuccess={returnsQuery.isSuccess}
          refetch={returnsQuery.refetch}
          source={returnsQuery.source}
          updatedAt={returnsQuery.dataUpdatedAt}
          isEmpty={visible.length === 0}
          emptyText={showClosed ? "No closed returns." : "No open returns."}
          kind="returns"
        >
          {visible.map((r) => (
            // US-3466: always stacked. Side by side, eight buttons in a
            // shrink-0 row could not wrap, so on desktop they ran past the
            // card edge and squeezed the details into a one-word column.
            <div
              key={r.returnId}
              data-focus-id={r.returnId}
              className="flex flex-col gap-3 rounded-md border p-3 data-[focused=true]:ring-2 data-[focused=true]:ring-primary focus-visible:outline-none"
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
              {!showClosed && returnWaitingOnBuyer(r.sellerActions) && (
                <p className="text-xs text-muted-foreground">
                  Nothing for you to do right now. eBay is waiting on the buyer.
                </p>
              )}
              {!showClosed && (
              <div className="flex flex-wrap gap-2">
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
                {canMarkReceived(r.state, !!r.label?.trackingNumber) &&
                  returnAllows(r.sellerActions, "received") && (
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
                {returnAllows(r.sellerActions, "decline") && (
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
                  {evidenceFor === r.returnId ? "Decline anyway" : "Decline"}
                </Button>
                )}
                {returnAllows(r.sellerActions, "approve") && (
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
                )}
                {returnAllows(r.sellerActions, "refund") && (
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
                )}
                {/* US-2932: message the buyer inside the RETURN. eBay reads
                    this thread when it decides a case; the Offers inbox is a
                    different conversation it cannot see. */}
                {returnAllows(r.sellerActions, "message") && (
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
                )}
                {/* US-2227: the keep-it discount. Separate from Refund because
                    it is a different eBay call with a different outcome — this
                    one leaves the return open. */}
                {returnAllows(r.sellerActions, "partial") && (
                <Button
                aria-label={`Partial refund for ${r.reason?.replace(/_/g, " ") ?? "the return"}`}
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => {
                    setPartialAmount("");
                    setPartialError(null);
                    setPartialFor(partialFor === r.returnId ? null : r.returnId);
                  }}
                >
                  Refund part now…
                </Button>
                )}
                {/* US-2706: the grade evidence. Opens a review panel and sends
                    nothing until the seller reads the verdict and clicks — the
                    useful outcome of this feature is often "do not fight". */}
                <Button
                aria-label={`Evidence for ${r.reason?.replace(/_/g, " ") ?? "the return"}`}
                  aria-expanded={evidenceFor === r.returnId}
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
                  initialComplaint={r.reason ?? ""}
                  autoCheck={isNotAsDescribed(r.reason)}
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
                    aria-invalid={partialError ? true : undefined}
                    aria-describedby={partialError
                      ? `partial-${r.returnId}-total partial-${r.returnId}-error`
                      : `partial-${r.returnId}-total`}
                    onChange={(e) => {
                      setPartialAmount(e.target.value);
                      setPartialError(null);
                    }}
                  />
                  <span id={`partial-${r.returnId}-total`} className="text-xs text-muted-foreground">
                    {orderTotalError
                      ? "Couldn't load the order total"
                      : orderTotalLoading
                        ? "Loading order total..."
                        : orderTotal != null
                          ? orderTotalLabel(orderTotal, orderCurrency, orderTotalInfo?.lineCount ?? 1)
                          : "order total unavailable"}
                  </span>
                  <Button
                    size="sm"
                    disabled={!!busy || orderTotalError || orderTotalLoading}
                    onClick={() => issuePartialRefund(r)}
                  >
                    {busy === `${r.returnId}:partial` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Send
                  </Button>
                  {partialError && (
                    <p
                      id={`partial-${r.returnId}-error`}
                      role="alert"
                      className="basis-full text-xs text-destructive"
                    >
                      {partialError}
                    </p>
                  )}
                  {orderTotalError && (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Retry loading the order total for ${r.reason?.replace(/_/g, " ") ?? "this return"}`}
                      onClick={() => void reloadOrderTotal()}
                    >
                      Retry order total
                    </Button>
                  )}
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
          ))}
        </QueueBody>
      </CardContent>
    </Card>
  );
}

// ── Cancellations ───────────────────────────────────────────────────

function CancellationsCard() {
  const confirm = useConfirm();
  const cancellationsQuery = useEbayCancellations();
  const { data: cancellations = [] } = cancellationsQuery;
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
    } catch (err) {
      toastError(err, "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card id="cancellations">
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
        <QueueBody
          isLoading={cancellationsQuery.isLoading}
          isError={cancellationsQuery.isError}
          isSuccess={cancellationsQuery.isSuccess}
          refetch={cancellationsQuery.refetch}
          source={cancellationsQuery.source}
          updatedAt={cancellationsQuery.dataUpdatedAt}
          isEmpty={visible.length === 0}
          emptyText={showClosed ? "No closed cancellation requests." : "No open cancellation requests."}
          kind="cancellation requests"
        >
          {visible.map((ca) => (
            <div
              key={ca.cancelId}
              data-focus-id={ca.cancelId}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between data-[focused=true]:ring-2 data-[focused=true]:ring-primary focus-visible:outline-none"
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
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  aria-label={`Reject the cancellation on order ${ca.orderId ?? ca.cancelId}`}
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
                  aria-label={`Approve and cancel order ${ca.orderId ?? ca.cancelId}`}
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
          ))}
        </QueueBody>
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

/**
 * Add-tracking dialog. The action that settles most INR inquiries and cases.
 *
 * PS-02: callers mount it with a `key` per case. Its fields are local state,
 * and one instance kept mounted across cases opened the next inquiry with the
 * last order's tracking already typed in and Send enabled.
 */
function TrackingDialog({
  open,
  onOpenChange,
  onSubmit,
  busy,
  orderId,
  itemTitle,
  shipped,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (carrier: string, trackingNumber: string, comments: string) => void;
  busy: boolean;
  /** Which parcel this is for, so the seller can check before sending. */
  orderId: string | null;
  itemTitle: string | null;
  /**
   * PS-14: what the Ship tab already stored for this order. Starting from it
   * makes the usual item-not-received answer one click. Mounted per case
   * (PS-02), so these are real initial values rather than stale ones.
   */
  shipped?: { trackingNumber: string | null; carrier: string | null; shippedAt: string | null };
}) {
  const initialTracking = shipped?.trackingNumber ?? "";
  const [carrier, setCarrier] = useState<ShipCarrier | "">(
    () => carrierFromStored(shipped?.carrier) ?? detectCarrier(initialTracking) ?? "",
  );
  const [carrierPicked, setCarrierPicked] = useState(false);
  const [tracking, setTracking] = useState(initialTracking);
  const [comments, setComments] = useState("");
  const ready = carrier.length > 0 && normalizeTracking(tracking).length > 0;
  const fromShipTab = initialTracking !== "" && tracking === initialTracking;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send tracking to eBay</DialogTitle>
          <DialogDescription>
            {orderId
              ? `For order ${orderId}${itemTitle ? `: ${itemTitle}` : ""}. `
              : ""}
            eBay accepts this as proof the parcel is on its way. It is what closes
            most item-not-received cases without a refund.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="po-tracking">Tracking number</Label>
            <Input
              id="po-tracking"
              value={tracking}
              onChange={(e) => {
                setTracking(e.target.value);
                if (!carrierPicked) {
                  setCarrier(detectCarrier(e.target.value) ?? carrier);
                }
              }}
              placeholder="9400 1000 0000 0000 0000 00"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={fromShipTab ? "po-tracking-source" : undefined}
            />
            {fromShipTab ? (
              <p id="po-tracking-source" className="text-xs text-muted-foreground">
                From your Ship tab
                {shipped?.shippedAt ? `, shipped ${fmtDate(shipped.shippedAt)}` : ""}.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="po-carrier">Carrier</Label>
            <select
              id="po-carrier"
              value={carrier}
              onChange={(e) => {
                setCarrier(e.target.value as ShipCarrier | "");
                setCarrierPicked(true);
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Choose a carrier</option>
              {SHIP_CARRIERS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
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
            onClick={() => onSubmit(carrier, stripUspsZipPrefix(tracking), comments.trim())}
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Send tracking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A carrier stored on the sale, as one of the pick-list values. */
function carrierFromStored(raw: string | null | undefined): ShipCarrier | null {
  const key = (raw ?? "").trim().toLowerCase();
  if (!key) return null;
  return SHIP_CARRIERS.find((c) => c.toLowerCase() === key) ?? "Other";
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
  const inquiriesQuery = useEbayInquiries();
  const { data: inquiries = [] } = inquiriesQuery;
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
        // PS-03: an item-not-received refund no longer restocks the garment.
        description:
          "This refunds the order on eBay and settles the inquiry. The item stays marked sold, since it never came back. It can't be undone.",
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
    <Card id="item-not-received">
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
        <QueueBody
          isLoading={inquiriesQuery.isLoading}
          isError={inquiriesQuery.isError}
          isSuccess={inquiriesQuery.isSuccess}
          refetch={inquiriesQuery.refetch}
          source={inquiriesQuery.source}
          updatedAt={inquiriesQuery.dataUpdatedAt}
          isEmpty={visible.length === 0}
          emptyText={showClosed ? "No closed inquiries." : "No open item-not-received inquiries."}
          kind="item-not-received inquiries"
        >
          {visible.map((inq) => (
            <div
              key={inq.inquiryId}
              data-focus-id={inq.inquiryId}
              className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between data-[focused=true]:ring-2 data-[focused=true]:ring-primary focus-visible:outline-none"
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
          ))}
        </QueueBody>
      </CardContent>
      <TrackingDialog
        key={trackingFor ? trackingFor.inquiryId : "none"}
        open={!!trackingFor}
        onOpenChange={(v) => !v && setTrackingFor(null)}
        busy={!!busy}
        orderId={trackingFor?.orderId ?? null}
        itemTitle={trackingFor
          ? caseItems?.get(caseItemKey(trackingFor) ?? "")?.title ?? null
          : null}
        shipped={trackingFor
          ? caseItems?.get(caseItemKey(trackingFor) ?? "") ?? undefined
          : undefined}
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
  const casesQuery = useEbayCases();
  const { data: cases = [] } = casesQuery;
  const act = useEbayCaseAction();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [trackingFor, setTrackingFor] = useState<EbayCase | null>(null);
  const [appealFor, setAppealFor] = useState<EbayCase | null>(null);
  const [appealText, setAppealText] = useState("");
  // US-2935: which case's grade pack is open. One at a time — two open packs is
  // two complaint boxes and a good way to send the wrong one.
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
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

  function closeAppeal() {
    setAppealFor(null);
    setAppealText("");
  }

  async function run(
    kase: EbayCase,
    action: "shipment" | "refund" | "appeal" | "close",
    extra?: { carrier?: string; trackingNumber?: string; comments?: string },
  ) {
    if (action === "refund") {
      const ok = await confirm({
        title: "Refund the buyer and settle the case?",
        // PS-03: the edge restocks only when the case is about an item the
        // buyer sent back, so the copy says which one this is.
        description: /NOT_RECEIVED/i.test(kase.reason ?? "")
          ? "This refunds the order on eBay and closes the case. The item stays marked sold, since it never came back. It can't be undone."
          : "This refunds the order on eBay and closes the case. It can't be undone.",
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
    <Card id="ebay-cases">
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
        <QueueBody
          isLoading={casesQuery.isLoading}
          isError={casesQuery.isError}
          isSuccess={casesQuery.isSuccess}
          refetch={casesQuery.refetch}
          source={casesQuery.source}
          updatedAt={casesQuery.dataUpdatedAt}
          isEmpty={visible.length === 0}
          emptyText={showClosed ? "No closed cases." : "No open eBay cases."}
          kind="eBay cases"
        >
          {visible.map((kase) => (
            // PS-13: stacked, like returns and disputes.
            <div
              key={kase.caseId}
              data-focus-id={kase.caseId}
              className="flex flex-col gap-3 rounded-md border p-3 data-[focused=true]:ring-2 data-[focused=true]:ring-primary focus-visible:outline-none"
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
                  {/* US-2935: the pack, on the surface that costs a defect.
                      Opens a review panel and sends nothing until the seller
                      reads the verdict and clicks — and refuses outright when
                      our own report agrees with the buyer. */}
                  <Button
                    aria-label={`Grade evidence for case ${kase.caseId}`}
                    aria-expanded={evidenceFor === kase.caseId}
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() =>
                      setEvidenceFor(evidenceFor === kase.caseId ? null : kase.caseId)}
                  >
                    Evidence…
                  </Button>
                  <Button
                    aria-label={`Appeal case ${kase.caseId}`}
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => {
                      // PS-02: case B must not open with case A's argument.
                      setAppealText("");
                      // The appeal argument IS the evidence. PS-13: the pack
                      // opens inside the Appeal dialog, not under it.
                      setEvidenceFor(null);
                      setAppealFor(kase);
                    }}
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
              {evidenceFor === kase.caseId && !showClosed && (
                <ReturnEvidencePanel
                  caseId={kase.caseId}
                  orderId={kase.orderId}
                  kind="case"
                  initialComplaint={kase.reason ?? ""}
                  autoCheck={isNotAsDescribed(kase.reason)}
                />
              )}
            </div>
          ))}
        </QueueBody>
      </CardContent>
      <TrackingDialog
        key={trackingFor ? trackingFor.caseId : "none"}
        open={!!trackingFor}
        onOpenChange={(v) => !v && setTrackingFor(null)}
        busy={!!busy}
        orderId={trackingFor?.orderId ?? null}
        itemTitle={trackingFor
          ? caseItems?.get(caseItemKey(trackingFor) ?? "")?.title ?? null
          : null}
        shipped={trackingFor
          ? caseItems?.get(caseItemKey(trackingFor) ?? "") ?? undefined
          : undefined}
        onSubmit={(carrier, trackingNumber, comments) => {
          if (trackingFor) {
            void run(trackingFor, "shipment", { carrier, trackingNumber, comments });
          }
        }}
      />
      <Dialog open={!!appealFor} onOpenChange={(v) => !v && !busy && closeAppeal()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Appeal this case</DialogTitle>
            <DialogDescription>
              {appealFor?.orderId ? `Order ${appealFor.orderId}. ` : ""}
              eBay rejects an appeal with no argument, so say what it got wrong and
              point at the evidence. The appeal window is short.
            </DialogDescription>
          </DialogHeader>
          {appealFor && (
            <ReturnEvidencePanel
              caseId={appealFor.caseId}
              orderId={appealFor.orderId}
              kind="case"
              initialComplaint={appealFor.reason ?? ""}
              autoCheck={isNotAsDescribed(appealFor.reason)}
            />
          )}
          <Textarea
            aria-label="Your appeal argument"
            value={appealText}
            onChange={(e) => setAppealText(e.target.value)}
            rows={5}
            placeholder="Tracking shows delivered on 12 August, signed for."
          />
          <DialogFooter>
            <Button variant="outline" disabled={!!busy} onClick={closeAppeal}>
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

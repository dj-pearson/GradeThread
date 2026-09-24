import { useCallback, useMemo } from "react";
import {
  rankNeedsYou,
  type NeedsYouItem,
  type NeedsYouKind,
} from "@/pages/flipdesk/needs-you";
import { isClosedCase, splitByOpenState } from "@/pages/flipdesk/post-sale-state";
import { tabForKind } from "@/pages/flipdesk/post-sale-tabs";
import {
  useEbayBestOffers,
  useEbayCancellations,
  useEbayCases,
  useEbayInquiries,
  useEbayPaymentDisputes,
  useEbayReturns,
} from "@/hooks/use-ebay";
import { useShipQueue } from "@/hooks/use-ship-queue";

// US-3077 AC1: the six-queue merge, out of the card that used to own it.
//
// NeedsYouCard on /post-sale and the flipdesk.needs-you widget on the overview
// show the same ranked list, and before this the merge lived inside the card's
// render. A second consumer would have meant a second copy of six queue shapes
// mapped onto NeedsYouItem -- six chances for the two surfaces to disagree
// about what "open" means or which field carries the deadline.
//
// The RANKING is still src/pages/flipdesk/needs-you.ts, pure and tested on its
// own. This hook is only the reading and the mapping: which queries to run,
// how each queue's row becomes a NeedsYouItem, and which of the six is still
// in flight or failed. Nothing here sorts.

/** The six queues, so a caller can say which one is missing rather than "some". */
export const NEEDS_YOU_QUEUES = [
  "returns",
  "cancellations",
  "inquiries",
  "cases",
  "disputes",
  "offers",
  // US-3190: unshipped orders. Unlike the other six this one is a plain read of
  // the seller's own sales rows rather than an eBay call, so it answers fast and
  // is never the queue the card is waiting on.
  "shipments",
] as const;

export type NeedsYouQueue = (typeof NEEDS_YOU_QUEUES)[number];

/** Loading and error for one queue, so a partial failure can be named. */
export interface NeedsYouQueueState {
  isLoading: boolean;
  isError: boolean;
}

export interface NeedsYouState {
  /** The merged, ranked list. Deadline first, then money (see needs-you.ts). */
  items: NeedsYouItem[];
  /** Per-queue flags. A caller decides which subset it waits on. */
  queues: Record<NeedsYouQueue, NeedsYouQueueState>;
  /**
   * No queue has answered yet. As soon as one has, this is false and the
   * rows it brought render; `pending` names the ones still in flight, so one
   * slow eBay call no longer hides shipments that already loaded.
   */
  isLoading: boolean;
  /** The queues still in flight, in NEEDS_YOU_QUEUES order. */
  pending: NeedsYouQueue[];
  /** Every one of the six failed: there is nothing to show and nothing to say. */
  isError: boolean;
  /** At least one queue failed. The list is real but incomplete. */
  isPartial: boolean;
  /** A refetch is running. */
  isFetching: boolean;
  /** Retry every queue. */
  refetch: () => void;
}

/**
 * Where each queue lives, as an ABSOLUTE path.
 *
 * Absolute because the widget renders on the Overview (/dashboard), where a
 * bare "#returns" scrolls to nothing. NeedsYouCard keeps its own relative map:
 * it renders ON post-sale, beside the cards these anchors name, and an absolute
 * link there would reload the page the seller is already looking at.
 */
export const NEEDS_YOU_HREF: Record<NeedsYouKind, string> = {
  case: "/dashboard/flipdesk/post-sale#ebay-cases",
  inquiry: "/dashboard/flipdesk/post-sale#item-not-received",
  dispute: "/dashboard/flipdesk/post-sale#payment-disputes",
  return: "/dashboard/flipdesk/post-sale#returns",
  cancellation: "/dashboard/flipdesk/post-sale#cancellations",
  offer: "/dashboard/flipdesk/offers",
  shipment: "/dashboard/flipdesk/post-sale#ship-queue",
};

/**
 * @param enabled  run any of the reads at all.
 * @param ebayEnabled  run the six eBay queues. A seller with no eBay
 *   connection gets a 502 from every one of them (ebay-client.ts
 *   getUserAccessToken), which used to read as "one of your eBay queues did
 *   not answer" on every load. Pass false for them; shipments still run.
 */
/**
 * DASH-15: a link to the exact item, not just its queue. The post-sale page
 * opens the item's tab from `?tab=` and finds the row from `?focus=`; offers
 * live on their own page and take `?focus=` alone.
 */
export function needsYouHref(item: Pick<NeedsYouItem, "kind" | "id">): string {
  const focus = `focus=${encodeURIComponent(item.id)}`;
  if (item.kind === "offer") return `/dashboard/flipdesk/offers?${focus}`;
  const tab = tabForKind(item.kind);
  return tab
    ? `/dashboard/flipdesk/post-sale?tab=${tab}&${focus}`
    : `/dashboard/flipdesk/post-sale?${focus}`;
}

export function useNeedsYou(enabled = true, ebayEnabled = true): NeedsYouState {
  const ebay = enabled && ebayEnabled;
  const returns = useEbayReturns(ebay);
  const cancellations = useEbayCancellations(ebay);
  const inquiries = useEbayInquiries(ebay);
  const cases = useEbayCases(ebay);
  const disputes = useEbayPaymentDisputes(ebay);
  const offers = useEbayBestOffers(ebay);
  const shipments = useShipQueue(enabled);

  const items = useMemo(() => {
    const out: NeedsYouItem[] = [];
    for (const r of splitByOpenState(returns.data ?? []).open) {
      out.push({
        kind: "return",
        id: r.returnId,
        subject: r.reason?.replace(/_/g, " ") ?? `Return ${r.returnId}`,
        deadline: r.respondBy ?? null,
        amountCents: null,
        action: "Approve, decline or refund",
      });
    }
    for (const ca of splitByOpenState(cancellations.data ?? []).open) {
      out.push({
        kind: "cancellation",
        id: ca.cancelId,
        subject: ca.reason?.replace(/_/g, " ") ?? `Order ${ca.orderId ?? ca.cancelId}`,
        // eBay's cancellation summary carries no deadline. Null rather than an
        // invented one — see the ranking module's undated-last rule.
        deadline: null,
        amountCents: null,
        action: "Approve or reject",
      });
    }
    for (const q of splitByOpenState(inquiries.data ?? []).open) {
      out.push({
        kind: "inquiry",
        id: q.inquiryId,
        subject: `Order ${q.orderId ?? q.inquiryId}`,
        deadline: q.respondBy,
        amountCents: null,
        action: "Add tracking",
      });
    }
    for (const k of splitByOpenState(cases.data ?? []).open) {
      out.push({
        kind: "case",
        id: k.caseId,
        subject: k.reason?.replace(/_/g, " ") ?? `Case ${k.caseId}`,
        deadline: k.respondBy,
        amountCents: k.amountCents,
        action: "Respond before eBay decides",
      });
    }
    for (const d of splitByOpenState(disputes.data ?? []).open) {
      out.push({
        kind: "dispute",
        id: d.paymentDisputeId,
        subject: d.reason?.replace(/_/g, " ") ?? `Order ${d.orderId ?? d.paymentDisputeId}`,
        deadline: d.respondByDate ?? null,
        amountCents: d.amount != null ? Math.round(d.amount * 100) : null,
        action: "Accept or contest",
      });
    }
    // Offers belong here for one reason: they expire, and an unanswered offer
    // is not a deferred decision, it is a lost sale.
    for (const o of offers.data ?? []) {
      if (o.status && isClosedCase({ state: o.status })) continue;
      out.push({
        kind: "offer",
        id: o.bestOfferId,
        subject: o.itemTitle || o.itemId,
        deadline: o.expiresAt ?? null,
        amountCents: o.price != null ? Math.round(o.price * 100) : null,
        action: "Accept, counter or decline",
      });
    }
    // US-3190: the shipping clock. Undated orders still enter the list — they
    // are real work — and rankNeedsYou sorts them last, which is the same
    // treatment a cancellation with no eBay deadline already gets.
    for (const sh of shipments.rows) {
      out.push({
        kind: "shipment",
        id: sh.id,
        subject: sh.title ?? `Order ${sh.orderRef ?? sh.id}`,
        deadline: sh.shipBy,
        amountCents: sh.salePrice != null ? Math.round(sh.salePrice * 100) : null,
        action: "Add tracking and ship",
      });
    }
    return rankNeedsYou(out);
  }, [
    returns.data,
    cancellations.data,
    inquiries.data,
    cases.data,
    disputes.data,
    offers.data,
    shipments.rows,
  ]);

  const queues: Record<NeedsYouQueue, NeedsYouQueueState> = useMemo(
    () => ({
      returns: { isLoading: returns.isLoading, isError: returns.isError },
      cancellations: {
        isLoading: cancellations.isLoading,
        isError: cancellations.isError,
      },
      inquiries: { isLoading: inquiries.isLoading, isError: inquiries.isError },
      cases: { isLoading: cases.isLoading, isError: cases.isError },
      disputes: { isLoading: disputes.isLoading, isError: disputes.isError },
      offers: { isLoading: offers.isLoading, isError: offers.isError },
      shipments: { isLoading: shipments.isLoading, isError: shipments.isError },
    }),
    [
      returns.isLoading,
      returns.isError,
      cancellations.isLoading,
      cancellations.isError,
      inquiries.isLoading,
      inquiries.isError,
      cases.isLoading,
      cases.isError,
      disputes.isLoading,
      disputes.isError,
      offers.isLoading,
      offers.isError,
      shipments.isLoading,
      shipments.isError,
    ],
  );

  // refetch() runs a query even when it is disabled, so the eBay six are
  // only retried when they are enabled. Otherwise Retry on a seller with no
  // eBay connection fires six calls that each 502, and turns a clean board
  // into "one of your eBay queues did not answer".
  const refetch = useCallback(() => {
    if (ebay) {
      void returns.refetch();
      void cancellations.refetch();
      void inquiries.refetch();
      void cases.refetch();
      void disputes.refetch();
      void offers.refetch();
    }
    if (enabled) void shipments.refetch();
  }, [ebay, enabled, returns, cancellations, inquiries, cases, disputes, offers, shipments]);

  const states = Object.values(queues);
  const answered = [
    returns,
    cancellations,
    inquiries,
    cases,
    disputes,
    offers,
    shipments,
  ].some((q) => q.data !== undefined);
  const pending = NEEDS_YOU_QUEUES.filter((q) => queues[q].isLoading);
  return {
    items,
    queues,
    pending,
    isLoading: pending.length > 0 && !answered,
    // Every queue down is an outage worth an error state. One queue down is
    // not: the others carry real work the seller still has to do, and
    // hiding it behind "could not load" would be the more expensive mistake.
    isError: states.every((s) => s.isError),
    isPartial: states.some((s) => s.isError),
    isFetching:
      returns.isFetching ||
      cancellations.isFetching ||
      inquiries.isFetching ||
      cases.isFetching ||
      disputes.isFetching ||
      offers.isFetching ||
      shipments.isFetching,
    refetch,
  };
}

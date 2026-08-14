// Marketplace-event poll (US-1055): the recurring source that surfaces NEW
// offers, returns, cancellation requests and payment disputes from eBay and
// notifies the seller.
//
// eBay's webhook stream tells us "something changed" but not "a return was just
// opened" with enough structure to notify cleanly, so a poll re-reads the open
// offers/returns/disputes for each connected seller and fires a notification the
// first time it sees each one. Idempotency is handled by claimMarketplaceEvent
// (a unique row per user+source+id+status), so re-polling the same open items
// never re-notifies.
//
// Tenant-scoped: every eBay read uses the connection owner's own access token
// (getUserAccessToken(ownerId)), so a poll can only ever read that owner's data.
// Each source is independent and best-effort — one seller's expired token or a
// disabled feature never breaks the others or the cron.

import { getBestOffers, type IncomingBestOffer } from "./ebay-trading.ts";
import {
  type CancellationSummary,
  type ReturnSummary,
  searchCancellations,
  searchReturns,
} from "./ebay-postorder.ts";
import { type PaymentDisputeSummary, searchPaymentDisputes } from "./ebay-disputes.ts";
import { isClosedCase } from "./post-sale-state.ts";
import {
  type CancellationRequestedEvent,
  claimMarketplaceEvent,
  type DisputeOpenedEvent,
  type MarketplaceEventKind,
  notifyCancellationRequested,
  notifyDisputeOpened,
  notifyOfferReceived,
  notifyReturnOpened,
  type OfferReceivedEvent,
  releaseMarketplaceEvent,
  type ReturnOpenedEvent,
} from "./marketplace-event-notify.ts";

export interface MarketplacePollResult {
  offers: number;
  returns: number;
  disputes: number;
  cancellations: number;
  errors: string[];
}

// Seams for testing: the eBay fetchers, the idempotency claim, and the three
// emitters. Defaults wire to the real implementations; a unit test injects fakes
// (e.g. a Set-backed claim) to prove dedup + per-source isolation.
export interface MarketplacePollDeps {
  fetchOffers: (userId: string) => Promise<IncomingBestOffer[]>;
  fetchReturns: (userId: string) => Promise<ReturnSummary[]>;
  fetchDisputes: (userId: string) => Promise<PaymentDisputeSummary[]>;
  // US-2560. Optional so every existing fake keeps type-checking; an omitted
  // fetcher yields no cancellations rather than a crash, which is the safe way
  // for a seam to default and is what the other optional deps here already do.
  fetchCancellations?: (userId: string) => Promise<CancellationSummary[]>;
  claim: (
    userId: string,
    kind: MarketplaceEventKind,
    externalId: string,
    status: string,
    notificationType: string,
    // US-2156: the marketplace item the event happened on (00508). Optional so
    // existing fakes keep type-checking.
    itemExternalId?: string | null,
  ) => Promise<boolean>;
  // US-2319 AC3: hand a claim back when the notification it was taken for
  // fails, so the next poll retries instead of treating the failure as a
  // delivery. Optional so existing fakes keep type-checking; when a test omits
  // it, a failed notify simply does not retry — the OLD behaviour, which is the
  // safe way for a seam to default.
  release?: (
    userId: string,
    kind: MarketplaceEventKind,
    externalId: string,
    status: string,
  ) => Promise<void>;
  notifyOffer: (ev: OfferReceivedEvent) => Promise<void>;
  notifyReturn: (ev: ReturnOpenedEvent) => Promise<void>;
  notifyDispute: (ev: DisputeOpenedEvent) => Promise<void>;
  notifyCancellation?: (ev: CancellationRequestedEvent) => Promise<void>;
}

const defaultDeps: MarketplacePollDeps = {
  fetchOffers: getBestOffers,
  fetchReturns: (userId) => searchReturns(userId, { limit: 100 }),
  fetchDisputes: (userId) => searchPaymentDisputes(userId, { limit: 100 }),
  fetchCancellations: (userId) => searchCancellations(userId, { limit: 100 }),
  claim: claimMarketplaceEvent,
  release: releaseMarketplaceEvent,
  notifyOffer: notifyOfferReceived,
  notifyReturn: notifyReturnOpened,
  notifyDispute: notifyDisputeOpened,
  notifyCancellation: notifyCancellationRequested,
};

// A dispute in one of these states still needs the seller's attention; CLOSED /
// resolved disputes are not worth a (late) notification.
const ACTIONABLE_DISPUTE_STATUSES = new Set([
  "OPEN",
  "ACTION_NEEDED",
  "ACTION_REQUIRED",
  "WAITING_FOR_SELLER_RESPONSE",
]);

/**
 * Poll one owner's open offers/returns/disputes and notify on each newly-seen
 * one. Returns per-source counts of notifications actually fired. Never throws —
 * per-source failures are collected into `errors`.
 */
export async function pollMarketplaceEventsForUser(
  ownerId: string,
  deps: MarketplacePollDeps = defaultDeps,
): Promise<MarketplacePollResult> {
  const result: MarketplacePollResult = {
    offers: 0,
    returns: 0,
    disputes: 0,
    cancellations: 0,
    errors: [],
  };

  // ── Offers ────────────────────────────────────────────────────────
  try {
    const offers = await deps.fetchOffers(ownerId);
    for (const offer of offers) {
      if (!offer.bestOfferId) continue;
      const fresh = await deps.claim(
        ownerId,
        "offer",
        offer.bestOfferId,
        "received",
        "offer_received",
        offer.itemId || null,
      );
      if (!fresh) continue;
      // Per-event try/catch, not one around the batch. Two reasons, and both
      // were live defects: the claim has to be released so the next poll
      // retries this offer, and one failing notification used to abort the
      // remaining offers in the batch by unwinding to the source handler.
      try {
        await deps.notifyOffer({
          userId: ownerId,
          bestOfferId: offer.bestOfferId,
          itemTitle: offer.itemTitle,
          price: offer.price,
          currency: offer.currency,
          buyerUsername: offer.buyerUsername,
          expiresAt: offer.expiresAt,
        });
        result.offers++;
      } catch (err) {
        await deps.release?.(ownerId, "offer", offer.bestOfferId, "received");
        result.errors.push(
          `offer ${offer.bestOfferId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`offers: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Returns (Post-Order) ──────────────────────────────────────────
  try {
    const returns = await deps.fetchReturns(ownerId);
    for (const ret of returns) {
      if (!ret.returnId) continue;
      const fresh = await deps.claim(
        ownerId,
        "return",
        ret.returnId,
        "opened",
        "return_opened",
        ret.itemId || null,
      );
      if (!fresh) continue;
      try {
        await deps.notifyReturn({
          userId: ownerId,
          returnId: ret.returnId,
          itemLabel: ret.itemId ?? ret.orderId,
          reason: ret.reason,
        });
        result.returns++;
      } catch (err) {
        await deps.release?.(ownerId, "return", ret.returnId, "opened");
        result.errors.push(
          `return ${ret.returnId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`returns: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Cancellation requests (Post-Order) ────────────────────────────
  //
  // US-2560. searchCancellations() had been in ebay-postorder.ts since the
  // Post-sale page shipped, and no poll source read it — so this was the one
  // post-order case a seller could only find by going and looking, while eBay
  // ran a clock on it.
  try {
    const cancellations = (await deps.fetchCancellations?.(ownerId)) ?? [];
    for (const ca of cancellations) {
      if (!ca.cancelId) continue;

      // A cancellation the SELLER started is their own action. Notifying them
      // about it would fire on every Approve they press from the Post-sale page
      // — the notification arriving to tell them what they just did. Unknown
      // still notifies, per the default-open asymmetry the state rule uses.
      if (ca.requestorType?.trim().toUpperCase() === "SELLER") continue;

      // Closed cases are history. Unlike the dispute source above this is a
      // DENYLIST on terminal words rather than an allowlist of open states,
      // because it has to agree with what the Post-sale page calls open — a
      // notification whose row the page files under "Show closed" sends the
      // seller looking for work that appears not to exist.
      if (isClosedCase(ca.state)) continue;

      const fresh = await deps.claim(
        ownerId,
        "cancellation",
        ca.cancelId,
        "requested",
        "cancellation_requested",
        // A cancellation is keyed to an ORDER, not a listing — same as a
        // dispute, so the item link stays honestly null rather than borrowing
        // the order id into a column that means something else.
        null,
      );
      if (!fresh) continue;
      try {
        await deps.notifyCancellation?.({
          userId: ownerId,
          cancelId: ca.cancelId,
          orderLabel: ca.orderId,
          reason: ca.reason,
        });
        result.cancellations++;
      } catch (err) {
        await deps.release?.(ownerId, "cancellation", ca.cancelId, "requested");
        result.errors.push(
          `cancellation ${ca.cancelId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`cancellations: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Payment disputes ──────────────────────────────────────────────
  try {
    // fetchDisputes (searchPaymentDisputes) already treats the eBay "no
    // disputes" 404 as an empty list, so a clean account is a no-op here.
    const disputes = await deps.fetchDisputes(ownerId);
    for (const dispute of disputes) {
      if (!dispute.paymentDisputeId) continue;
      if (dispute.status && !ACTIONABLE_DISPUTE_STATUSES.has(dispute.status.toUpperCase())) {
        continue;
      }
      const fresh = await deps.claim(ownerId, "dispute", dispute.paymentDisputeId, "opened", "dispute_opened");
      if (!fresh) continue;
      try {
        await deps.notifyDispute({
          userId: ownerId,
          disputeId: dispute.paymentDisputeId,
          orderLabel: dispute.orderId,
          reason: dispute.reason,
          amount: dispute.amount,
          currency: dispute.currency,
          respondByDate: dispute.respondByDate,
        });
        result.disputes++;
      } catch (err) {
        await deps.release?.(ownerId, "dispute", dispute.paymentDisputeId, "opened");
        result.errors.push(
          `dispute ${dispute.paymentDisputeId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`disputes: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// ── Cron ────────────────────────────────────────────────────────────

/**
 * Sweep every active eBay connection and poll its owner's marketplace events.
 * Distinct owners only (a workspace's eBay connection lives on the owner). The
 * eBay reads are rate-bounded by eBay itself; the cron just bounds the fan-out.
 */
export async function sweepMarketplaceEvents(
  loadOwnerIds: () => Promise<string[]>,
): Promise<
  {
    users: number;
    offers: number;
    returns: number;
    disputes: number;
    cancellations: number;
    errors: number;
  }
> {
  const ownerIds = await loadOwnerIds();
  let offers = 0;
  let returns = 0;
  let disputes = 0;
  let cancellations = 0;
  let errors = 0;
  for (const ownerId of ownerIds) {
    const r = await pollMarketplaceEventsForUser(ownerId);
    offers += r.offers;
    returns += r.returns;
    disputes += r.disputes;
    cancellations += r.cancellations;
    errors += r.errors.length;
  }
  return { users: ownerIds.length, offers, returns, disputes, cancellations, errors };
}

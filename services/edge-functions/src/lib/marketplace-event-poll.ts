// Marketplace-event poll (US-1055): the recurring source that surfaces NEW
// offers, returns, and payment disputes from eBay and notifies the seller.
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
import { type ReturnSummary, searchReturns } from "./ebay-postorder.ts";
import { type PaymentDisputeSummary, searchPaymentDisputes } from "./ebay-disputes.ts";
import {
  claimMarketplaceEvent,
  type DisputeOpenedEvent,
  type MarketplaceEventKind,
  notifyDisputeOpened,
  notifyOfferReceived,
  notifyReturnOpened,
  type OfferReceivedEvent,
  type ReturnOpenedEvent,
} from "./marketplace-event-notify.ts";

export interface MarketplacePollResult {
  offers: number;
  returns: number;
  disputes: number;
  errors: string[];
}

// Seams for testing: the eBay fetchers, the idempotency claim, and the three
// emitters. Defaults wire to the real implementations; a unit test injects fakes
// (e.g. a Set-backed claim) to prove dedup + per-source isolation.
export interface MarketplacePollDeps {
  fetchOffers: (userId: string) => Promise<IncomingBestOffer[]>;
  fetchReturns: (userId: string) => Promise<ReturnSummary[]>;
  fetchDisputes: (userId: string) => Promise<PaymentDisputeSummary[]>;
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
  notifyOffer: (ev: OfferReceivedEvent) => Promise<void>;
  notifyReturn: (ev: ReturnOpenedEvent) => Promise<void>;
  notifyDispute: (ev: DisputeOpenedEvent) => Promise<void>;
}

const defaultDeps: MarketplacePollDeps = {
  fetchOffers: getBestOffers,
  fetchReturns: (userId) => searchReturns(userId, { limit: 100 }),
  fetchDisputes: (userId) => searchPaymentDisputes(userId, { limit: 100 }),
  claim: claimMarketplaceEvent,
  notifyOffer: notifyOfferReceived,
  notifyReturn: notifyReturnOpened,
  notifyDispute: notifyDisputeOpened,
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
  const result: MarketplacePollResult = { offers: 0, returns: 0, disputes: 0, errors: [] };

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
      await deps.notifyReturn({
        userId: ownerId,
        returnId: ret.returnId,
        itemLabel: ret.itemId ?? ret.orderId,
        reason: ret.reason,
      });
      result.returns++;
    }
  } catch (err) {
    result.errors.push(`returns: ${err instanceof Error ? err.message : String(err)}`);
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
): Promise<{ users: number; offers: number; returns: number; disputes: number; errors: number }> {
  const ownerIds = await loadOwnerIds();
  let offers = 0;
  let returns = 0;
  let disputes = 0;
  let errors = 0;
  for (const ownerId of ownerIds) {
    const r = await pollMarketplaceEventsForUser(ownerId);
    offers += r.offers;
    returns += r.returns;
    disputes += r.disputes;
    errors += r.errors.length;
  }
  return { users: ownerIds.length, offers, returns, disputes, errors };
}

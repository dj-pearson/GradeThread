// US-626: best-effort transactional iOS pushes for the four categories the app
// defines (sale.created, payout.cleared, token.expiring, item.review_needed).
//
// Every helper is fire-and-forget: a push failure (or APNs simply being
// unconfigured — sendPushToUser no-ops then) must NEVER break the flow that
// triggered it. Call as `void pushX(...)`.

import { sendPushToUser } from "./apns.ts";

async function safePush(
  userId: string,
  payload: Parameters<typeof sendPushToUser>[1],
): Promise<void> {
  try {
    await sendPushToUser(userId, payload);
  } catch (err) {
    console.error("[push] transactional send failed:", err instanceof Error ? err.message : err);
  }
}

/** A submission was flagged for human review (low confidence / partial failure). */
export function pushReviewNeeded(userId: string, title?: string | null): Promise<void> {
  return safePush(userId, {
    title: "We're double-checking your grade",
    body: title ? `"${title}" needs a quick human review.` : "One of your items needs a quick human review.",
    category: "item.review_needed",
    data: { kind: "review_needed" },
  });
}

/** The user's eBay token is expiring and auto-refresh couldn't renew it. */
export function pushTokenExpiring(userId: string): Promise<void> {
  return safePush(userId, {
    title: "Reconnect eBay",
    body: "Your eBay connection is expiring — reconnect to keep listings and sales syncing.",
    category: "token.expiring",
    data: { kind: "token_expiring" },
    collapseId: "token-expiring",
  });
}

/** A new sale was recorded from a marketplace sync. */
export function pushSaleCreated(userId: string, title?: string | null): Promise<void> {
  return safePush(userId, {
    title: "You made a sale 🎉",
    body: title ? `"${title}" just sold.` : "An item just sold.",
    category: "sale.created",
    data: { kind: "sale_created" },
  });
}

/**
 * US-1977: a live listing ended on eBay — ended unsold, sold out, or removed by
 * eBay (e.g. a policy issue) — and the item is back in Drafts to relist. Parity
 * with pushSaleCreated / pushOfferReceived; the iOS app defines the matching
 * `listing.ended` notification category.
 */
export function pushListingEnded(userId: string, itemTitle?: string | null): Promise<void> {
  return safePush(userId, {
    title: "Listing ended",
    body: itemTitle
      ? `"${itemTitle}" ended on eBay — it's back in Drafts to relist.`
      : "A listing ended on eBay — it's back in Drafts to relist.",
    category: "listing.ended",
    data: { kind: "listing_ended" },
  });
}

/** A payout was imported / cleared for the user. */
export function pushPayoutCleared(userId: string, count: number): Promise<void> {
  return safePush(userId, {
    title: "Payout cleared",
    body: count > 1 ? `${count} payouts just cleared.` : "A payout just cleared.",
    category: "payout.cleared",
    data: { kind: "payout_cleared" },
  });
}

// US-1055: marketplace offer / return / dispute pushes. Same fire-and-forget
// contract as the helpers above.

/** A buyer sent an offer on one of the seller's listings. */
export function pushOfferReceived(userId: string, itemTitle?: string | null): Promise<void> {
  return safePush(userId, {
    title: "New offer",
    body: itemTitle ? `A buyer sent an offer on "${itemTitle}".` : "You received a new offer.",
    category: "offer.received",
    data: { kind: "offer_received" },
  });
}

/** A buyer offer was accepted / declined / countered. */
export function pushOfferResponded(
  userId: string,
  action: "accepted" | "declined" | "countered",
  itemTitle?: string | null,
): Promise<void> {
  return safePush(userId, {
    title: `Offer ${action}`,
    body: itemTitle ? `The offer on "${itemTitle}" was ${action}.` : `An offer was ${action}.`,
    category: "offer.responded",
    data: { kind: "offer_responded", action },
  });
}

/** A buyer opened a return. */
export function pushReturnOpened(userId: string, itemLabel?: string | null): Promise<void> {
  return safePush(userId, {
    title: "Return opened",
    body: itemLabel ? `A buyer opened a return on ${itemLabel}.` : "A buyer opened a return.",
    category: "return.opened",
    data: { kind: "return_opened" },
  });
}

/** A payment dispute / chargeback was opened — deadline-bearing. */
export function pushDisputeOpened(userId: string, orderLabel?: string | null): Promise<void> {
  return safePush(userId, {
    title: "Payment dispute opened",
    body: orderLabel
      ? `A payment dispute was opened on ${orderLabel} — respond before the deadline.`
      : "A payment dispute was opened — respond before the deadline.",
    category: "dispute.opened",
    data: { kind: "dispute_opened" },
  });
}

// US-626: best-effort transactional iOS pushes for the four categories the app
// defines (sale.created, payout.cleared, token.expiring, item.review_needed).
//
// Every helper is fire-and-forget: a push failure (or APNs simply being
// unconfigured — sendPushToUser no-ops then) must NEVER break the flow that
// triggered it. Call as `void pushX(...)`.

import { sendPushToUser } from "./apns.ts";
import { withUnreadBadge } from "./notification-badge.ts";
import { quietHoursActiveForUser } from "./quiet-hours.ts";

/**
 * US-2557: the badge is attached HERE rather than in each helper or in
 * sendPushToUser, and the seam matters both ways.
 *
 * Not per-helper: there are a dozen of them and the next one added would forget.
 *
 * Not in sendPushToUser: that is the transport, and it serves pushes that are
 * not notification-backed at all (cross-listing progress, Android FCM sends from
 * other paths). Badging those with a notifications-table count would attach a
 * number that has nothing to do with what the push is about.
 *
 * Everything routed through this file IS a transactional user notification, so
 * "unread notifications" is the right number for all of them. `withUnreadBadge`
 * decides when attaching it would do harm; see its doc for why 0 is never sent.
 */
async function safePush(
  userId: string,
  payload: Parameters<typeof sendPushToUser>[1],
): Promise<void> {
  try {
    // US-2853: quiet hours mute the device push and nothing else. The in-app row
    // was already written by the caller's notifyUser(), so this drops the buzz,
    // not the notification. Gated at this seam for the same reason the badge is
    // (see above): a dozen helpers, and the next one added would forget.
    if (await quietHoursActiveForUser(userId)) return;
    await sendPushToUser(userId, await withUnreadBadge(userId, payload));
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
 * US-1977: a listing ended without selling (expired / ended on Seller Hub /
 * out of stock / removed by eBay) and returned to Drafts. Category "listing.ended"
 * matches the iOS NotificationCategories entry so the app groups + deep-links it.
 */
export function pushListingEnded(userId: string, title?: string | null): Promise<void> {
  return safePush(userId, {
    title: "Listing ended",
    body: title
      ? `"${title}" ended on eBay without selling — it's back in Drafts to relist.`
      : "A listing ended on eBay without selling — it's back in Drafts to relist.",
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

/** A buyer asked to cancel an order before it ships. */
export function pushCancellationRequested(
  userId: string,
  orderLabel?: string | null,
): Promise<void> {
  return safePush(userId, {
    title: "Cancellation requested",
    body: orderLabel
      ? `A buyer asked to cancel ${orderLabel}. Approve or reject before eBay does.`
      : "A buyer asked to cancel an order. Approve or reject before eBay does.",
    category: "cancellation.requested",
    data: { kind: "cancellation_requested" },
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

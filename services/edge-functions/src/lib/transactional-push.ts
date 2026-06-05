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

/** A payout was imported / cleared for the user. */
export function pushPayoutCleared(userId: string, count: number): Promise<void> {
  return safePush(userId, {
    title: "Payout cleared",
    body: count > 1 ? `${count} payouts just cleared.` : "A payout just cleared.",
    category: "payout.cleared",
    data: { kind: "payout_cleared" },
  });
}

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


/**
 * US-3275: the ids a notification ACTION needs, stamped into `data`.
 *
 * ⚠ WHY THIS EXISTS AND WHAT IT COST. Every sender here shipped
 * `data: { kind }` and nothing else, so iOS could not build a real inline
 * action from any of them. US-3274 found what a seller actually saw: an offer
 * notification with an Accept button, a Face ID prompt (accept and counter are
 * `.authenticationRequired` because they move money), and then the app opening
 * on the inbox with nothing accepted. They authenticated for nothing. iOS now
 * HIDES a button whose payload cannot serve it, which is why stamping the ids
 * is what brings them back.
 *
 * ⚠ THE KEY NAMES ARE A WIRE CONTRACT. `best_offer_id`, `inventory_item_id`
 * and `sale_id` are matched by name in
 * NotificationActionID.requiredPayloadKeys and in DeepLinkRoute.from on iOS,
 * and by PushCategory.route on Android. Renaming one here silently disables
 * the button on every installed app.
 *
 * Absent ids are OMITTED rather than sent as null: iOS tests membership of the
 * key, so a null would read as present and re-enable a button that still
 * cannot work.
 */
export interface PushIds {
  /** The marketplace's own offer id. Accept and Counter act on it. */
  bestOfferId?: string | null;
  /** The local inventory item, for a targeted deep link. */
  inventoryItemId?: string | null;
  /** The local sale row. Mark shipped closes it. */
  saleId?: string | null;
  /** The external id of the return, inquiry, case, cancellation or dispute. */
  caseId?: string | null;
}

/** The `data` entries for whichever ids are present. */
function idFields(ids: PushIds | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (ids?.bestOfferId) out.best_offer_id = ids.bestOfferId;
  if (ids?.inventoryItemId) out.inventory_item_id = ids.inventoryItemId;
  if (ids?.saleId) out.sale_id = ids.saleId;
  if (ids?.caseId) out.case_id = ids.caseId;
  return out;
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
export function pushSaleCreated(
  userId: string,
  title?: string | null,
  ids?: PushIds,
): Promise<void> {
  return safePush(userId, {
    title: "You made a sale 🎉",
    body: title ? `"${title}" just sold.` : "An item just sold.",
    category: "sale.created",
    // US-3275 AC2: sale_id is what Mark shipped acts on, and there is no
    // separate shipping push -- this notification IS the shipping prompt.
    data: { kind: "sale_created", ...idFields(ids) },
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
export function pushOfferReceived(
  userId: string,
  itemTitle?: string | null,
  ids?: PushIds,
): Promise<void> {
  return safePush(userId, {
    title: "New offer",
    body: itemTitle ? `A buyer sent an offer on "${itemTitle}".` : "You received a new offer.",
    category: "offer.received",
    // US-3275 AC1: Accept and Counter need both ids -- the offer to act on and
    // the item to land on if the seller opens it instead.
    data: { kind: "offer_received", ...idFields(ids) },
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
export function pushReturnOpened(userId: string, itemLabel?: string | null, ids?: PushIds): Promise<void> {
  return safePush(userId, {
    title: "Return opened",
    body: itemLabel ? `A buyer opened a return on ${itemLabel}.` : "A buyer opened a return.",
    category: "return.opened",
    data: { kind: "return_opened", ...idFields(ids) },
  });
}

/**
 * US-2928: a buyer says their parcel never arrived (an INR inquiry).
 *
 * Its own push rather than a reuse of pushReturnOpened, because the two need
 * opposite actions from the seller: a return wants an approve/decline decision,
 * an INR inquiry wants tracking supplied. A seller who reads "return opened"
 * goes to the wrong screen.
 */
export function pushInquiryOpened(userId: string, orderLabel?: string | null, ids?: PushIds): Promise<void> {
  return safePush(userId, {
    title: "Item not received",
    body: orderLabel
      ? `A buyer says ${orderLabel} never arrived. Add tracking before it escalates.`
      : "A buyer says their order never arrived. Add tracking before it escalates.",
    category: "inquiry.opened",
    data: { kind: "inquiry_opened", ...idFields(ids) },
  });
}

/** US-2929: an inquiry or return the buyer escalated to eBay. This one carries a defect. */
export function pushCaseOpened(userId: string, orderLabel?: string | null, ids?: PushIds): Promise<void> {
  return safePush(userId, {
    title: "eBay case opened",
    body: orderLabel
      ? `A buyer escalated ${orderLabel} to eBay. Losing a case counts against your account.`
      : "A buyer escalated an order to eBay. Losing a case counts against your account.",
    category: "case.opened",
    data: { kind: "case_opened", ...idFields(ids) },
  });
}

/** US-2933: a post-sale deadline is close. Fires at most twice per case. */
export function pushPostSaleDeadline(
  userId: string,
  orderLabel?: string | null,
  ids?: PushIds,
): Promise<void> {
  return safePush(userId, {
    title: "eBay deadline is close",
    body: orderLabel
      ? `An open case on ${orderLabel} needs your answer before eBay decides it.`
      : "An open eBay case needs your answer before eBay decides it.",
    category: "case.deadline",
    data: { kind: "case_deadline", ...idFields(ids) },
  });
}

/** A buyer asked to cancel an order before it ships. */
export function pushCancellationRequested(
  userId: string,
  orderLabel?: string | null,
  ids?: PushIds,
): Promise<void> {
  return safePush(userId, {
    title: "Cancellation requested",
    body: orderLabel
      ? `A buyer asked to cancel ${orderLabel}. Approve or reject before eBay does.`
      : "A buyer asked to cancel an order. Approve or reject before eBay does.",
    category: "cancellation.requested",
    data: { kind: "cancellation_requested", ...idFields(ids) },
  });
}

/** A payment dispute / chargeback was opened — deadline-bearing. */
export function pushDisputeOpened(userId: string, orderLabel?: string | null, ids?: PushIds): Promise<void> {
  return safePush(userId, {
    title: "Payment dispute opened",
    body: orderLabel
      ? `A payment dispute was opened on ${orderLabel} — respond before the deadline.`
      : "A payment dispute was opened — respond before the deadline.",
    category: "dispute.opened",
    data: { kind: "dispute_opened", ...idFields(ids) },
  });
}

/**
 * US-3144: a sold item still has listings live on channels only the seller's own
 * browser can end.
 *
 * The one push in this file that asks for WORK rather than reporting news, and
 * the copy has to earn that. It names the item, says how many listings are still
 * live, and says why the seller is being asked — because the same garment can be
 * bought twice while it waits, which is the cost this whole path exists to avoid.
 *
 * `inventory_item_id` rides in `data` because that is the one key both clients
 * already read to route a tap (iOS NotificationDelegate.DeepLinkRoute.from,
 * Android PushCategory.route). Sending anything else would need new parsing on
 * both platforms to reach the same screen.
 *
 * ONE per sale, never one per marketplace. A seller who cross-lists to four
 * channels and sells on the fifth does not need four buzzes about one garment,
 * and `collapseId` keyed on the item means even a re-send replaces rather than
 * stacks.
 */
export function pushDelistNeeded(
  userId: string,
  opts: { itemId: string | null; itemTitle?: string | null; count: number },
): Promise<void> {
  const what = opts.itemTitle ? `"${opts.itemTitle}"` : "An item";
  const many = opts.count > 1;
  return safePush(userId, {
    title: "Still listed elsewhere",
    body: many
      ? `${what} sold — ${opts.count} other listings are still live. End them before it sells twice.`
      : `${what} sold — one other listing is still live. End it before it sells twice.`,
    category: "delist.needed",
    // US-3275: through idFields like every other sender, so there is one
    // mechanism for "which ids ride in the payload" rather than two.
    data: { kind: "delist_needed", ...idFields({ inventoryItemId: opts.itemId }) },
    // Keyed on the item so a re-send replaces the last one instead of stacking.
    ...(opts.itemId ? { collapseId: `delist-${opts.itemId}` } : {}),
  });
}

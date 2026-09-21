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
 */
export type PushIdKey =
  | "best_offer_id"
  | "inventory_item_id"
  | "sale_id"
  | "case_id";

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

/** Which `PushIds` field supplies each wire key. */
const ID_FIELD: Record<PushIdKey, keyof PushIds> = {
  best_offer_id: "bestOfferId",
  inventory_item_id: "inventoryItemId",
  sale_id: "saleId",
  case_id: "caseId",
};

/**
 * US-3279: THE PUSH CONTRACT, DECLARED ONCE.
 *
 * Every category this service sends, the `kind` its payload carries, and the
 * id keys that category MAY carry. `contracts/push-contract.json` is generated
 * from this table, and iOS reads that artefact instead of a hand-written copy
 * of it.
 *
 * ⚠ WHY A TABLE RATHER THAN A LIST INSIDE EACH SENDER. Three bugs in one
 * session came from the clients and the edge each describing this contract in
 * their own file with nothing comparing them: US-3266 (the edge sent seven
 * categories iOS had never heard of, so every tap went nowhere), US-3268
 * (three Settings toggles for notifications nothing can send) and US-3274
 * (five inline buttons the payload could not serve, one of which asked for
 * Face ID before doing nothing). Each had a nearby comment asserting the
 * opposite, written when it was true.
 *
 * ⚠ `ids` IS A CEILING, NOT A PROMISE. `idFields` drops anything not listed
 * here, so an id a caller passes to the wrong category never reaches the wire.
 * That is the fail-safe direction: a missing key hides a button, an unexpected
 * one re-enables a dead one.
 *
 * ⚠ THE KEY NAMES ARE A WIRE CONTRACT. They are matched by name in
 * NotificationActionID.requiredPayloadKeys and DeepLinkRoute.from on iOS, and
 * by PushCategory.route on Android. Renaming one here silently disables the
 * button on every installed app.
 */
export const PUSH_CONTRACT = {
  "item.review_needed": { kind: "review_needed", ids: [] },
  "token.expiring": { kind: "token_expiring", ids: [] },
  "sale.created": { kind: "sale_created", ids: ["sale_id", "inventory_item_id"] },
  "listing.ended": { kind: "listing_ended", ids: [] },
  "payout.cleared": { kind: "payout_cleared", ids: [] },
  "offer.received": {
    kind: "offer_received",
    ids: ["best_offer_id", "inventory_item_id"],
  },
  // `action` is not an id: it is the verb ("accepted" / "declined" /
  // "countered") and it is always present, so it is declared as an extra key
  // rather than routed through idFields.
  "offer.responded": { kind: "offer_responded", ids: [], extra: ["action"] },
  "return.opened": { kind: "return_opened", ids: ["case_id"] },
  "inquiry.opened": { kind: "inquiry_opened", ids: ["case_id"] },
  "case.opened": { kind: "case_opened", ids: ["case_id"] },
  "case.deadline": { kind: "case_deadline", ids: ["case_id"] },
  "cancellation.requested": { kind: "cancellation_requested", ids: ["case_id"] },
  "dispute.opened": { kind: "dispute_opened", ids: ["case_id"] },
  "delist.needed": { kind: "delist_needed", ids: ["inventory_item_id"] },
  // ⚠ NOT SENT FROM THIS FILE, AND DECLARED HERE ANYWAY.
  // routes/admin-growth.ts pushes growth campaigns straight through
  // sendPushToUser, because it reads the result for its per-recipient stats
  // and safePush returns void. Leaving it out of the table would leave it out
  // of the artefact, and a category the clients do not know is a tap that goes
  // nowhere and a push nobody can mute -- US-3266 word for word. It carries no
  // `kind`: the campaign's own url and id are the whole payload.
  "marketing": {
    kind: null,
    ids: [],
    extra: ["url", "campaign_id"],
    sentBy: "src/routes/admin-growth.ts",
  },
} as const satisfies Record<
  string,
  {
    kind: string | null;
    ids: readonly PushIdKey[];
    extra?: readonly string[];
    /** Set when the sender lives outside this file; the path is checked. */
    sentBy?: string;
  }
>;

export type PushCategoryId = keyof typeof PUSH_CONTRACT;

/** Every key a category's payload can carry, `kind` included. */
export function payloadKeysFor(category: PushCategoryId): string[] {
  const entry = PUSH_CONTRACT[category] as {
    kind: string | null;
    ids: readonly PushIdKey[];
    extra?: readonly string[];
  };
  return [
    ...(entry.kind === null ? [] : ["kind"]),
    ...entry.ids,
    ...(entry.extra ?? []),
  ];
}

/**
 * The `data` entries for whichever of this category's declared ids are present.
 *
 * Absent ids are OMITTED rather than sent as null: iOS tests membership of the
 * key, so a null would read as present and re-enable a button that still
 * cannot work.
 */
function idFields(
  ids: PushIds | undefined,
  allowed: readonly PushIdKey[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = ids?.[ID_FIELD[key]];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The `category` + `data` half of a payload, built from the contract so a
 * sender cannot spell either of them itself.
 */
function describe(
  category: PushCategoryId,
  ids?: PushIds,
  extra?: Record<string, string>,
): { category: PushCategoryId; data: Record<string, string> } {
  const entry = PUSH_CONTRACT[category] as {
    kind: string | null;
    ids: readonly PushIdKey[];
  };
  if (entry.kind === null) {
    throw new Error(`${category} is not sent from this file; see its sentBy`);
  }
  return {
    category,
    data: { kind: entry.kind, ...idFields(ids, entry.ids), ...(extra ?? {}) },
  };
}

/** A submission was flagged for human review (low confidence / partial failure). */
export function pushReviewNeeded(userId: string, title?: string | null): Promise<void> {
  return safePush(userId, {
    title: "We're double-checking your grade",
    body: title ? `"${title}" needs a quick human review.` : "One of your items needs a quick human review.",
    ...describe("item.review_needed"),
  });
}

/** The user's eBay token is expiring and auto-refresh couldn't renew it. */
export function pushTokenExpiring(userId: string): Promise<void> {
  return safePush(userId, {
    title: "Reconnect eBay",
    body: "Your eBay connection is expiring — reconnect to keep listings and sales syncing.",
    ...describe("token.expiring"),
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
    // US-3275 AC2: sale_id is what Mark shipped acts on, and there is no
    // separate shipping push -- this notification IS the shipping prompt.
    ...describe("sale.created", ids),
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
    ...describe("listing.ended"),
  });
}

/** A payout was imported / cleared for the user. */
export function pushPayoutCleared(userId: string, count: number): Promise<void> {
  return safePush(userId, {
    title: "Payout cleared",
    body: count > 1 ? `${count} payouts just cleared.` : "A payout just cleared.",
    ...describe("payout.cleared"),
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
    // US-3275 AC1: Accept and Counter need both ids -- the offer to act on and
    // the item to land on if the seller opens it instead.
    ...describe("offer.received", ids),
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
    ...describe("offer.responded", undefined, { action }),
  });
}

/** A buyer opened a return. */
export function pushReturnOpened(userId: string, itemLabel?: string | null, ids?: PushIds): Promise<void> {
  return safePush(userId, {
    title: "Return opened",
    body: itemLabel ? `A buyer opened a return on ${itemLabel}.` : "A buyer opened a return.",
    ...describe("return.opened", ids),
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
    ...describe("inquiry.opened", ids),
  });
}

/** US-2929: an inquiry or return the buyer escalated to eBay. This one carries a defect. */
export function pushCaseOpened(userId: string, orderLabel?: string | null, ids?: PushIds): Promise<void> {
  return safePush(userId, {
    title: "eBay case opened",
    body: orderLabel
      ? `A buyer escalated ${orderLabel} to eBay. Losing a case counts against your account.`
      : "A buyer escalated an order to eBay. Losing a case counts against your account.",
    ...describe("case.opened", ids),
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
    ...describe("case.deadline", ids),
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
    ...describe("cancellation.requested", ids),
  });
}

/** A payment dispute / chargeback was opened — deadline-bearing. */
export function pushDisputeOpened(userId: string, orderLabel?: string | null, ids?: PushIds): Promise<void> {
  return safePush(userId, {
    title: "Payment dispute opened",
    body: orderLabel
      ? `A payment dispute was opened on ${orderLabel} — respond before the deadline.`
      : "A payment dispute was opened — respond before the deadline.",
    ...describe("dispute.opened", ids),
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
    // US-3275: through the contract like every other sender, so there is one
    // mechanism for "which ids ride in the payload" rather than two.
    ...describe("delist.needed", { inventoryItemId: opts.itemId }),
    // Keyed on the item so a re-send replaces the last one instead of stacking.
    ...(opts.itemId ? { collapseId: `delist-${opts.itemId}` } : {}),
  });
}

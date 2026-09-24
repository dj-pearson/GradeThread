// OM-01..03: the limits the Offers & Messages routes enforce, and the pure
// validators that apply them.
//
// The web page shows these same rules (a 1-60% discount, a 2000-character
// reply, a counter between the bid and the asking price). A rule the UI shows
// and the edge does not enforce is a rule any client can skip, so the numbers
// live here and src/lib/offer-limits.ts mirrors them. The two projects cannot
// import each other; src/test/offer-limits-parity.test.ts reads both files and
// fails if they drift.
//
// Everything here is pure: no Supabase, no eBay. The routes call these before
// any network work, so a bad body never costs an eBay round trip.

/** eBay's cap on a member-message reply body (AddMemberMessageRTQ). */
export const MEMBER_MESSAGE_MAX = 2000;
/** The smallest discount a watcher offer may carry, in whole percent. */
export const SEND_OFFER_MIN_PCT = 1;
/** The largest. Past this a "discount" is a giveaway nobody meant to press. */
export const SEND_OFFER_MAX_PCT = 60;
/** How many listings one send-offer request may carry. */
export const SEND_OFFER_MAX_LISTINGS = 100;
/** eBay's cap on the RespondToBestOffer SellerResponse note. */
export const SELLER_RESPONSE_MAX = 250;
/** Longest eBay item / message / user id this surface accepts. */
export const EBAY_ID_MAX = 64;

const EBAY_ID = /^[A-Za-z0-9_-]+$/;

/** An eBay id from a path or body: short, and only characters eBay uses. */
export function isEbayId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= EBAY_ID_MAX &&
    EBAY_ID.test(v);
}

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: string; max?: number };

function refuse<T>(code: string, error: string, max?: number): Parsed<T> {
  return max == null ? { ok: false, code, error } : { ok: false, code, error, max };
}

// ── POST /messages/:messageId/reply ─────────────────────────────────────────

export interface ReplyInput {
  messageId: string;
  itemId: string;
  recipientId: string;
  text: string;
}

export function parseReplyBody(
  messageId: unknown,
  body: { item_id?: unknown; recipient_id?: unknown; body?: unknown },
): Parsed<ReplyInput> {
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!body.item_id || !body.recipient_id || !text) {
    return refuse("missing_fields", "item_id, recipient_id, and body are required");
  }
  if (!isEbayId(messageId) || !isEbayId(body.item_id) || !isEbayId(body.recipient_id)) {
    return refuse("invalid_id", "That message, item or buyer id isn't one eBay would send.");
  }
  if (text.length > MEMBER_MESSAGE_MAX) {
    return refuse(
      "body_too_long",
      `Replies can be at most ${MEMBER_MESSAGE_MAX} characters.`,
      MEMBER_MESSAGE_MAX,
    );
  }
  return {
    ok: true,
    value: { messageId, itemId: body.item_id, recipientId: body.recipient_id, text },
  };
}

// ── POST /negotiation/send-offer ────────────────────────────────────────────

export interface SendOfferInput {
  listingIds: string[];
  discountPct: number;
  message: string | undefined;
}

/**
 * The discount arrives as a number from some clients and a string from others.
 * Both are accepted; neither is rounded. "12.5" is a refusal rather than a
 * silent 12 or 13, because the seller typed a number and should get that one.
 */
export function parseDiscountPct(v: unknown): number | null {
  const n = typeof v === "number"
    ? v
    : typeof v === "string" && v.trim() !== ""
    ? Number(v.trim())
    : Number.NaN;
  if (!Number.isInteger(n)) return null;
  if (n < SEND_OFFER_MIN_PCT || n > SEND_OFFER_MAX_PCT) return null;
  return n;
}

export function parseSendOfferBody(
  body: { listing_ids?: unknown; discount_percentage?: unknown; message?: unknown },
): Parsed<SendOfferInput> {
  const raw = Array.isArray(body.listing_ids) ? body.listing_ids : [];
  const ids = [...new Set(raw.filter(isEbayId))];
  if (ids.length === 0) {
    return refuse("listing_ids_required", "listing_ids must be a non-empty array");
  }
  if (ids.length > SEND_OFFER_MAX_LISTINGS) {
    return refuse(
      "too_many_listings",
      `Send to at most ${SEND_OFFER_MAX_LISTINGS} listings at a time.`,
      SEND_OFFER_MAX_LISTINGS,
    );
  }
  const pct = parseDiscountPct(body.discount_percentage);
  if (pct == null) {
    return refuse(
      "discount_out_of_range",
      `The discount must be a whole number from ${SEND_OFFER_MIN_PCT}% to ${SEND_OFFER_MAX_PCT}%.`,
    );
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length > MEMBER_MESSAGE_MAX) {
    return refuse(
      "message_too_long",
      `The message can be at most ${MEMBER_MESSAGE_MAX} characters.`,
      MEMBER_MESSAGE_MAX,
    );
  }
  return {
    ok: true,
    value: { listingIds: ids, discountPct: pct, message: message || undefined },
  };
}

export interface GroupSendResult {
  sent: string[];
  failed: Array<{ ids: string[]; error: unknown }>;
}

/**
 * One send per eBay account, each recorded the moment it succeeds.
 *
 * The old loop sent every group and THEN recorded. When store 2 threw after
 * store 1's offers had gone out, nothing was recorded, so a retry offered store
 * 1's watchers a second time and skipped the cooldown that exists to stop
 * exactly that. `record` failing is logged by the caller's function, not
 * treated as a failed send: the offers did go out.
 */
export async function sendGroupsRecordingEach<K>(
  groups: Map<K, string[]>,
  send: (key: K, ids: string[]) => Promise<void>,
  record: (ids: string[]) => Promise<void>,
): Promise<GroupSendResult> {
  const out: GroupSendResult = { sent: [], failed: [] };
  for (const [key, ids] of groups) {
    try {
      await send(key, ids);
    } catch (error) {
      out.failed.push({ ids, error });
      continue;
    }
    out.sent.push(...ids);
    try {
      await record(ids);
    } catch (err) {
      console.error("[offer-limits] recording a sent group failed:", err);
    }
  }
  return out;
}

// ── POST /negotiation/offers/:bestOfferId/respond ───────────────────────────

/** Dollars to whole cents, or null when it is not a price to two places. */
export function priceToCents(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Through toFixed(4) first so 1.005 rounds to 101 rather than to the 100
  // that 1.005 * 100 = 100.49999999999999 would give.
  return Math.round(Number((n * 100).toFixed(4)));
}

export type CounterRefusal = "not_positive" | "at_or_below_offer" | "at_or_above_list";

/**
 * A counter eBay will take: above the buyer's bid and below the asking price.
 * A counter at or under the bid is an accept with extra steps, and one at the
 * asking price is not a counter; eBay rejects both with a generic error the
 * seller cannot act on, so they are refused here with the reason.
 */
export function validateCounter(input: {
  offerCents: number | null;
  listCents: number | null;
  counterCents: number | null;
}): { ok: true; cents: number } | { ok: false; reason: CounterRefusal } {
  const { offerCents, listCents, counterCents } = input;
  if (counterCents == null || counterCents <= 0) return { ok: false, reason: "not_positive" };
  if (offerCents != null && counterCents <= offerCents) {
    return { ok: false, reason: "at_or_below_offer" };
  }
  if (listCents != null && listCents > 0 && counterCents >= listCents) {
    return { ok: false, reason: "at_or_above_list" };
  }
  return { ok: true, cents: counterCents };
}

export const COUNTER_REFUSAL_COPY: Record<CounterRefusal, string> = {
  not_positive: "Enter a counter price.",
  at_or_below_offer: "A counter has to be more than the buyer offered.",
  at_or_above_list: "A counter has to be less than your asking price.",
};

/** A counter quantity: a positive whole number, 1 when absent. Null if invalid. */
export function parseCounterQuantity(v: unknown): number | null {
  if (v == null || v === "") return 1;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Whether the stored copy of an offer already says it is finished: its expiry
 * has passed, or eBay last reported it in a closed state. Null means
 * "no reason to refuse" (including "we have no stored copy", which is not
 * evidence of anything and must not block a real response).
 */
export function storedOfferClosedReason(
  row: { state: string | null; expires_at: string | null } | null,
  now = Date.now(),
): "expired" | "closed" | null {
  if (!row) return null;
  if (row.expires_at) {
    const at = Date.parse(row.expires_at);
    if (Number.isFinite(at) && at < now) return "expired";
  }
  if (row.state && STORED_CLOSED_STATES.has(row.state.toLowerCase())) return "closed";
  return null;
}

// The states that mean eBay itself has finished the offer. An allowlist of
// CLOSED states rather than "anything but Active", because eBay has statuses
// (Pending, Countered) where a response can still be legitimate, and a false
// 409 here would block a real sale with nothing the seller can do about it.
const STORED_CLOSED_STATES = new Set([
  "accepted",
  "declined",
  "expired",
  "retracted",
  "cancelled",
  "canceled",
  "adminended",
]);

// US-3297: ordering and filtering for the two negotiation tables.
//
// ── WHY SORTING IS THE POINT ────────────────────────────────────────────────
//
// The old list rendered offers in whatever order eBay handed them back. A
// seller with thirty open offers had no way to answer "which of these dies
// first", which is the only question that decides the order of the work. Making
// the table sortable by expiry, and defaulting to it, is most of what this
// screen was missing.
//
// ── THE NUMBERS ARE THE DISPLAYED NUMBERS ───────────────────────────────────
//
// Sorting by net margin reads `netMarginCents` — the same function the row
// renders and the same arithmetic the edge's margin floor applies. A column
// that sorted by a private approximation would put rows in an order the visible
// figures contradict.
//
// ── UNKNOWN SORTS LAST, IN BOTH DIRECTIONS ──────────────────────────────────
//
// An offer with no recorded cost has an unknown margin, not a zero one, and an
// offer with no expiry date is not urgent. Treating null as a number puts those
// rows at one end of the table and hides real work behind them, so nulls are
// pushed to the bottom whichever way the column is pointed.

import type { EbayBestOffer, EbayBuyerMessage } from "@/hooks/use-ebay";
import {
  netMarginCents,
  pctOfList,
  type OfferEconomicsInput,
} from "@/pages/flipdesk/offer-economics";

/**
 * The economics inputs for one offer, in one place.
 *
 * The table, the mobile card and the counter preview all need the same five
 * figures; deriving them here means a new cost line (grading was one) is added
 * once rather than in three components that can drift apart.
 */
export function offerEconomics(offer: EbayBestOffer): OfferEconomicsInput {
  return {
    offerPrice: offer.price,
    listPrice: offer.listPriceCents != null ? offer.listPriceCents / 100 : null,
    itemCost: offer.itemCost,
    shippingCost: offer.shippingCost,
    gradingCost: offer.gradingCost,
  };
}

/** eBay statuses that mean this offer is finished and nothing is waiting on you. */
const CLOSED_STATUSES = new Set([
  "accepted",
  "declined",
  "expired",
  "retracted",
  "cancelled",
  "canceled",
]);

/**
 * Whether an offer is still work.
 *
 * Two ways it can be finished: eBay says so, or the clock ran out. The clock
 * check matters because the offers query refreshes every 90 seconds and eBay's
 * status lags its own expiry — an offer can read ACTIVE for minutes after it
 * died, and counting it puts a number on the tab for work that no longer
 * exists.
 */
export function isOpenOffer(offer: EbayBestOffer, now = Date.now()): boolean {
  if (offer.status && CLOSED_STATUSES.has(offer.status.toLowerCase())) {
    return false;
  }
  if (offer.expiresAt) {
    const at = Date.parse(offer.expiresAt);
    if (Number.isFinite(at) && at <= now) return false;
  }
  return true;
}

export type SortDir = "asc" | "desc";

export type OfferSortField = "expires" | "offer" | "share" | "net" | "item";
export interface OfferSort {
  field: OfferSortField;
  dir: SortDir;
}

/**
 * Soonest-expiring first, and this default is load-bearing rather than a
 * preference: it is the whole reason the table exists.
 */
export const DEFAULT_OFFER_SORT: OfferSort = { field: "expires", dir: "asc" };

export type MessageSortField = "received" | "buyer" | "status";
export interface MessageSort {
  field: MessageSortField;
  dir: SortDir;
}

/** Newest first — a buyer message is a conversation, and the last line leads. */
export const DEFAULT_MESSAGE_SORT: MessageSort = {
  field: "received",
  dir: "desc",
};

/**
 * Flip a column that is already sorted, or point a new column at its natural
 * direction.
 *
 * Natural means the direction a seller wants on the first click: soonest expiry
 * and biggest money, not the alphabetical accident of ascending-by-default. A
 * text column starts at A-Z.
 */
export function nextSort<F extends string>(
  current: { field: F; dir: SortDir },
  field: F,
  naturalDir: SortDir,
): { field: F; dir: SortDir } {
  if (current.field !== field) return { field, dir: naturalDir };
  return { field, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** The direction a column points on its first click. */
export function naturalOfferDir(field: OfferSortField): SortDir {
  return field === "expires" || field === "item" ? "asc" : "desc";
}

export function naturalMessageDir(field: MessageSortField): SortDir {
  return field === "buyer" ? "asc" : "desc";
}

// ── comparison plumbing ─────────────────────────────────────────────────────
//
// One rule, applied by every column: a null key goes last no matter which way
// the column points, and equal keys fall back to the row's id so the order is
// stable across the 90-second background refetch. Without that tiebreak, two
// offers expiring in the same hour swap places while the seller is reading them.

function compareKeys(
  a: number | string | null,
  b: number | string | null,
  dir: SortDir,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const raw =
    typeof a === "string" && typeof b === "string"
      ? a.localeCompare(b, undefined, { sensitivity: "base" })
      : Number(a) - Number(b);
  return dir === "asc" ? raw : -raw;
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

function offerKey(
  offer: EbayBestOffer,
  field: OfferSortField,
): number | string | null {
  switch (field) {
    case "expires":
      return parseTime(offer.expiresAt);
    case "offer":
      return offer.price ?? null;
    case "share":
      return pctOfList(offerEconomics(offer));
    case "net":
      return netMarginCents(offerEconomics(offer));
    case "item":
      return offer.itemTitle?.trim() || offer.itemId || null;
  }
}

export function sortOffers(
  offers: readonly EbayBestOffer[],
  sort: OfferSort,
): EbayBestOffer[] {
  return [...offers].sort((a, b) => {
    const cmp = compareKeys(
      offerKey(a, sort.field),
      offerKey(b, sort.field),
      sort.dir,
    );
    return cmp !== 0 ? cmp : a.bestOfferId.localeCompare(b.bestOfferId);
  });
}

function messageKey(
  message: EbayBuyerMessage,
  field: MessageSortField,
): number | string | null {
  switch (field) {
    case "received":
      return parseTime(message.creationDate);
    case "buyer":
      return message.senderUsername?.trim() || null;
    // Needs-reply is the useful end of this column, so unanswered is the HIGH
    // value: descending (the natural direction) puts the work on top.
    case "status":
      return message.answered ? 0 : 1;
  }
}

export function sortMessages(
  messages: readonly EbayBuyerMessage[],
  sort: MessageSort,
): EbayBuyerMessage[] {
  return [...messages].sort((a, b) => {
    const cmp = compareKeys(
      messageKey(a, sort.field),
      messageKey(b, sort.field),
      sort.dir,
    );
    return cmp !== 0 ? cmp : a.messageId.localeCompare(b.messageId);
  });
}

// ── text filter ─────────────────────────────────────────────────────────────
//
// Substring, case-insensitive, across every field the seller can see on the
// row. Deliberately not fuzzy: a seller typing a buyer's username expects that
// buyer's offers and nothing else, and a fuzzy match on a thirty-row table
// returns rows they then have to rule out by hand.

function matches(haystack: (string | null | undefined)[], needle: string) {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return haystack.some((h) => !!h && h.toLowerCase().includes(q));
}

export function filterOffers(
  offers: readonly EbayBestOffer[],
  query: string,
): EbayBestOffer[] {
  if (!query.trim()) return [...offers];
  return offers.filter((o) =>
    matches([o.itemTitle, o.itemId, o.buyerUsername, o.message], query),
  );
}

export function filterMessages(
  messages: readonly EbayBuyerMessage[],
  query: string,
): EbayBuyerMessage[] {
  if (!query.trim()) return [...messages];
  return messages.filter((m) =>
    matches([m.senderUsername, m.subject, m.body, m.itemId], query),
  );
}

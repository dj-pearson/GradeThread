// Pure pieces of the Repricing queue: what a refused Apply says, how a big
// selection is split for the server, and which rows an Undo may touch. Kept out
// of the hook and the page so they can be tested without a network or a DOM.

/** Why the server refused a single-row Apply before anything reached eBay. */
export type ApplyRefusal =
  | "not_pending"
  | "listing_not_active"
  | "price_changed"
  | "below_margin_floor";

const REFUSAL_COPY: Record<ApplyRefusal, string> = {
  not_pending: "This suggestion was already applied or dismissed.",
  listing_not_active: "This listing is no longer live, so its price can't change.",
  price_changed: "Price changed since the scan. Scan this item again.",
  below_margin_floor: "That price is under this item's floor, so it was not applied.",
};

/** A plain sentence for a refusal, or null when the reason is not one we know. */
export function applyRefusalMessage(reason: unknown): string | null {
  return typeof reason === "string" && Object.prototype.hasOwnProperty.call(REFUSAL_COPY, reason)
    ? REFUSAL_COPY[reason as ApplyRefusal]
    : null;
}

/** The server applies at most this many rows per request. */
export const MAX_REPRICE_PER_REQUEST = 50;

/** Split a selection into requests the server will take whole, in order. */
export function chunkRepriceItems<T>(items: T[], size = MAX_REPRICE_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface AppliedRow {
  listing_id: string;
  old_price_cents: number;
  new_price_cents: number;
}

/**
 * The prices an Undo writes back: only rows the server says it changed, at the
 * price it says it replaced. A skipped or failed row never moved, so putting it
 * "back" would be a new price change the seller did not ask for.
 */
export function undoPriors(
  applied: AppliedRow[],
): Array<{ listing_id: string; price_cents: number }> {
  return applied
    .filter((r) => r.old_price_cents !== r.new_price_cents)
    .map((r) => ({ listing_id: r.listing_id, price_cents: r.old_price_cents }));
}

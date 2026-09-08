// US-3189: when this order has to be handed to the carrier.
//
// The marketplace's own answer wins whenever it gave one. eBay puts it on the
// line item as lineItemFulfillmentInstructions.shipByDate, already resolved
// against the listing's handling time, the buyer's payment moment, the seller's
// business days and the site's cutoff — none of which we can reproduce here and
// all of which we would get subtly wrong.
//
// ── WHY THE FALLBACK IS DELIBERATELY CRUDE ──────────────────────────────────
//
// When eBay gave no date, sold_at + handling_days is the only thing left, and
// it is an APPROXIMATION: it counts calendar days, not business days, so it
// lands earlier than the real deadline whenever a weekend falls inside the
// window. That direction is the safe one — a seller who ships to the earlier
// date is never late — and the alternative, modelling business days plus
// holidays per marketplace, is a calendar we would have to maintain and would
// still get wrong for the seller's own listed non-shipping days.
//
// ── NULL IS AN ANSWER ───────────────────────────────────────────────────────
//
// With neither input there is no deadline, and null says so. The temptation is
// a default of "three days from sale", which would put a countdown, and
// eventually a red overdue badge, on orders nobody is late on. A wrong deadline
// is worse than no deadline: it trains the seller to ignore the queue.

export interface ShipDeadlineInput {
  /** The marketplace's own ship-by instant, ISO 8601. Null when unreported. */
  shipByDate?: string | null;
  /** When the order was placed, ISO 8601. */
  soldAt?: string | null;
  /** Handling time in days, from the listing. Null when unknown. */
  handlingDays?: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Highest handling time worth believing. eBay's own maximum is 30 business
 * days; anything past that in our data is a parse artefact (a price, a
 * quantity, a millisecond figure) rather than a handling time, and turning one
 * into a deadline years out would sort a live order to the bottom of the queue
 * forever.
 */
export const MAX_HANDLING_DAYS = 30;

function parseInstant(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * The ship-by instant for one sale, as an ISO string, or null when there is
 * nothing to stand behind.
 *
 * Precedence is marketplace date, then sold_at + handling_days, then null.
 */
export function resolveShipBy(input: ShipDeadlineInput): string | null {
  const reported = parseInstant(input.shipByDate);
  if (reported !== null) return new Date(reported).toISOString();

  const sold = parseInstant(input.soldAt);
  if (sold === null) return null;

  const days = input.handlingDays;
  if (typeof days !== "number" || !Number.isFinite(days)) return null;
  // Zero is a real handling time — "ships same day" — and means the deadline is
  // the sale itself, so it is kept. Negative is not a handling time.
  if (days < 0 || days > MAX_HANDLING_DAYS) return null;

  return new Date(sold + Math.round(days) * MS_PER_DAY).toISOString();
}

/**
 * Normalize a handling time for storage: a whole number of days inside the
 * believable range, or null. Kept separate from resolveShipBy so the column
 * records what the marketplace said even in the case where the derived date
 * came from an explicit shipByDate instead.
 */
export function normalizeHandlingDays(
  value: number | string | null | undefined,
): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const whole = Math.round(n);
  if (whole < 0 || whole > MAX_HANDLING_DAYS) return null;
  return whole;
}

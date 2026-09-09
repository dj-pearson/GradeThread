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

// ── US-3209: believing eBay when it says the order already shipped ──────────

export interface ShippedAtInput {
  /** eBay's `orderFulfillmentStatus`: NOT_STARTED, IN_PROGRESS or FULFILLED. */
  fulfillmentStatus: string | null | undefined;
  /** What the sale row already carries. Null when we have never recorded one. */
  existingShippedAt: string | null | undefined;
  /** eBay's lastModifiedDate for the order, the closest instant we are given. */
  orderModifiedAt: string | null | undefined;
  /** Fallback clock, injected so the test does not race real time. */
  now?: () => number;
}

/**
 * The `shipped_at` to WRITE for a sale, or null to leave the row alone.
 *
 * THE PROBLEM THIS SOLVES. `shipped_at` has only ever been written by a seller
 * pressing Mark shipped inside GradeThread. A seller who buys the label in
 * eBay's own flow, or in any other tool, ships the order for real and our queue
 * goes on showing it as waiting — so the honest answer to "has this shipped"
 * was "only if you told us", and the ship queue slowly filled with work that
 * was already done. eBay has been telling us the answer the whole time:
 * `orderFulfillmentStatus` is already on every order the sync reads, and was
 * being used only to classify a refund.
 *
 * THREE RULES, all of them about not lying in the other direction.
 *
 * 1. FORWARD ONLY. An existing shipped_at is never moved or cleared. It may
 *    have been set by hand, by a label purchase, or by a previous sync, and all
 *    three are better evidence than a re-read of the same order. Returning null
 *    means "no write", not "not shipped".
 * 2. ONLY ON FULFILLED. NOT_STARTED and IN_PROGRESS both mean at least one
 *    line item is still outstanding. A partially shipped multi-item order is
 *    not a shipped order, and treating it as one would drop the remaining item
 *    out of the queue.
 * 3. eBay'S CLOCK, NOT OURS. lastModifiedDate is the closest instant eBay gives
 *    us for when the order reached this state. `now()` is the fallback, and it
 *    is a fallback rather than the default because stamping discovery time
 *    would date every backfilled order to the day we happened to look.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: import the tracking number. That lives on
 * `/order/{id}/shipping_fulfillment`, one call per order, which is precisely the
 * per-order fan-out US-3110 is cutting before the Application Growth Check. The
 * status is free — it is already in the payload — and it is what the queue is
 * wrong about. A tracking number the seller can read on eBay is worth less than
 * a queue that stops showing them work they have finished.
 */
export function resolveShippedAt(input: ShippedAtInput): string | null {
  const existing = (input.existingShippedAt ?? "").trim();
  if (existing !== "") return null; // rule 1

  const status = (input.fulfillmentStatus ?? "").trim().toUpperCase();
  if (status !== "FULFILLED") return null; // rule 2

  const modified = parseInstant(input.orderModifiedAt); // rule 3
  const at = modified ?? (input.now ?? Date.now)();
  return new Date(at).toISOString();
}

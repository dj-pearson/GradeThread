// US-3190: how long is left on a shipping deadline, in words a seller acts on.
//
// Pure, so the wording is testable without rendering anything, and so the Ship
// tab and the needs-you list cannot describe the same order differently.
//
// ── WHY THE BANDS ARE WHAT THEY ARE ─────────────────────────────────────────
//
// A countdown in raw hours makes a seller do the arithmetic that decides
// whether to drive to the post office today. The bands answer that directly:
// overdue, today, tomorrow, then a plain day count. Nothing finer than an hour
// below a day, because a marketplace's own cutoff is a local business-hours
// thing we do not model, and "3h 12m left" would be a precision we have not
// earned.
//
// ── NULL IS A STATE, NOT A ZERO ─────────────────────────────────────────────
//
// A sale with no ship_by has no deadline we can stand behind (see
// lib/ship-deadline.ts on the edge). It reads as "no deadline" and sorts last,
// the same rule needs-you.ts applies to every other undated item. It must never
// render as overdue, which is what treating null as epoch would do.

export type ShipUrgency = "overdue" | "today" | "tomorrow" | "later" | "none";

export interface ShipCountdown {
  urgency: ShipUrgency;
  /** What the row says, e.g. "Overdue by 2 days", "Due today", "4 days left". */
  label: string;
  /** Whole days until the deadline; negative when overdue. Null when undated. */
  days: number | null;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Read a ship-by instant against `now`.
 *
 * `now` is a parameter rather than a call to Date.now() so the bands can be
 * tested at their edges instead of near them.
 */
export function shipCountdown(
  shipBy: string | null | undefined,
  now: number = Date.now(),
): ShipCountdown {
  if (typeof shipBy !== "string" || shipBy.trim() === "") {
    return { urgency: "none", label: "No deadline", days: null };
  }
  const due = Date.parse(shipBy);
  if (!Number.isFinite(due)) {
    // An unreadable date is not a deadline. Saying so is better than showing a
    // countdown to 1970, which is what a NaN would render as.
    return { urgency: "none", label: "No deadline", days: null };
  }

  const ms = due - now;
  if (ms < 0) {
    const lateHours = Math.floor(-ms / MS_PER_HOUR);
    const lateDays = Math.floor(-ms / MS_PER_DAY);
    return {
      urgency: "overdue",
      label:
        lateDays >= 1
          ? `Overdue by ${plural(lateDays, "day", "days")}`
          : `Overdue by ${plural(Math.max(1, lateHours), "hour", "hours")}`,
      days: -lateDays,
    };
  }

  const hoursLeft = Math.floor(ms / MS_PER_HOUR);
  if (ms < MS_PER_DAY) {
    return {
      urgency: "today",
      label:
        hoursLeft >= 1
          ? `Due in ${plural(hoursLeft, "hour", "hours")}`
          : "Due within the hour",
      days: 0,
    };
  }
  if (ms < 2 * MS_PER_DAY) {
    return { urgency: "tomorrow", label: "Due tomorrow", days: 1 };
  }
  const daysLeft = Math.floor(ms / MS_PER_DAY);
  return {
    urgency: "later",
    label: `${plural(daysLeft, "day", "days")} left`,
    days: daysLeft,
  };
}

/**
 * Rank unshipped orders: soonest deadline first, undated last.
 *
 * The same undated-last rule as rankNeedsYou, for the same reason — a marketplace
 * running no clock on an order is genuinely less urgent than one that is.
 * Stable: equal deadlines fall back to the sale id.
 */
export function rankShipQueue<T extends { id: string; shipBy: string | null }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const ka = a.shipBy ? Date.parse(a.shipBy) : Number.NaN;
    const kb = b.shipBy ? Date.parse(b.shipBy) : Number.NaN;
    const va = Number.isFinite(ka) ? ka : Number.POSITIVE_INFINITY;
    const vb = Number.isFinite(kb) ? kb : Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    return a.id.localeCompare(b.id);
  });
}

// ── US-3190: which write path one order actually has ────────────────────────
//
// The queue is every completed sale with no shipped_at — not every eBay sale —
// and the card renders for a seller with no eBay connection at all
// (post-sale.tsx, the not-connected branch). So the eBay ship route cannot be
// the only way a row leaves the queue. It refuses two orders it was never
// asked about:
//
//   409  the sale has no platform_order_id (flipdesk-ebay.ts:9799) — recorded
//        by hand, or sold somewhere we do not push fulfillment to.
//   503  eBay is not configured on this deployment (flipdesk-ebay.ts:9762), so
//        there is nothing to push for ANY sale.
//
// In both the seller has typed a real tracking number for an order they have
// really shipped, and the row must still leave the queue. ship-order-dialog.tsx
// has always branched this way; the queue card did not, so the one seller the
// card was added for — the manual one — could not use it.

/**
 * True when a failure from POST /orders/:saleId/ship means "this sale was never
 * eBay's to mark shipped" rather than "the shipment failed".
 *
 * 502 is deliberately NOT in here: it means eBay REJECTED the tracking number,
 * and writing shipped_at anyway would drop the order out of the queue while the
 * buyer still sees no tracking. An order the seller thinks is handled and eBay
 * thinks is late is the exact state this whole queue exists to prevent.
 */
export function shipFallsBackToLocal(status: number | null | undefined): boolean {
  return status === 409 || status === 503;
}

/** Which path actually recorded the shipment, so the toast can say so. */
export type ShipPath = "ebay" | "local";

export interface ShipOneOrderDeps {
  /** POST the tracking to the eBay ship route. Rejects with `.status` set. */
  pushToEbay: () => Promise<void>;
  /** Write shipped_at + tracking straight onto the seller's own sales row. */
  writeLocal: () => Promise<void>;
}

/**
 * Ship one order down whichever path it has, and say which one that was.
 *
 * Pure of React and of Supabase — both writes are injected — so the branch a
 * seller's data actually takes is testable without a browser.
 */
export async function shipOneOrder(
  orderRef: string | null | undefined,
  deps: ShipOneOrderDeps,
): Promise<ShipPath> {
  if (typeof orderRef !== "string" || orderRef.trim() === "") {
    // No marketplace order to push to. Skip the round trip rather than spend it
    // on a call whose only possible answer is 409.
    await deps.writeLocal();
    return "local";
  }
  try {
    await deps.pushToEbay();
    return "ebay";
  } catch (err) {
    const status = (err as { status?: number } | null | undefined)?.status;
    if (!shipFallsBackToLocal(status)) throw err;
    await deps.writeLocal();
    return "local";
  }
}

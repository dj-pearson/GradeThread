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
export type ShipPath = "ebay" | "depop" | "shopify" | "local";

export interface ShipOneOrderDeps {
  /** POST the tracking to the eBay ship route. Rejects with `.status` set. */
  pushToEbay: () => Promise<void>;
  /** PS-09: the Depop and Shopify ship routes. Absent means "record locally". */
  pushToDepop?: () => Promise<void>;
  pushToShopify?: () => Promise<void>;
  /** Write shipped_at + tracking straight onto the seller's own sales row. */
  writeLocal: () => Promise<void>;
}

async function pushOrLocal(
  path: Exclude<ShipPath, "local">,
  push: () => Promise<void>,
  writeLocal: () => Promise<void>,
): Promise<ShipPath> {
  try {
    await push();
    return path;
  } catch (err) {
    const status = (err as { status?: number } | null | undefined)?.status;
    if (!shipFallsBackToLocal(status)) throw err;
    await writeLocal();
    return "local";
  }
}

/**
 * Ship one order down whichever path it has, and say which one that was.
 *
 * Pure of React and of Supabase — both writes are injected — so the branch a
 * seller's data actually takes is testable without a browser.
 *
 * PS-09: `platform` is the marketplace the sale came from. A Shopify sale
 * carries a platform_order_id too, and sending it to the eBay route got a 502
 * the seller could never get past, so the row never left the queue. With no
 * platform known the old rule stands: an order ref means eBay.
 */
export async function shipOneOrder(
  orderRef: string | null | undefined,
  deps: ShipOneOrderDeps,
  platform?: string | null,
): Promise<ShipPath> {
  const hasRef = typeof orderRef === "string" && orderRef.trim() !== "";
  const market = (platform ?? "").trim().toLowerCase();
  if (market && market !== "ebay") {
    if (market === "depop" && deps.pushToDepop) {
      return pushOrLocal("depop", deps.pushToDepop, deps.writeLocal);
    }
    if (market === "shopify" && deps.pushToShopify) {
      return pushOrLocal("shopify", deps.pushToShopify, deps.writeLocal);
    }
    await deps.writeLocal();
    return "local";
  }
  if (!hasRef) {
    // No marketplace order to push to. Skip the round trip rather than spend it
    // on a call whose only possible answer is 409.
    await deps.writeLocal();
    return "local";
  }
  return pushOrLocal("ebay", deps.pushToEbay, deps.writeLocal);
}

/** PS-09: what the ship button says, per marketplace. */
export function shipButtonLabel(platform: string | null | undefined, orderRef: string | null): string {
  const market = (platform ?? "").trim().toLowerCase();
  const isEbay = market === "ebay" || (!market && (orderRef ?? "").trim() !== "");
  return isEbay ? "Ship + send to eBay" : "Mark shipped";
}

// ── PS-10: fast tracking entry ──────────────────────────────────────────────
//
// A free-text carrier box meant a blank or misspelt carrier, and the eBay ship
// route maps anything it does not recognise to "Other", so the buyer got a
// tracking number with no carrier link. The carrier is now a pick from the
// four eBay knows (plus Other), prefilled from the shape of the number.

/** The carriers the edge's EBAY_CARRIER_CODES maps, plus its fallback. */
export const SHIP_CARRIERS = ["USPS", "UPS", "FedEx", "DHL", "Other"] as const;
export type ShipCarrier = (typeof SHIP_CARRIERS)[number];

/** Scanners and people both add spaces; eBay wants the bare string. */
export function normalizeTracking(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * The carrier a tracking number belongs to, from its shape. Null when the
 * shape is not one we recognise, so the seller picks rather than we guess.
 *
 * USPS is tested before FedEx because both issue 20-digit numbers; a USPS one
 * starts 92 to 95.
 */
export function detectCarrier(tracking: string): Exclude<ShipCarrier, "Other"> | null {
  const t = normalizeTracking(tracking);
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return "UPS";
  if (/^9[2-5]\d{18,20}$/.test(t)) return "USPS";
  // Label barcodes prefix the tracking with 420 and the destination ZIP
  // (5 or 9 digits).
  if (/^420\d{5}(\d{4})?9[2-5]\d{18,20}$/.test(t)) return "USPS";
  if (/^(\d{12}|\d{15}|\d{20})$/.test(t)) return "FedEx";
  if (/^\d{10}$/.test(t)) return "DHL";
  return null;
}

/** The tracking number a 420+ZIP barcode carries, or the input unchanged. */
export function stripUspsZipPrefix(tracking: string): string {
  const t = normalizeTracking(tracking);
  const m = /^420\d{5}(?:\d{4})?(9[2-5]\d{18,20})$/.exec(t);
  return m ? m[1]! : t;
}

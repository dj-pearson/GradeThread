// US-2941: the three numbers a seller needs to answer an offer in ten seconds.
//
// The offers list showed a price and nothing else, so deciding meant opening
// the item in another tab to find out what it cost and what it was listed at.
// At any volume that is the whole bottleneck, and offers expire.
//
// ── SHARED WITH THE RULES ENGINE ON PURPOSE ─────────────────────────────────
//
// `grossMarginCents` is the same arithmetic the edge's decideOffer margin floor
// applies. The number the seller reads and the number the automation acts on
// must not be able to differ — a rule that skips an offer the screen shows as
// profitable is a rule the seller will switch off and never trust again.
//
// US-3194 added `netMarginCents` beside it, which subtracts eBay's cut, the
// postage and the grading fee. The gross functions stay because the rules
// engine's margin FLOOR is defined against cost alone; the net figures are what
// the seller reads.
//
// ── UNKNOWN IS NOT ZERO ─────────────────────────────────────────────────────
//
// Every function here returns null rather than a number when an input is
// missing. An item with no recorded cost has an UNKNOWN margin, and rendering
// that as $0.00 or as 100% is a confident lie next to an Accept button.

import { ebayFeesFor } from "@/lib/ebay-fees";

export interface OfferEconomicsInput {
  /** The buyer's offer, in dollars. */
  offerPrice: number | null | undefined;
  /** What the listing was asking when the offer landed, in dollars. */
  listPrice: number | null | undefined;
  /** Acquisition cost in dollars, or null when the item has none recorded. */
  itemCost: number | null | undefined;
  /**
   * US-3194: what it costs to send this garment, in dollars. Null when neither
   * the item nor a seller default supplies one.
   */
  shippingCost?: number | null;
  /** US-3194: what grading this item cost, in dollars. Null when it was not graded. */
  gradingCost?: number | null;
}

function usable(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** The offer as a percent of the asking price, to 0.1. Null when unknowable. */
export function pctOfList(input: OfferEconomicsInput): number | null {
  if (!usable(input.offerPrice) || !usable(input.listPrice)) return null;
  return Math.round((input.offerPrice / input.listPrice) * 1000) / 10;
}

/** Gross margin over acquisition cost, in cents. Null when the cost is unknown. */
export function grossMarginCents(input: OfferEconomicsInput): number | null {
  if (!usable(input.offerPrice) || !usable(input.itemCost)) return null;
  return Math.round((input.offerPrice - input.itemCost) * 100);
}

/** That margin as a percent of the offer, to 0.1. Null when the cost is unknown. */
export function marginPct(input: OfferEconomicsInput): number | null {
  const cents = grossMarginCents(input);
  if (cents == null || !usable(input.offerPrice)) return null;
  return Math.round((cents / (input.offerPrice * 100)) * 1000) / 10;
}

// ── US-3194: what actually lands ────────────────────────────────────────────
//
// The gross figures above subtract the acquisition cost and nothing else, so an
// offer that loses money after eBay's cut and the postage reads as profitable
// right beside an Accept button. eBay takes 13.6% plus $0.40 on a $36 offer,
// which is $5.30 — on a garment that cost $12 with $8.30 postage, gross margin
// says $24.00 and the sale actually nets $10.40.
//
// SAME NULL RULE AS THE GROSS FUNCTIONS, for the same reason: an unknown input
// makes the answer unknown, and rendering an unknown as a number next to an
// Accept button is a confident lie. Shipping and grading are optional inputs
// and an ABSENT one costs zero, because "this item was not graded" and "we do
// not know what grading cost" are the same thing here and both mean the grading
// line is not part of this sale.

/** Net after eBay's fees, shipping and grading, in cents. Null when unknowable. */
export function netMarginCents(input: OfferEconomicsInput): number | null {
  if (!usable(input.offerPrice) || !usable(input.itemCost)) return null;
  const fees = ebayFeesFor(input.offerPrice);
  const shipping = usable(input.shippingCost) ? input.shippingCost : 0;
  const grading = usable(input.gradingCost) ? input.gradingCost : 0;
  const net = input.offerPrice - fees - input.itemCost - shipping - grading;
  return Math.round(net * 100);
}

/** That net as a percent of the offer, to 0.1. Null when the cost is unknown. */
export function netMarginPct(input: OfferEconomicsInput): number | null {
  const cents = netMarginCents(input);
  if (cents == null || !usable(input.offerPrice)) return null;
  return Math.round((cents / (input.offerPrice * 100)) * 1000) / 10;
}

export type ExpiryUrgency = "expired" | "last_hours" | "today" | "later";

export interface ExpiryReading {
  urgency: ExpiryUrgency;
  /** Whole hours left. Negative once it has passed. */
  hoursLeft: number;
  label: string;
}

/**
 * How long is left on an offer.
 *
 * HOURS, not days, and that is the point: eBay offers commonly run 48 hours, so
 * a day-granularity countdown spends half its life saying "1d left" on
 * something that expires before lunch. Hours up to 48, then days and hours. `last_hours` is under two hours, which
 * is the band where a seller should stop what they are doing.
 *
 * Returns null for a missing or unreadable date rather than inventing urgency —
 * the same rule the post-sale deadline badge follows.
 */
export function readExpiry(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): ExpiryReading | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  const hoursLeft = Math.floor((at - now) / 3_600_000);
  if (hoursLeft < 0) return { urgency: "expired", hoursLeft, label: "Expired" };
  if (hoursLeft < 2) {
    return {
      urgency: "last_hours",
      hoursLeft,
      label: hoursLeft <= 0 ? "Under an hour left" : "Under 2 hours left",
    };
  }
  if (hoursLeft < 24) {
    return { urgency: "today", hoursLeft, label: `${hoursLeft}h left` };
  }
  // OM-05: hours all the way to 48. "1d left" covered everything from 24h to
  // 47h, so an offer with a day to spend and one about to die read the same.
  if (hoursLeft < 48) {
    return { urgency: "later", hoursLeft, label: `${hoursLeft}h left` };
  }
  const days = Math.floor(hoursLeft / 24);
  const rest = hoursLeft % 24;
  return {
    urgency: "later",
    hoursLeft,
    label: rest > 0 ? `${days}d ${rest}h left` : `${days}d left`,
  };
}

/** Money, for display. */
export function formatMoney(cents: number, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const sign = cents < 0 ? "-" : "";
  return `${sign}${symbol}${Math.abs(cents / 100).toFixed(2)}`;
}

// ── OM-07: a counter eBay will take ─────────────────────────────────────────
//
// The same bounds the edge enforces (services/edge-functions/src/lib/
// offer-limits.ts validateCounter): above the buyer's bid, below the asking
// price. The seller used to learn them from a generic eBay 502 after pressing
// Send. The edge stays the authority; this shows the rule before the press.

export interface CounterCheck {
  ok: boolean;
  /** The typed price in whole cents, when it parses. */
  cents: number | null;
  /** Why it cannot be sent, for the inline hint. Null for an empty box. */
  reason: string | null;
}

/** The bounds a counter is checked against, in dollars. */
export interface CounterBounds {
  price?: number | null;
  listPriceCents?: number | null;
  currency?: string | null;
}

export function validateCounter(offer: CounterBounds, priceText: string): CounterCheck {
  const t = priceText.trim();
  if (t === "") return { ok: false, cents: null, reason: null };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) {
    return {
      ok: false,
      cents: null,
      reason: /^\d*\.\d{3,}$/.test(t)
        ? "Use dollars and cents, like 42.50."
        : "Enter a price, like 42.50.",
    };
  }
  const cents = Math.round(Number(t) * 100);
  const cur = offer.currency ?? "USD";
  if (cents <= 0) return { ok: false, cents, reason: "Enter a price above zero." };
  const offerCents = usable(offer.price) ? Math.round(offer.price * 100) : null;
  if (offerCents != null && cents <= offerCents) {
    return {
      ok: false,
      cents,
      reason: `A counter has to be more than the buyer's ${formatMoney(offerCents, cur)}.`,
    };
  }
  const listCents = offer.listPriceCents ?? null;
  if (listCents != null && listCents > 0 && cents >= listCents) {
    return {
      ok: false,
      cents,
      reason: `A counter has to be less than your ${formatMoney(listCents, cur)} asking price.`,
    };
  }
  return { ok: true, cents, reason: null };
}

// ── OM-15: counters priced from the net, not guessed at ─────────────────────

/**
 * The lowest price, in cents, at which the sale nets at least `targetNetCents`
 * after eBay's fees, postage and grading. Null when the cost is unknown (the
 * net is then unknowable, so no price can be solved for).
 *
 * A search rather than an algebraic inverse, so it stays right whatever shape
 * the fee schedule takes: net only ever rises with price, which is all a
 * binary search needs.
 */
export function solvePriceForNet(
  input: OfferEconomicsInput,
  targetNetCents: number,
): number | null {
  if (!usable(input.itemCost)) return null;
  const netAt = (cents: number) =>
    netMarginCents({ ...input, offerPrice: cents / 100 }) ?? Number.NEGATIVE_INFINITY;
  let lo = 1;
  let hi = 100;
  while (netAt(hi) < targetNetCents) {
    hi *= 2;
    if (hi > 1_000_000_000) return null;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (netAt(mid) >= targetNetCents) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface QuickCounter {
  id: "split" | "ask_minus_10" | "floor";
  label: string;
  cents: number;
  /** What the seller keeps at this price, or null when the cost is unknown. */
  netCents: number | null;
}

/** The seller's offer rule, when one is active: its accept point and margin floor. */
export interface CounterRule {
  acceptAtPct: number | null;
  marginFloorPct: number | null;
}

/**
 * Three one-click counters, each already inside the range a counter may take.
 * A chip whose price falls outside that range is dropped rather than clamped:
 * "Split the difference" that is not a split is a label that lies.
 *
 * "Counter at my floor" is the higher of the rule's accept point and the price
 * that nets the margin floor on cost (10% when no rule says otherwise), and it
 * never goes below break-even.
 */
export function quickCounters(
  offer: CounterBounds & { itemCost?: number | null; shippingCost?: number | null; gradingCost?: number | null },
  rule: CounterRule | null = null,
): QuickCounter[] {
  const listCents = offer.listPriceCents ?? null;
  const offerCents = usable(offer.price) ? Math.round(offer.price * 100) : null;
  const economics: OfferEconomicsInput = {
    offerPrice: offer.price,
    listPrice: listCents != null ? listCents / 100 : null,
    itemCost: offer.itemCost,
    shippingCost: offer.shippingCost,
    gradingCost: offer.gradingCost,
  };
  const candidates: Array<Omit<QuickCounter, "netCents">> = [];
  if (offerCents != null && listCents != null) {
    candidates.push({
      id: "split",
      label: "Split the difference",
      cents: Math.round((offerCents + listCents) / 2),
    });
  }
  if (listCents != null) {
    candidates.push({ id: "ask_minus_10", label: "Ask minus 10%", cents: Math.round(listCents * 0.9) });
  }
  if (usable(offer.itemCost)) {
    const floorPct = rule?.marginFloorPct ?? 10;
    const costCents = Math.round(offer.itemCost * 100);
    const breakEven = solvePriceForNet(economics, 0);
    const marginFloor = solvePriceForNet(economics, Math.round((costCents * floorPct) / 100));
    const ruleAccept = rule?.acceptAtPct != null && listCents != null
      ? Math.ceil((listCents * rule.acceptAtPct) / 100)
      : null;
    const floor = Math.max(
      breakEven ?? 0,
      marginFloor ?? 0,
      ruleAccept ?? 0,
    );
    if (floor > 0) candidates.push({ id: "floor", label: "Counter at my floor", cents: floor });
  }
  const out: QuickCounter[] = [];
  for (const c of candidates) {
    if (!validateCounter(offer, (c.cents / 100).toFixed(2)).ok) continue;
    out.push({ ...c, netCents: netMarginCents({ ...economics, offerPrice: c.cents / 100 }) });
  }
  return out;
}

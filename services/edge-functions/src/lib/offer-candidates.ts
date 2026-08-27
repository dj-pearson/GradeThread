// US-2943: which items are worth sending an offer to today, and in what order.
//
// `find_eligible_items` is on-demand: a seller has to think to go and look, and
// the whole value of send-offer is that it reaches people who are ALREADY
// watching an item and have not pulled the trigger. A list nobody opens is a
// feature that does not exist.
//
// So this ranks the eligible set into something worth reading every morning,
// and — more importantly — refuses to put an item on it twice in a week.
//
// ── THE COOLDOWN IS THE POINT ───────────────────────────────────────────────
//
// eBay lets a seller offer the same watchers a discount repeatedly. Doing that
// trains a watcher to wait: if a 10% offer arrives every Monday, the rational
// move is never to buy at full price. The cooldown is what stops the daily list
// turning into a weekly discount schedule the buyers can read.
//
// Pure. The eBay call and the database reads live in the route.

/**
 * Days before the same item may be offered again.
 *
 * A week, because eBay's own send-offer expiry is 48 hours and anything shorter
 * would let two live offers overlap on one item. Named rather than inlined
 * because the route, the digest and the test all have to mean the same number.
 */
export const OFFER_COOLDOWN_DAYS = 7;

export interface OfferCandidate {
  listingId: string;
  title: string | null;
  priceCents: number | null;
  watchers: number;
  daysListed: number | null;
  /** When we last sent this item an offer, if ever. */
  lastOfferedAt: string | null;
}

export interface RankedCandidates {
  candidates: OfferCandidate[];
  /** Items eBay says are eligible but that are inside the cooldown. */
  suppressed: OfferCandidate[];
}

function daysSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 86_400_000;
}

/**
 * Split the eligible set into what to offer today and what to hold. Pure.
 *
 * ORDER: watchers descending first, then days listed descending. Watchers is
 * the stronger signal by a distance — a discount reaches people who are already
 * watching, so an item with nine watchers is nine chances and an item with none
 * is a discount sent into an empty room. Age breaks the tie because between two
 * equally-watched items the older one has already failed to sell at full price.
 *
 * An item with an UNKNOWN age sorts last within its watcher group rather than
 * first: "we do not know how long this has been up" is not a reason to discount
 * it ahead of one we know has sat for ninety days.
 */
export function rankOfferCandidates(
  items: OfferCandidate[],
  nowMs: number = Date.now(),
  cooldownDays: number = OFFER_COOLDOWN_DAYS,
): RankedCandidates {
  const candidates: OfferCandidate[] = [];
  const suppressed: OfferCandidate[] = [];
  for (const item of items) {
    const since = daysSince(item.lastOfferedAt, nowMs);
    if (since != null && since < cooldownDays) suppressed.push(item);
    else candidates.push(item);
  }
  const byRank = (a: OfferCandidate, b: OfferCandidate) => {
    if (b.watchers !== a.watchers) return b.watchers - a.watchers;
    const ad = a.daysListed ?? -1;
    const bd = b.daysListed ?? -1;
    return bd - ad;
  };
  return { candidates: [...candidates].sort(byRank), suppressed: [...suppressed].sort(byRank) };
}

/**
 * The most a batch of offers could cost, in cents.
 *
 * WORST CASE, deliberately: it assumes every offer is taken. A seller pressing
 * "send 12% off to 40 items" is entitled to know the largest number that can
 * come out of it, and an expected-value figure computed from an accept rate
 * would understate it by design.
 *
 * Null when any candidate has no price — a total that silently omits the items
 * it could not price is worse than no total.
 */
export function totalDiscountExposureCents(
  candidates: OfferCandidate[],
  discountPct: number,
): number | null {
  if (!Number.isFinite(discountPct) || discountPct <= 0) return null;
  let total = 0;
  for (const c of candidates) {
    if (c.priceCents == null) return null;
    total += Math.round(c.priceCents * (discountPct / 100));
  }
  return total;
}

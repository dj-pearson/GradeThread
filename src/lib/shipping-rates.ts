// USPS postage for a predicted parcel, and the band edge worth telling a
// seller about (US-2790).
//
// EVERY NUMBER HERE WAS READ OFF THE CARRIER'S OWN PRICE LIST and is recorded,
// with its URL and the date, in docs/shipping/usps-rates-CONFIRMED.csv. Each
// band was read TWICE, in differently worded requests, and both reads agreed.
// Nothing in this file may be edited from memory, from a search summary, or
// from a page that quotes USPS — src/lib/ebay-fee-schedule.ts shipped a
// real-but-wrong number that way once, and a plausible wrong number is the
// dangerous kind.
//
// THE EFFECTIVE DATE IS REAL. USPS prints it on Notice 123 ("Effective July
// 12, 2026"), so it is read rather than invented. That is the difference from
// the eBay fee schedule, where no such date exists and stamping one was
// refused.
//
// MIRROR: duplicated VERBATIM at
//   services/edge-functions/src/lib/shipping-rates.ts
// and held byte-identical by src/lib/__tests__/shipping-rates.test.ts. No
// imports, so it type-checks under both tsconfig and Deno.
//
// ZONE 4 IS A REPRESENTATIVE ZONE, NOT A PRICE. At listing time there is no
// buyer, so there is no destination and no true postage. This is a number for
// making a pricing decision; accounting already has the real figure from the
// payout sync. Anything rendering it says "est." and means it.

/** Printed on USPS Notice 123. Read, not invented. */
export const RATE_EFFECTIVE_FROM = "2026-07-12";

/** The zone these prices are for. See the header on why it is representative. */
export const RATE_ZONE = "4";

export const RATE_SOURCE_URL = "https://pe.usps.com/text/dmm300/Notice123.htm";

/**
 * USPS Ground Advantage retail, zone 4, ascending by band ceiling.
 *
 * `maxOz` is the top of the band: a parcel weighing up to and including that
 * many ounces pays `priceUsd`. Bands are the published steps — 4 oz, 8 oz,
 * 12 oz, then 1 lb and each pound after — not a formula, because USPS does not
 * price by a formula and interpolating between published steps would invent
 * prices that are not charged.
 */
export const GROUND_ADVANTAGE_ZONE4: ReadonlyArray<{
  maxOz: number;
  priceUsd: number;
}> = [
  { maxOz: 4, priceUsd: 8.30 },
  { maxOz: 8, priceUsd: 8.30 },
  { maxOz: 12, priceUsd: 10.60 },
  { maxOz: 16, priceUsd: 10.60 },
  { maxOz: 32, priceUsd: 13.00 },
  { maxOz: 48, priceUsd: 13.70 },
  { maxOz: 64, priceUsd: 14.85 },
  { maxOz: 80, priceUsd: 15.80 },
];

export interface PostageQuote {
  priceUsd: number;
  /** Top of the band this parcel falls in. */
  bandMaxOz: number;
  /** How many ounces until the next band starts charging more. */
  ozToNextBand: number;
  effectiveFrom: string;
  zone: string;
}

/**
 * Postage for a billable weight, or null above the heaviest band we read.
 *
 * NULL RATHER THAN AN EXTRAPOLATION. The published table runs to 70 lb and
 * only the bands through 5 lb have been read, so anything heavier has no
 * sourced price. Returning a computed guess would be exactly the invented
 * number this file's header refuses — a caller can say "we cannot estimate
 * this one", which is true, and cannot say a wrong price is right.
 */
export function estimatePostage(billableOz: number): PostageQuote | null {
  if (!Number.isFinite(billableOz) || billableOz <= 0) return null;
  for (let i = 0; i < GROUND_ADVANTAGE_ZONE4.length; i++) {
    const band = GROUND_ADVANTAGE_ZONE4[i];
    if (band === undefined) continue;
    if (billableOz <= band.maxOz) {
      return {
        priceUsd: band.priceUsd,
        bandMaxOz: band.maxOz,
        ozToNextBand: band.maxOz - billableOz,
        effectiveFrom: RATE_EFFECTIVE_FROM,
        zone: RATE_ZONE,
      };
    }
  }
  return null;
}

/** Within this many ounces of a band edge, trimming is worth mentioning. */
const NEAR_EDGE_OZ = 1;

/**
 * "You are paying the next band for a few ounces" — or null when there is
 * nothing useful to say.
 *
 * DELIBERATELY QUIET MOST OF THE TIME. A warning on every listing is a warning
 * nobody reads. It speaks only when the parcel is just OVER a band edge AND
 * the band below is genuinely cheaper — two bands at the same price (4 oz and
 * 8 oz both cost the same here) make trimming pointless, and telling someone
 * to shave ounces for nothing is worse than silence.
 */
export function rateBreakWarning(billableOz: number): string | null {
  if (!Number.isFinite(billableOz) || billableOz <= 0) return null;
  for (let i = 1; i < GROUND_ADVANTAGE_ZONE4.length; i++) {
    const below = GROUND_ADVANTAGE_ZONE4[i - 1];
    const band = GROUND_ADVANTAGE_ZONE4[i];
    if (below === undefined || band === undefined) continue;
    const over = billableOz - below.maxOz;
    if (over > 0 && over <= NEAR_EDGE_OZ && band.priceUsd > below.priceUsd) {
      const saving = band.priceUsd - below.priceUsd;
      return (
        `About ${over.toFixed(1)} oz over the ${below.maxOz} oz band. ` +
        `Trimming under it would save an estimated $${saving.toFixed(2)}.`
      );
    }
  }
  return null;
}

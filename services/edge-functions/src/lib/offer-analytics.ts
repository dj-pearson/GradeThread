// US-2942: what discount depth actually converts, measured on this seller's own
// offers.
//
// Every reseller guesses at this. "Send 10% off" is folklore; nobody measures
// whether 10% converts any worse than 20%, because nobody has the data. Once
// offers are stored (US-2939) it is arithmetic, and the answer is worth real
// money: if 12% converts as well as 20%, every 20% offer that seller ever sent
// gave away 8 points for nothing.
//
// ── THE HONEST-NUMBER RULES ─────────────────────────────────────────────────
//
// 1. Every bucket carries its sample size, and a bucket under MIN_BUCKET_SAMPLE
//    reports `acceptRate: null` rather than a percentage. Two offers at 25% off,
//    one accepted, is not a 50% accept rate.
// 2. The "efficient depth" claim is only made when the arithmetic supports it,
//    and the arithmetic is returned alongside it so a seller can check the
//    claim rather than take it. A recommendation with no shown working is
//    indistinguishable from a guess.
// 3. Offers we SENT and counters we sent are reported separately. They are
//    different acts — one is an unprompted discount, the other an answer to a
//    bid — and a buyer who accepts a counter has already told us they want the
//    item. Pooling them would flatter the send-offer numbers with the counters'
//    much higher accept rate.
//
// Pure. The loader lives in the route.

/** Below this many offers, a bucket's accept rate is noise. */
export const MIN_BUCKET_SAMPLE = 10;

/** Discount bands, in percent off the asking price. */
export const DEPTH_BUCKETS = [5, 10, 15, 20, 25, 30, 40] as const;

export interface AnalyticsOffer {
  /** What we offered or countered at, in cents. */
  amountCents: number | null;
  /** The asking price at the time, in cents. The SNAPSHOT, not today's. */
  listPriceCents: number | null;
  /** "accepted" | "declined" | "countered" | "expired" | null while open. */
  response: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export interface DepthBucket {
  /** Human label, e.g. "10-15% off". */
  key: string;
  /** The lower edge, in percent off. Used for ordering and for the claim. */
  fromPct: number;
  offers: number;
  accepted: number;
  /** null when `offers` is under MIN_BUCKET_SAMPLE. */
  acceptRate: number | null;
  medianDaysToAccept: number | null;
}

/**
 * Which bucket a discount falls in. Pure and exported so the boundary is
 * testable: a 10%-off offer belongs to the 10-15 band, not the 5-10 one.
 */
export function bucketFor(discountPct: number): { key: string; fromPct: number } | null {
  if (!Number.isFinite(discountPct) || discountPct < 0) return null;
  let from = 0;
  for (const edge of DEPTH_BUCKETS) {
    if (discountPct < edge) {
      return { key: from === 0 ? `under ${edge}% off` : `${from}-${edge}% off`, fromPct: from };
    }
    from = edge;
  }
  return { key: `${from}%+ off`, fromPct: from };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export interface EfficientDepth {
  /** The shallowest bucket whose accept rate is indistinguishable from the best. */
  key: string;
  fromPct: number;
  acceptRate: number;
  /** The bucket it is being compared against. */
  bestKey: string;
  bestAcceptRate: number;
  /**
   * The working, so the claim can be checked rather than taken.
   *
   * "Indistinguishable" here means the gap is inside the wider of the two
   * standard errors — a deliberately loose test, because the cost of wrongly
   * recommending the shallower depth is a few lost sales and the cost of never
   * making the claim is every offer being 10 points deeper than it needed to be.
   */
  explanation: string;
}

/** Standard error of a proportion. */
function standardError(rate: number, n: number): number {
  if (n <= 0) return 1;
  return Math.sqrt(Math.max(rate * (1 - rate), 0) / n);
}

/**
 * The shallowest depth that converts as well as the best one, or null when the
 * data cannot support the claim.
 *
 * Returns null — rather than the best bucket — when only one bucket has a
 * usable sample. With one data point there is no comparison, and reporting it
 * as "the efficient depth" would dress a single observation as a finding.
 */
export function findEfficientDepth(buckets: DepthBucket[]): EfficientDepth | null {
  const usable = buckets.filter(
    (b): b is DepthBucket & { acceptRate: number } => b.acceptRate != null,
  );
  if (usable.length < 2) return null;
  const best = usable.reduce((a, b) => (b.acceptRate > a.acceptRate ? b : a));
  const bestSe = standardError(best.acceptRate, best.offers);
  const shallowest = [...usable]
    .sort((a, b) => a.fromPct - b.fromPct)
    .find((b) => {
      const se = Math.max(bestSe, standardError(b.acceptRate, b.offers));
      return best.acceptRate - b.acceptRate <= se;
    });
  if (!shallowest) return null;
  const gap = ((best.acceptRate - shallowest.acceptRate) * 100).toFixed(1);
  const se = (Math.max(bestSe, standardError(shallowest.acceptRate, shallowest.offers)) * 100)
    .toFixed(1);
  return {
    key: shallowest.key,
    fromPct: shallowest.fromPct,
    acceptRate: shallowest.acceptRate,
    bestKey: best.key,
    bestAcceptRate: best.acceptRate,
    explanation:
      `${shallowest.key} accepts at ${(shallowest.acceptRate * 100).toFixed(1)}% over ` +
      `${shallowest.offers} offers; ${best.key} accepts at ` +
      `${(best.acceptRate * 100).toFixed(1)}% over ${best.offers}. The gap is ` +
      `${gap} points and the margin of error is ${se}, so the deeper discount is ` +
      `not measurably better.`,
  };
}

export interface OfferAnalytics {
  buckets: DepthBucket[];
  efficientDepth: EfficientDepth | null;
  totalOffers: number;
  minBucketSample: number;
}

/** Bucket a set of offers by discount depth and score each. Pure. */
export function summarizeOffers(offers: AnalyticsOffer[]): OfferAnalytics {
  const byKey = new Map<string, { fromPct: number; rows: AnalyticsOffer[] }>();
  for (const o of offers) {
    if (o.amountCents == null || o.listPriceCents == null || o.listPriceCents <= 0) continue;
    const discountPct = ((o.listPriceCents - o.amountCents) / o.listPriceCents) * 100;
    const bucket = bucketFor(discountPct);
    if (!bucket) continue;
    const entry = byKey.get(bucket.key);
    if (entry) entry.rows.push(o);
    else byKey.set(bucket.key, { fromPct: bucket.fromPct, rows: [o] });
  }

  const buckets: DepthBucket[] = [...byKey.entries()]
    .map(([key, { fromPct, rows }]) => {
      const accepted = rows.filter((r) => r.response === "accepted");
      const days = accepted
        .map((r) => {
          if (!r.respondedAt) return null;
          const a = Date.parse(r.createdAt);
          const b = Date.parse(r.respondedAt);
          if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
          return Math.round((b - a) / 86_400_000);
        })
        .filter((d): d is number => d != null);
      return {
        key,
        fromPct,
        offers: rows.length,
        accepted: accepted.length,
        acceptRate: rows.length >= MIN_BUCKET_SAMPLE ? accepted.length / rows.length : null,
        medianDaysToAccept: median(days),
      };
    })
    // Shallowest first: the seller reads this looking for the cheapest depth
    // that works, so the answer should be near the top.
    .sort((a, b) => a.fromPct - b.fromPct);

  return {
    buckets,
    efficientDepth: findEfficientDepth(buckets),
    totalOffers: offers.length,
    minBucketSample: MIN_BUCKET_SAMPLE,
  };
}

// US-1869: Inventory Equity — conservative per-item liquidation-value model.
//
// The estimated liquidation value of a seller's GRADED inventory — the capital
// sitting on their racks. Phase 1 is DISPLAY-ONLY (US-1868 scope fence: no
// lending / working-capital advances). Conservatism is the product: a number
// the seller trusts beats a number that flatters, so every haircut only ever
// discounts, and an item we can't price honestly is EXCLUDED, never guessed.
//
// Pure + deterministic (cents in, cents out; caller passes the current-time-
// derived staleness) so it fully unit-tests without a DB, eBay, or AI call. The
// endpoint composes cached comp data (comp_set) — zero new comp/AI spend.

export interface CompPrice {
  /** Realized/asking comp price in cents. */
  cents: number;
}

export const MIN_EQUITY_COMPS = 3;

/**
 * Median comp price (cents) from a cached comp set, or null when there aren't
 * enough comps to price honestly. Pure — the caller supplies already-stored
 * comps (no live fetch).
 */
export function marketMedianFromComps(comps: CompPrice[]): number | null {
  const prices = comps
    .map((c) => c.cents)
    .filter((c) => Number.isFinite(c) && c > 0)
    .sort((a, b) => a - b);
  if (prices.length < MIN_EQUITY_COMPS) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0
    ? Math.round((prices[mid - 1]! + prices[mid]!) / 2)
    : prices[mid]!;
}

// Personal sell-through-velocity haircut: the seller's OWN median days-to-sell.
// A slow personal velocity means the item is worth less as liquid capital, so it
// discounts harder. Unknown velocity is treated conservatively (a real haircut,
// not a free pass). Factors are ≤ 1 — never inflate.
export const VELOCITY_HAIRCUT = {
  UNKNOWN: 0.85,
  FAST_MAX_DAYS: 30, // ≤30d
  FAST: 1.0,
  BRISK_MAX_DAYS: 60,
  BRISK: 0.95,
  STEADY_MAX_DAYS: 90,
  STEADY: 0.9,
  SLOW_MAX_DAYS: 180,
  SLOW: 0.8,
  STALE: 0.7, // >180d
} as const;

export function velocityFactor(personalSellThroughDays: number | null): number {
  const d = personalSellThroughDays;
  if (d == null || !Number.isFinite(d) || d < 0) return VELOCITY_HAIRCUT.UNKNOWN;
  if (d <= VELOCITY_HAIRCUT.FAST_MAX_DAYS) return VELOCITY_HAIRCUT.FAST;
  if (d <= VELOCITY_HAIRCUT.BRISK_MAX_DAYS) return VELOCITY_HAIRCUT.BRISK;
  if (d <= VELOCITY_HAIRCUT.STEADY_MAX_DAYS) return VELOCITY_HAIRCUT.STEADY;
  if (d <= VELOCITY_HAIRCUT.SLOW_MAX_DAYS) return VELOCITY_HAIRCUT.SLOW;
  return VELOCITY_HAIRCUT.STALE;
}

// Staleness haircut: how long THIS item has sat listed. A listing that isn't
// moving is worth less than a fresh one at the same comp price.
export const STALENESS_HAIRCUT = {
  FRESH_MAX_DAYS: 30,
  FRESH: 1.0,
  AGING_MAX_DAYS: 60,
  AGING: 0.97,
  OLD_MAX_DAYS: 90,
  OLD: 0.92,
  STALE_MAX_DAYS: 180,
  STALE: 0.85,
  DEAD: 0.75, // >180d
} as const;

export function stalenessFactor(daysListed: number | null): number {
  const d = daysListed;
  if (d == null || !Number.isFinite(d) || d <= STALENESS_HAIRCUT.FRESH_MAX_DAYS) {
    return STALENESS_HAIRCUT.FRESH;
  }
  if (d <= STALENESS_HAIRCUT.AGING_MAX_DAYS) return STALENESS_HAIRCUT.AGING;
  if (d <= STALENESS_HAIRCUT.OLD_MAX_DAYS) return STALENESS_HAIRCUT.OLD;
  if (d <= STALENESS_HAIRCUT.STALE_MAX_DAYS) return STALENESS_HAIRCUT.STALE;
  return STALENESS_HAIRCUT.DEAD;
}

export type UnvaluedReason = "no_grade" | "no_comps";

export interface LiquidationInput {
  /** Cached condition-matched market median (cents), or null when too thin. */
  marketMedianCents: number | null;
  /** 0..1 confidence in the market value (comp count / source quality). */
  marketConfidence: number;
  /** The item's grade (1..10); null → excluded (never guess an ungraded item). */
  gradeValue: number | null;
  /** Seller's own median days-to-sell; null when unknown. */
  personalSellThroughDays: number | null;
  /** How long this item has been listed; null → treated as fresh. */
  daysListed: number | null;
}

export interface LiquidationValue {
  /** false → the item is EXCLUDED from equity (counted as unvalued). */
  valued: boolean;
  reason?: UnvaluedReason;
  liquidationCents: number | null;
  /** Conservative confidence band around the liquidation value. */
  lowCents: number | null;
  highCents: number | null;
  confidence: number;
}

// Band half-width as a fraction of the value: tight when market confidence is
// high, wide when it's low. Clamped to [10%, 50%].
function bandFraction(marketConfidence: number): number {
  const c = Math.max(0, Math.min(1, marketConfidence));
  return Math.max(0.1, Math.min(0.5, 0.1 + 0.4 * (1 - c)));
}

/**
 * Conservative liquidation value for one graded item. Ungraded items and items
 * without usable comps are EXCLUDED (valued:false) rather than guessed.
 */
export function liquidationValue(input: LiquidationInput): LiquidationValue {
  if (input.gradeValue == null) {
    return { valued: false, reason: "no_grade", liquidationCents: null, lowCents: null, highCents: null, confidence: 0 };
  }
  if (input.marketMedianCents == null || input.marketMedianCents <= 0) {
    return { valued: false, reason: "no_comps", liquidationCents: null, lowCents: null, highCents: null, confidence: 0 };
  }

  const vFactor = velocityFactor(input.personalSellThroughDays);
  const sFactor = stalenessFactor(input.daysListed);
  const liquidation = Math.round(input.marketMedianCents * vFactor * sFactor);

  const frac = bandFraction(input.marketConfidence);
  const low = Math.round(liquidation * (1 - frac));
  const high = Math.round(liquidation * (1 + frac));

  // Output confidence: the market confidence, further discounted when we had to
  // fall back to the unknown-velocity haircut.
  const velocityKnown = input.personalSellThroughDays != null &&
    Number.isFinite(input.personalSellThroughDays);
  const confidence = Math.max(
    0,
    Math.min(1, input.marketConfidence * (velocityKnown ? 1 : 0.85)),
  );

  return { valued: true, liquidationCents: liquidation, lowCents: low, highCents: high, confidence };
}

// ── aggregate ───────────────────────────────────────────────────────────────

// Grade bands for the by-grade-band breakdown (matches the CLAUDE.md tiers:
// NWT/NWOT 9-10, Excellent 8, Very Good 7, Good 6, Fair 5, Poor 3-4).
export function gradeBand(gradeValue: number | null): string {
  if (gradeValue == null) return "ungraded";
  if (gradeValue >= 9) return "9.0-10";
  if (gradeValue >= 7) return "7.0-8.9";
  if (gradeValue >= 5) return "5.0-6.9";
  return "under-5";
}

export interface EquityItem {
  liquidation: LiquidationValue;
  category: string | null;
  brand: string | null;
  gradeValue: number | null;
}

export interface EquityBucket {
  cents: number;
  count: number;
}

export interface EquityAggregate {
  totalEquityCents: number;
  /** Total conservative confidence band (sum of per-item low/high). */
  totalLowCents: number;
  totalHighCents: number;
  valuedCount: number;
  unvaluedCount: number;
  /** Why the unvalued items were excluded. */
  unvaluedByReason: Record<UnvaluedReason, number>;
  byCategory: Record<string, EquityBucket>;
  byBrand: Record<string, EquityBucket>;
  byGradeBand: Record<string, EquityBucket>;
}

/**
 * Roll per-item liquidation values into the tenant aggregate. Unvalued items
 * (no grade / no comps) contribute to the counts ONLY — never to the total.
 */
export function aggregateEquity(items: EquityItem[]): EquityAggregate {
  const agg: EquityAggregate = {
    totalEquityCents: 0,
    totalLowCents: 0,
    totalHighCents: 0,
    valuedCount: 0,
    unvaluedCount: 0,
    unvaluedByReason: { no_grade: 0, no_comps: 0 },
    byCategory: {},
    byBrand: {},
    byGradeBand: {},
  };
  const bump = (
    map: Record<string, EquityBucket>,
    key: string,
    cents: number,
  ) => {
    const b = map[key] ?? { cents: 0, count: 0 };
    b.cents += cents;
    b.count++;
    map[key] = b;
  };
  for (const it of items) {
    const { liquidation } = it;
    if (!liquidation.valued || liquidation.liquidationCents == null) {
      agg.unvaluedCount++;
      if (liquidation.reason) agg.unvaluedByReason[liquidation.reason]++;
      continue;
    }
    const cents = liquidation.liquidationCents;
    agg.totalEquityCents += cents;
    agg.totalLowCents += liquidation.lowCents ?? cents;
    agg.totalHighCents += liquidation.highCents ?? cents;
    agg.valuedCount++;

    bump(agg.byCategory, (it.category ?? "").trim() || "uncategorized", cents);
    bump(agg.byBrand, (it.brand ?? "").trim() || "unbranded", cents);
    bump(agg.byGradeBand, gradeBand(it.gradeValue), cents);
  }
  return agg;
}

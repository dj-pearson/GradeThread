// US-1826: portfolio valuation engine — the PURE, unit-tested core.
//
// Combines the signals we actually have — realized grade_outcomes prices (what
// items like this SOLD for), Value Index fair value (brand/item/condition), and
// the buyer's cost basis (what they paid, gently age-depreciated) — into a
// labeled current-value ESTIMATE with a confidence band. It never fabricates
// precision: with no signal at all, the estimate is null and confidence 'none'.
// The impure resolution (price-guide / grade_outcomes / purchase-link reads +
// cache) lives in portfolio-valuation-db.ts.

const YEAR_DAYS = 365;

export interface ValuationInputs {
  /** Realized median sale price for comparable items (strongest — actual sales). */
  realizedMedianCents: number | null;
  /** Value Index fair-value band for the item's grade. */
  fairValueMedianCents: number | null;
  fairValueLowCents: number | null;
  fairValueHighCents: number | null;
  /** What the buyer paid (purchase link), before depreciation. */
  costBasisCents: number | null;
  /** Age since grading/purchase, days — drives cost-basis depreciation only. */
  ageDays: number | null;
}

export type ValuationConfidence = "high" | "medium" | "low" | "none";
export type ValuationTrend = "up" | "down" | "flat" | "unknown";

export interface Valuation {
  estimateCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  confidence: ValuationConfidence;
  basis: string[];
  trend: ValuationTrend;
}

/** Gentle secondhand depreciation from cost basis: ~15%/yr, floored at 40% (a
 *  purchase link is already a resale price, so this is deliberately shallow). */
export function depreciationFactor(ageDays: number | null): number {
  if (ageDays == null || ageDays <= 0) return 1;
  const years = ageDays / YEAR_DAYS;
  return Math.max(0.4, 1 - 0.15 * years);
}

const round = (n: number) => Math.round(n);

/**
 * Estimate an item's current value. PURE. Anchors are weighted by how directly
 * they reflect realizable value: realized sales (3) > Value Index fair value (2)
 * > depreciated cost basis (1). Confidence tracks the best anchor present; the
 * band comes from the Value Index range when available, else widens with
 * uncertainty. Trend is a coarse gain/loss read vs cost basis.
 */
export function estimateItemValue(inputs: ValuationInputs): Valuation {
  const basis: string[] = [];
  const anchors: Array<{ cents: number; weight: number }> = [];

  if (inputs.realizedMedianCents != null && inputs.realizedMedianCents > 0) {
    anchors.push({ cents: inputs.realizedMedianCents, weight: 3 });
    basis.push("realized");
  }
  if (inputs.fairValueMedianCents != null && inputs.fairValueMedianCents > 0) {
    anchors.push({ cents: inputs.fairValueMedianCents, weight: 2 });
    basis.push("value_index");
  }
  const depreciatedCost = inputs.costBasisCents != null && inputs.costBasisCents > 0
    ? round(inputs.costBasisCents * depreciationFactor(inputs.ageDays))
    : null;
  if (depreciatedCost != null) {
    anchors.push({ cents: depreciatedCost, weight: 1 });
    basis.push("cost_basis");
  }

  if (anchors.length === 0) {
    return { estimateCents: null, lowCents: null, highCents: null, confidence: "none", basis: [], trend: "unknown" };
  }

  const totalWeight = anchors.reduce((s, a) => s + a.weight, 0);
  const estimate = round(anchors.reduce((s, a) => s + a.cents * a.weight, 0) / totalWeight);

  // Confidence: realized ⇒ high; Value Index ⇒ medium; cost-basis-only ⇒ low.
  const confidence: ValuationConfidence = basis.includes("realized")
    ? "high"
    : basis.includes("value_index")
    ? "medium"
    : "low";

  // Band: prefer the Value Index range (scaled to the estimate/median ratio so the
  // spread rides with our blended estimate); else widen by confidence.
  let lowCents: number;
  let highCents: number;
  if (
    inputs.fairValueLowCents != null && inputs.fairValueHighCents != null &&
    inputs.fairValueMedianCents != null && inputs.fairValueMedianCents > 0
  ) {
    const ratio = estimate / inputs.fairValueMedianCents;
    lowCents = round(inputs.fairValueLowCents * ratio);
    highCents = round(inputs.fairValueHighCents * ratio);
  } else {
    const spread = confidence === "high" ? 0.15 : confidence === "medium" ? 0.25 : 0.4;
    lowCents = round(estimate * (1 - spread));
    highCents = round(estimate * (1 + spread));
  }

  // Coarse trend vs what the buyer paid (undepreciated cost basis).
  let trend: ValuationTrend = "unknown";
  if (inputs.costBasisCents != null && inputs.costBasisCents > 0) {
    const delta = (estimate - inputs.costBasisCents) / inputs.costBasisCents;
    trend = delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat";
  }

  return { estimateCents: estimate, lowCents, highCents, confidence, basis, trend };
}

// ── portfolio aggregation (pure) ────────────────────────────────────────────

export interface PortfolioItemValue {
  estimateCents: number | null;
  costBasisCents: number | null;
}

export interface PortfolioTotals {
  totalEstimateCents: number;
  costBasisCents: number;
  /** Unrealized gain/loss = total estimate − cost basis (over items that have BOTH). */
  unrealizedGainCents: number;
  itemsValued: number;
  itemsUnvalued: number;
}

/**
 * Roll item valuations into portfolio totals. Gain/loss is computed only over
 * items that have BOTH an estimate and a cost basis, so an unknown cost basis
 * doesn't masquerade as a loss. PURE.
 */
export function computePortfolioTotals(items: PortfolioItemValue[]): PortfolioTotals {
  let totalEstimate = 0;
  let costBasis = 0;
  let gainBasis = 0;
  let gainEstimate = 0;
  let valued = 0;
  let unvalued = 0;

  for (const it of items) {
    if (it.estimateCents != null) {
      totalEstimate += it.estimateCents;
      valued++;
      if (it.costBasisCents != null) {
        gainEstimate += it.estimateCents;
        gainBasis += it.costBasisCents;
      }
    } else {
      unvalued++;
    }
    if (it.costBasisCents != null) costBasis += it.costBasisCents;
  }

  return {
    totalEstimateCents: totalEstimate,
    costBasisCents: costBasis,
    unrealizedGainCents: gainEstimate - gainBasis,
    itemsValued: valued,
    itemsUnvalued: unvalued,
  };
}

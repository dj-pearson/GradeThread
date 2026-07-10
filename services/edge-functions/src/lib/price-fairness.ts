// US-1835: condition-adjusted price-fairness meter (PURE, unit-tested).
//
// Given a listing's price and the CONDITION-NORMALIZED fair-value band (the
// Value Index range at the item's OBJECTIVE grade — the differentiator no
// marketplace price filter offers), say where the price falls: below the band
// (a deal), inside it (fair), or above it (overpriced). No band or no price →
// 'unknown' — never a fabricated verdict when comps are thin.

export interface FairBand {
  lowCents: number;
  medianCents: number;
  highCents: number;
}

export type FairnessVerdict = "low" | "fair" | "high" | "unknown";

export interface PriceFairness {
  verdict: FairnessVerdict;
  priceCents: number | null;
  /** Signed % the price sits above/below the band MEDIAN (null when unknown). */
  deltaPct: number | null;
}

/**
 * Classify a listing price against the condition-normalized fair band. PURE.
 * price < low → 'low' (a buyer's deal); price > high → 'high' (overpriced);
 * inside the band → 'fair'. An absent price or band → 'unknown'.
 */
export function priceFairness(
  priceCents: number | null | undefined,
  band: FairBand | null | undefined,
): PriceFairness {
  if (
    priceCents == null || !Number.isFinite(priceCents) || priceCents < 0 ||
    !band || band.medianCents <= 0
  ) {
    return { verdict: "unknown", priceCents: priceCents ?? null, deltaPct: null };
  }
  const price = Math.round(priceCents);
  const deltaPct = Math.round(((price - band.medianCents) / band.medianCents) * 100);
  const verdict: FairnessVerdict = price < band.lowCents ? "low" : price > band.highCents ? "high" : "fair";
  return { verdict, priceCents: price, deltaPct };
}

/** Parse a price from a raw listing value (number of cents, dollars string like
 *  "$59.99", or a bare number of dollars). Returns cents or null. PURE. */
export function parsePriceCents(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    // A whole-number heuristic: values ≥ 1000 with no fraction are already cents
    // only when flagged by the caller; here we treat a bare number as DOLLARS.
    return Math.round(raw * 100);
  }
  if (typeof raw !== "string") return null;
  const m = raw.replace(/[, ]/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const dollars = parseFloat(m[1]!);
  return Number.isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 100) : null;
}

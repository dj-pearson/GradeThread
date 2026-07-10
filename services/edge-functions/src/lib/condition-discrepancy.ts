// US-1834: claimed-vs-objective condition discrepancy (the extension's killer
// signal). PURE (unit-tested). Maps a seller's CLAIMED condition — an eBay
// conditionId or a free-text label from any marketplace — to an equivalent
// GradeThread grade, then scores it against our OBJECTIVE grade so a buyer sees
// when a listing is over-graded. Degrades gracefully: an absent/unrecognized
// condition yields null (→ 'unknown'), never a fabricated match.
//
// Consistent with repricing.gradeToConditionId (the forward grade→conditionId
// map): this is its inverse, at the finer 2025 pre-loved-apparel granularity.

// eBay conditionId → representative grade (mid of the tier's band).
const EBAY_CONDITION_GRADE: Record<string, number> = {
  "1000": 10, // New with tags
  "1500": 9, // New without tags / New other
  "1750": 8, // New with defects
  "2750": 8, // Pre-owned - Excellent (2025 apparel) / Like new
  "2500": 8, // Seller refurbished
  "3000": 6, // Used / Pre-owned - Good
  "4000": 6, // Very Good Refurbished
  "5000": 4.5, // Pre-owned - Fair
  "6000": 4.5, // Acceptable
  "7000": 2, // For parts / not working
};

// Normalized free-text label → representative grade (Poshmark/Depop/Mercari/etc).
const LABEL_GRADE: Array<[RegExp, number]> = [
  [/new with tags|nwt\b|brand ?new|bnwt/, 10],
  [/new without tags|nwot\b|new other/, 9],
  [/new with defects/, 8],
  [/like new|excellent|mint|pristine/, 8],
  [/very good|great condition|gently used/, 7],
  [/\bgood\b|pre-?owned|used|worn/, 6],
  [/\bfair\b|acceptable|some wear|well.?loved/, 4.5],
  [/\bpoor\b|for parts|not working|damaged|as.?is/, 2],
];

/**
 * Map a claimed condition (eBay numeric conditionId OR a free-text label) to an
 * equivalent GradeThread grade. Returns null when the condition is absent or
 * unrecognized (graceful degrade — the caller signals 'unknown', never a match).
 * `marketplace` is accepted for future per-market nuance; today the id/text
 * heuristics cover eBay + the text marketplaces.
 */
export function claimedConditionToGrade(
  condition: string | number | null | undefined,
  _marketplace?: string | null,
): number | null {
  if (condition == null) return null;
  const s = String(condition).trim().toLowerCase();
  if (!s) return null;

  // A bare numeric string is an eBay conditionId.
  if (/^\d{3,4}$/.test(s) && EBAY_CONDITION_GRADE[s] != null) return EBAY_CONDITION_GRADE[s];

  for (const [re, grade] of LABEL_GRADE) {
    if (re.test(s)) return grade;
  }
  return null;
}

export type DiscrepancySignal = "match" | "mild_gap" | "over_graded" | "unknown";

export interface DiscrepancyResult {
  signal: DiscrepancySignal;
  /** claimedGrade − objectiveGrade; positive = seller claims BETTER than reality. */
  delta: number | null;
  claimedGrade: number | null;
  objectiveGrade: number;
}

/**
 * Score the gap between what the seller CLAIMED and what the photos objectively
 * support. PURE. A claim ≥2 grade points above the objective grade is
 * 'over_graded'; ≥1 is a 'mild_gap'; otherwise 'match'. An unknown/absent claim
 * is 'unknown' (we never assert a match we can't back). Only the seller claiming
 * BETTER than reality raises a flag — under-claiming is a buyer's gain, not a risk.
 */
export function scoreDiscrepancy(objectiveGrade: number, claimedGrade: number | null): DiscrepancyResult {
  if (claimedGrade == null) {
    return { signal: "unknown", delta: null, claimedGrade: null, objectiveGrade };
  }
  const delta = Math.round((claimedGrade - objectiveGrade) * 10) / 10;
  const signal: DiscrepancySignal = delta >= 2 ? "over_graded" : delta >= 1 ? "mild_gap" : "match";
  return { signal, delta, claimedGrade, objectiveGrade };
}

// Inter-rater reliability math (US-334).
//
// Computes the human-vs-human agreement baseline from a blind multi-rater study
// — the denominator that makes the AI's accuracy numbers meaningful ("how good
// is good?"). All functions here are PURE and deterministic so the reliability
// math can be unit-tested independent of the DB/admin layers.
//
// Inputs are a rating matrix: one row per graded item, each row a list of the
// scores that item received (one per reviewer who graded it). Missing ratings
// are simply absent from a row's list, so rows may have different lengths — the
// study is "incomplete-friendly", which is why we use Krippendorff's alpha
// (interval metric) for the reliability coefficient: it handles ≥2 raters and
// missing data, unlike a naive ICC that needs a fully-crossed matrix.

export interface ItemRatings {
  item_id: string;
  // One score per reviewer who rated this item (1.0–10.0). Length ≥ 0.
  scores: number[];
}

export interface AgreementStats {
  // Proportion of co-rated reviewer PAIRS whose scores differ by ≤ tolerance.
  agreement_within: number;
  // Mean absolute error between co-rated reviewer pairs.
  mae: number;
  // Number of co-rated pairs the stats are based on.
  pair_count: number;
  tolerance: number;
}

export interface AiVsHumanComparison {
  // AI vs the human consensus (per-item mean of human scores).
  ai_agreement_within: number;
  ai_mae: number;
  // The human-vs-human baseline (same tolerance) for side-by-side comparison.
  human_agreement_within: number;
  human_mae: number;
  // True when the AI agrees with the human consensus at least as often as two
  // humans agree with each other — the headline "AI meets/beats expert" claim.
  ai_meets_human: boolean;
  item_count: number;
}

export interface IrrReport {
  item_count: number;
  // Items with ≥ 2 ratings — the only ones that inform reliability.
  pairable_item_count: number;
  rater_count: number;
  human: AgreementStats;
  // Krippendorff's alpha (interval). 1 = perfect, 0 = chance, <0 = systematic
  // disagreement. null when it can't be computed (no variance / no pairs).
  krippendorff_alpha: number | null;
  // Present only when AI scores were supplied AND there is a human baseline.
  ai_vs_human: AiVsHumanComparison | null;
  // True when the sample is large enough to cite publicly (US-334 AC #4).
  sufficient_sample: boolean;
}

export const DEFAULT_TOLERANCE = 0.5;
// Minimum pairable items before the baseline is "citable" on the public report.
export const MIN_CITABLE_ITEMS = 30;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Pairwise agreement-within-tolerance + MAE across every within-item reviewer
// pair. This is the human-vs-human baseline.
export function pairwiseAgreement(
  items: ItemRatings[],
  tolerance: number = DEFAULT_TOLERANCE,
): AgreementStats {
  let within = 0;
  let absErrSum = 0;
  let pairs = 0;
  for (const { scores } of items) {
    for (let i = 0; i < scores.length; i++) {
      for (let j = i + 1; j < scores.length; j++) {
        const diff = Math.abs(scores[i]! - scores[j]!);
        if (diff <= tolerance) within++;
        absErrSum += diff;
        pairs++;
      }
    }
  }
  return {
    agreement_within: pairs === 0 ? 0 : within / pairs,
    mae: pairs === 0 ? 0 : absErrSum / pairs,
    pair_count: pairs,
    tolerance,
  };
}

// Krippendorff's alpha for interval data: α = 1 − Do/De.
//   Do (observed disagreement): within-unit pair squared differences, each
//      unit's pairs weighted by 1/(m_u−1) so units with more raters don't
//      dominate; normalized by n = total ratings in pairable units.
//   De (expected disagreement): mean squared difference over all ordered pairs
//      of the pooled values from pairable units.
// Returns null when De = 0 (no variance) and Do = 0 (perfect, but undefined
// ratio) only if there is literally nothing to compare.
export function krippendorffAlphaInterval(items: ItemRatings[]): number | null {
  const pairable = items.filter((it) => it.scores.length >= 2);
  if (pairable.length === 0) return null;

  const n = pairable.reduce((acc, it) => acc + it.scores.length, 0);
  if (n < 2) return null;

  // Observed disagreement.
  let doSum = 0;
  for (const { scores } of pairable) {
    const m = scores.length;
    const w = 1 / (m - 1);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i === j) continue;
        const d = scores[i]! - scores[j]!;
        doSum += w * d * d;
      }
    }
  }
  const Do = doSum / n;

  // Expected disagreement over the pooled bag of values.
  const pool: number[] = [];
  for (const { scores } of pairable) pool.push(...scores);
  // Σ_{a,b}(va−vb)² = 2N·Σv² − 2(Σv)²; ordered distinct pairs = same (a=b adds 0).
  const N = pool.length;
  const sum = pool.reduce((a, b) => a + b, 0);
  const sumSq = pool.reduce((a, b) => a + b * b, 0);
  const totalSqDiff = 2 * N * sumSq - 2 * sum * sum;
  const De = totalSqDiff / (N * (N - 1));

  if (De === 0) return Do === 0 ? 1 : 0;
  return 1 - Do / De;
}

// Per-item human consensus = mean of that item's human scores.
export function consensusScores(items: ItemRatings[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    if (it.scores.length > 0) m.set(it.item_id, mean(it.scores));
  }
  return m;
}

// Compare AI scores against the human consensus, alongside the human baseline.
// `aiScores` maps item_id -> the AI's overall score for that item.
export function compareAiToHumans(
  items: ItemRatings[],
  aiScores: Map<string, number>,
  tolerance: number = DEFAULT_TOLERANCE,
): AiVsHumanComparison | null {
  const consensus = consensusScores(items);
  // Items that have BOTH a human consensus and an AI score.
  let within = 0;
  let absErrSum = 0;
  let count = 0;
  for (const [itemId, c] of consensus) {
    const ai = aiScores.get(itemId);
    if (ai === undefined) continue;
    const diff = Math.abs(ai - c);
    if (diff <= tolerance) within++;
    absErrSum += diff;
    count++;
  }
  if (count === 0) return null;

  const human = pairwiseAgreement(items, tolerance);
  const aiAgreement = within / count;
  return {
    ai_agreement_within: aiAgreement,
    ai_mae: absErrSum / count,
    human_agreement_within: human.agreement_within,
    human_mae: human.mae,
    ai_meets_human: aiAgreement >= human.agreement_within,
    item_count: count,
  };
}

// Top-level: assemble the full IRR report from a study's rating matrix and an
// optional AI-score lookup.
export function computeIrrReport(
  items: ItemRatings[],
  aiScores?: Map<string, number>,
  tolerance: number = DEFAULT_TOLERANCE,
): IrrReport {
  const pairable = items.filter((it) => it.scores.length >= 2);
  const raterCount = items.reduce(
    (max, it) => Math.max(max, it.scores.length),
    0,
  );
  return {
    item_count: items.length,
    pairable_item_count: pairable.length,
    rater_count: raterCount,
    human: pairwiseAgreement(items, tolerance),
    krippendorff_alpha: krippendorffAlphaInterval(items),
    ai_vs_human: aiScores
      ? compareAiToHumans(items, aiScores, tolerance)
      : null,
    sufficient_sample: pairable.length >= MIN_CITABLE_ITEMS,
  };
}

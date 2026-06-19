// US-944: Per-step A/B optimizer + conversion self-tuning for the trial drip.
//
// PURE module: no supabase / network / env imports (mirrors drip-graph.ts), so
// it unit-tests directly (drip-optimizer_test.ts) and the future engine tick can
// call it cheaply. It turns the recorded outcomes on the send/attribution ledger
// (drip_sends + drip_attributions, migration 00253) into new per-variant weights
// that shift toward the higher-CONVERTING variant — with an exploration floor so
// losers keep getting a trickle, and an auto-retire for high-unsub variants.
//
// Reuses the US-927/928 closed-loop pattern (epsilon-greedy weight shift toward
// the winner with a fixed exploration floor); winner selection optimizes for the
// real goal (conversion) with click as the secondary tiebreak, never opens.

import type { DripGraph, DripStep, DripVariant } from "./drip-graph.ts";

// ── Per-variant recorded outcomes (the engine's send ledger, aggregated) ──

export interface VariantStats {
  variantId: string;
  sent: number;
  opened: number;
  clicked: number;
  /** Enrollments that received this (step,variant) and later converted. */
  converted: number;
  unsubscribed: number;
}

export interface OptimizerConfig {
  /** Per-variant minimum sends before its rate is trusted for winner pick. */
  minSample: number;
  /** Fraction (0–1) of weight always reserved for exploration across arms. */
  explorationFloor: number;
  /** Unsub rate above which a sufficiently-sampled variant is retired (→ 0). */
  unsubRetireRate: number;
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  minSample: 30,
  explorationFloor: 0.1,
  unsubRetireRate: 0.02,
};

function clampConfig(over?: Partial<OptimizerConfig>): OptimizerConfig {
  const c = { ...DEFAULT_OPTIMIZER_CONFIG, ...(over ?? {}) };
  return {
    minSample: Math.max(1, Math.floor(c.minSample)),
    explorationFloor: Math.min(0.9, Math.max(0, c.explorationFloor)),
    unsubRetireRate: Math.min(1, Math.max(0, c.unsubRetireRate)),
  };
}

// ── Per-variant scored verdict ──

export interface VariantScore {
  variantId: string;
  sent: number;
  openRate: number;
  clickRate: number;
  conversionRate: number;
  unsubRate: number;
  /** Has enough data (sent ≥ minSample) for its rates to count. */
  trusted: boolean;
  /** Retired (high unsub, enough data) — gets zero weight. */
  retired: boolean;
  /** The chosen winner (best conversion among trusted, non-retired arms). */
  isWinner: boolean;
  /** Recommended new weight (0–100, integers summing to ~100 per step). */
  weight: number;
}

function rate(numer: number, denom: number): number {
  return denom > 0 ? numer / denom : 0;
}

/** Score a variant's recorded outcomes into rates (no weight yet). */
export function scoreVariant(stats: VariantStats): Omit<VariantScore, "retired" | "isWinner" | "weight" | "trusted"> {
  const sent = Math.max(0, stats.sent);
  return {
    variantId: stats.variantId,
    sent,
    openRate: rate(stats.opened, sent),
    clickRate: rate(stats.clicked, sent),
    conversionRate: rate(stats.converted, sent),
    unsubRate: rate(stats.unsubscribed, sent),
  };
}

/**
 * Pick the winning variant id: highest conversion rate, click rate as the
 * secondary tiebreak, then sent volume. Only variants with sent ≥ minSample are
 * eligible — below threshold there is NO winner (returns null) so callers fall
 * back to the default (uniform exploration), avoiding spurious small-cohort
 * winners. Retired variants are never winners.
 */
export function selectWinner(
  stats: VariantStats[],
  config?: Partial<OptimizerConfig>,
  retiredIds?: Set<string>,
): string | null {
  const cfg = clampConfig(config);
  const eligible = stats
    .filter((s) => s.sent >= cfg.minSample && !(retiredIds?.has(s.variantId)))
    .map(scoreVariant);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) =>
    b.conversionRate - a.conversionRate ||
    b.clickRate - a.clickRate ||
    b.sent - a.sent ||
    a.variantId.localeCompare(b.variantId)
  );
  return eligible[0]!.variantId;
}

// ── Weight re-tuning (the closed loop) ──

/** Round a weight vector to integers that sum to exactly `total` (default 100). */
function roundToTotal(weights: Map<string, number>, total = 100): Map<string, number> {
  const ids = [...weights.keys()];
  const raw = ids.map((id) => ({ id, w: Math.max(0, weights.get(id) ?? 0) }));
  const sum = raw.reduce((s, r) => s + r.w, 0);
  if (sum <= 0) {
    // Degenerate: spread evenly.
    const each = Math.floor(total / Math.max(1, ids.length));
    const out = new Map(ids.map((id) => [id, each]));
    let rem = total - each * ids.length;
    for (const id of ids) {
      if (rem <= 0) break;
      out.set(id, (out.get(id) ?? 0) + 1);
      rem--;
    }
    return out;
  }
  const scaled = raw.map((r) => ({ id: r.id, exact: (r.w / sum) * total }));
  const out = new Map(scaled.map((s) => [s.id, Math.floor(s.exact)]));
  let rem = total - [...out.values()].reduce((s, v) => s + v, 0);
  // Hand out the remainder to the largest fractional parts.
  scaled
    .map((s) => ({ id: s.id, frac: s.exact - Math.floor(s.exact) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach((s) => {
      if (rem <= 0) return;
      out.set(s.id, (out.get(s.id) ?? 0) + 1);
      rem--;
    });
  return out;
}

export interface StepOptimization {
  totalSent: number;
  /** True once a trusted winner exists; below threshold we keep exploring. */
  hasEnoughData: boolean;
  winnerId: string | null;
  scores: VariantScore[];
  /** variantId → recommended weight (integers, sum 100). */
  recommendedWeights: Record<string, number>;
}

/**
 * Re-tune weights from recorded outcomes (epsilon-greedy):
 *  1. Retire any variant with enough data whose unsub rate exceeds the cap
 *     (weight 0) — but never retire the last surviving arm.
 *  2. If a trusted winner exists among survivors, give it (1−floor) of the
 *     weight and split the `floor` evenly across ALL survivors so every arm
 *     keeps a non-zero exploration trickle.
 *  3. Below the sample threshold there is no winner → uniform weights so the
 *     test keeps gathering data (no premature convergence).
 */
export function optimizeStep(
  variantIds: string[],
  statsByVariant: Record<string, VariantStats>,
  config?: Partial<OptimizerConfig>,
): StepOptimization {
  const cfg = clampConfig(config);
  const ids = [...new Set(variantIds)];
  const stats: VariantStats[] = ids.map((id) =>
    statsByVariant[id] ?? { variantId: id, sent: 0, opened: 0, clicked: 0, converted: 0, unsubscribed: 0 }
  );
  const scoreMap = new Map(stats.map((s) => [s.variantId, scoreVariant(s)]));
  const totalSent = stats.reduce((s, v) => s + Math.max(0, v.sent), 0);

  // Step 1 — retire high-unsub arms (with enough data), but keep ≥1 alive.
  const retired = new Set<string>();
  for (const s of stats) {
    const sc = scoreMap.get(s.variantId)!;
    if (s.sent >= cfg.minSample && sc.unsubRate > cfg.unsubRetireRate) {
      retired.add(s.variantId);
    }
  }
  if (retired.size >= ids.length && ids.length > 0) {
    // Everything would be retired — keep the lowest-unsub arm alive.
    const keep = [...stats].sort((a, b) =>
      (scoreMap.get(a.variantId)!.unsubRate - scoreMap.get(b.variantId)!.unsubRate) ||
      a.variantId.localeCompare(b.variantId)
    )[0]!;
    retired.delete(keep.variantId);
  }

  const survivors = ids.filter((id) => !retired.has(id));
  const winnerId = selectWinner(stats, cfg, retired);

  // Step 2/3 — allocate weights.
  const weights = new Map<string, number>(ids.map((id) => [id, 0]));
  if (survivors.length > 0) {
    if (winnerId && survivors.length > 1) {
      const floorEach = (cfg.explorationFloor * 100) / survivors.length;
      for (const id of survivors) {
        weights.set(id, floorEach + (id === winnerId ? (1 - cfg.explorationFloor) * 100 : 0));
      }
    } else {
      // No trusted winner (or a single survivor) → uniform exploration.
      const each = 100 / survivors.length;
      for (const id of survivors) weights.set(id, each);
    }
  }
  const rounded = roundToTotal(weights, 100);

  const scores: VariantScore[] = ids.map((id) => {
    const sc = scoreMap.get(id)!;
    return {
      ...sc,
      trusted: sc.sent >= cfg.minSample,
      retired: retired.has(id),
      isWinner: id === winnerId,
      weight: rounded.get(id) ?? 0,
    };
  });

  return {
    totalSent,
    hasEnoughData: winnerId !== null,
    winnerId,
    scores,
    recommendedWeights: Object.fromEntries(ids.map((id) => [id, rounded.get(id) ?? 0])),
  };
}

// ── Graph-level optimization ──

export interface GraphStepOptimization extends StepOptimization {
  stepId: string;
  label: string;
  /** ordinal (1-based) — matches drip_sends.step. */
  ordinal: number;
  /** Whether the recommended weights differ from the step's current weights. */
  changed: boolean;
}

/**
 * Optimize every step of a graph against per-ordinal stats. `statsByOrdinal`
 * maps the 1-based step ordinal (drip_sends.step) → variantId → stats. Steps
 * with a single variant are reported but never changed (no A/B to tune).
 */
export function optimizeGraph(
  graph: DripGraph,
  statsByOrdinal: Record<number, Record<string, VariantStats>>,
  config?: Partial<OptimizerConfig>,
): GraphStepOptimization[] {
  return graph.steps.map((step, i) => {
    const ordinal = i + 1;
    const variantIds = step.variants.map((v) => v.id);
    const opt = optimizeStep(variantIds, statsByOrdinal[ordinal] ?? {}, config);
    const changed = step.variants.some(
      (v) => (opt.recommendedWeights[v.id] ?? 0) !== v.weight,
    ) && step.variants.length > 1;
    return { stepId: step.id, label: step.label, ordinal, changed, ...opt };
  });
}

/**
 * Return a NEW graph with each multi-variant step's weights replaced by the
 * recommended weights. Single-variant steps are left untouched. Pure — does not
 * mutate the input. This is the autonomous "apply" the engine/admin runs.
 */
export function applyOptimizationToGraph(
  graph: DripGraph,
  optimizations: GraphStepOptimization[],
): DripGraph {
  const byStepId = new Map(optimizations.map((o) => [o.stepId, o]));
  return {
    ...graph,
    steps: graph.steps.map((step) => {
      const opt = byStepId.get(step.id);
      if (!opt || step.variants.length <= 1) return step;
      const variants: DripVariant[] = step.variants.map((v) => ({
        ...v,
        weight: opt.recommendedWeights[v.id] ?? v.weight,
      }));
      return { ...step, variants } satisfies DripStep;
    }),
  };
}

// US-927: Subject-line A/B testing for the autonomous newsletter — PURE module.
//
// No supabase / env / network imports (mirrors newsletter-tuning.ts) so the
// holdout planning, deterministic variant assignment, per-variant aggregation,
// and winner selection all unit-test directly and the send route + finalize job +
// console share ONE source of truth.
//
// Flow the consumers wire:
//   1. An issue carries 2-3 subject VARIANTS (produced by the copywriter).
//   2. The sender sends a configurable TEST fraction across the variants (the
//      A/B holdout), recording each recipient's variant.
//   3. After a measurement window it aggregates open/click PER VARIANT, selects
//      the winner (by open, or click for CTA tests) — requiring a minimum sample
//      per variant or falling back to the default (first) variant — and sends the
//      winning subject to the remainder.

// ── Subject variants ──────────────────────────────────────────────────────────

export interface SubjectVariant {
  /** Stable id (e.g. 'a', 'b', 'c') used to record assignment + roll up engagement. */
  id: string;
  /** The subject line copy this variant sends. */
  subject: string;
  /** Optional human label for the console. */
  label?: string;
}

/** Hard cap on variants per issue — A/B/C is the practical ceiling for a test. */
export const MAX_SUBJECT_VARIANTS = 3;

const VARIANT_IDS = ["a", "b", "c", "d", "e"];

/**
 * Normalize a raw `subject_variants` blob into a clean, de-duplicated, ordered
 * variant list (≤ MAX_SUBJECT_VARIANTS). Each kept variant must have non-empty
 * subject copy; ids are re-assigned to the stable a/b/c sequence so downstream
 * aggregation keys are predictable. When no usable variant exists but a primary
 * `fallbackSubject` is supplied, returns a single variant so the issue still
 * sends (just without an A/B test).
 */
export function normalizeVariants(
  raw: unknown,
  fallbackSubject?: string | null,
): SubjectVariant[] {
  const out: SubjectVariant[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (out.length >= MAX_SUBJECT_VARIANTS) break;
      const e = entry as { subject?: unknown; label?: unknown } | null;
      const subject = typeof e?.subject === "string" ? e.subject.trim() : "";
      if (!subject) continue;
      const dedupeKey = subject.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const variant: SubjectVariant = { id: VARIANT_IDS[out.length]!, subject };
      if (typeof e?.label === "string" && e.label.trim()) variant.label = e.label.trim();
      out.push(variant);
    }
  }
  if (out.length === 0) {
    const subject = (fallbackSubject ?? "").trim();
    if (subject) return [{ id: "a", subject }];
    return [];
  }
  return out;
}

/** An A/B test runs only when there are ≥ 2 distinct subject variants. */
export function hasAbTest(variants: SubjectVariant[]): boolean {
  return variants.length >= 2;
}

export function variantById(variants: SubjectVariant[], id: string | null | undefined): SubjectVariant | null {
  if (!id) return null;
  return variants.find((v) => v.id === id) ?? null;
}

// ── Deterministic assignment ──────────────────────────────────────────────────
// FNV-1a over the recipient key → a variant index. Deterministic so a re-run of
// the test phase assigns the same recipient the same variant (idempotent), and
// roughly balanced across variants for a large list.

function fnv1a(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function assignVariant(variants: SubjectVariant[], key: string): SubjectVariant {
  if (variants.length === 0) throw new Error("assignVariant: no variants");
  return variants[fnv1a(key) % variants.length]!;
}

// ── Holdout planning ──────────────────────────────────────────────────────────

export interface HoldoutPlan {
  /** Recipients sent during the test phase (split across variants). */
  holdoutSize: number;
  /** Recipients reserved for the winning subject after measurement. */
  remainderSize: number;
}

/**
 * Split a resolved list into the A/B test holdout + the remainder. The holdout is
 * `round(total * fraction)`, clamped so a test always has room for the remainder
 * to receive a meaningfully-different winner: if `fraction` would consume the
 * whole list we still send the test, but a degenerate (≤1 recipient) list yields
 * a zero holdout so the caller falls back to a plain single send.
 */
export function planHoldout(total: number, fraction: number): HoldoutPlan {
  const t = Math.max(0, Math.floor(total));
  if (t < 2) return { holdoutSize: 0, remainderSize: t };
  const f = Math.min(1, Math.max(0, fraction));
  let holdout = Math.round(t * f);
  // Keep at least 1 in the holdout (so there IS a test) and at least 1 in the
  // remainder (so the winner has someone to go to) when the list allows it.
  holdout = Math.min(t - 1, Math.max(1, holdout));
  return { holdoutSize: holdout, remainderSize: t - holdout };
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface AbConfig {
  enabled: boolean;
  /** Fraction (0–1) of the list used as the test holdout. */
  testFraction: number;
  /** Hours to measure engagement before selecting + sending the winner. */
  measurementHours: number;
  /** Min sends per variant before its rate is trusted (else fall back to default). */
  minSample: number;
}

export const DEFAULT_AB_CONFIG: AbConfig = {
  enabled: true,
  testFraction: 0.2,
  measurementHours: 4,
  minSample: 50,
};

export function clampAbConfig(over?: Partial<AbConfig>): AbConfig {
  const c = { ...DEFAULT_AB_CONFIG, ...(over ?? {}) };
  return {
    enabled: Boolean(c.enabled),
    testFraction: Math.min(0.9, Math.max(0.01, Number.isFinite(c.testFraction) ? c.testFraction : 0.2)),
    measurementHours: Math.max(0, Number.isFinite(c.measurementHours) ? Math.floor(c.measurementHours) : 4),
    minSample: Math.max(1, Number.isFinite(c.minSample) ? Math.floor(c.minSample) : 50),
  };
}

// ── Per-variant engagement + winner selection ─────────────────────────────────

export type AbMetric = "open" | "click";

export interface VariantStat {
  variantId: string;
  sent: number;
  opened: number;
  clicked: number;
}

export function emptyVariantStat(variantId: string): VariantStat {
  return { variantId, sent: 0, opened: 0, clicked: 0 };
}

/** Engagement signals for a single holdout ledger row. */
export interface RecipientSignals {
  variant: string | null;
  opened: boolean;
  clicked: boolean;
}

/**
 * Fold holdout recipient rows into per-variant counts. Only rows whose `variant`
 * matches one of the issue's variants are counted (stale/foreign ids ignored). A
 * click implies an open (matches the tuning job's convention).
 */
export function aggregateVariantStats(
  variants: SubjectVariant[],
  rows: RecipientSignals[],
): VariantStat[] {
  const byId = new Map<string, VariantStat>(variants.map((v) => [v.id, emptyVariantStat(v.id)]));
  for (const r of rows) {
    if (!r.variant) continue;
    const stat = byId.get(r.variant);
    if (!stat) continue;
    stat.sent += 1;
    if (r.opened || r.clicked) stat.opened += 1;
    if (r.clicked) stat.clicked += 1;
  }
  return variants.map((v) => byId.get(v.id)!);
}

export type WinnerSource = "auto" | "fallback";

export interface WinnerResult {
  winnerId: string;
  source: WinnerSource;
  metric: AbMetric;
  /** Winning variant's measured rate (0–1) — 0 when it fell back. */
  rate: number;
  /** A trusted winner (≥ minSample on the best variant) was found. */
  trusted: boolean;
  /** Per-variant rate scores (for transparency / the console). */
  scores: Array<{ variantId: string; sent: number; rate: number; trusted: boolean }>;
}

function metricRate(stat: VariantStat, metric: AbMetric): number {
  if (stat.sent <= 0) return 0;
  return (metric === "click" ? stat.clicked : stat.opened) / stat.sent;
}

/**
 * Select the winning variant from measured holdout engagement.
 *  • Winner = the highest `metric` rate among variants with `sent ≥ minSample`,
 *    tie-broken by larger sample then variant id (deterministic).
 *  • If NO variant reached the minimum sample, fall back to the default variant
 *    (`fallbackVariantId`, else the first variant) — no spurious winners on a
 *    tiny list. `source` reports which path was taken.
 */
export function selectAbWinner(
  variants: SubjectVariant[],
  stats: VariantStat[],
  opts: { metric: AbMetric; minSample: number; fallbackVariantId?: string | null },
): WinnerResult {
  if (variants.length === 0) throw new Error("selectAbWinner: no variants");
  const metric = opts.metric;
  const minSample = Math.max(1, opts.minSample);
  const statById = new Map(stats.map((s) => [s.variantId, s]));

  const scores = variants.map((v) => {
    const stat = statById.get(v.id) ?? emptyVariantStat(v.id);
    return {
      variantId: v.id,
      sent: stat.sent,
      rate: metricRate(stat, metric),
      trusted: stat.sent >= minSample,
    };
  });

  const eligible = scores.filter((s) => s.trusted);
  eligible.sort((a, b) =>
    b.rate - a.rate || b.sent - a.sent || a.variantId.localeCompare(b.variantId)
  );

  if (eligible.length > 0) {
    const best = eligible[0]!;
    return { winnerId: best.variantId, source: "auto", metric, rate: best.rate, trusted: true, scores };
  }

  const fallbackId =
    (opts.fallbackVariantId && variants.some((v) => v.id === opts.fallbackVariantId)
      ? opts.fallbackVariantId
      : variants[0]!.id);
  return { winnerId: fallbackId, source: "fallback", metric, rate: 0, trusted: false, scores };
}

// ── Measurement window ────────────────────────────────────────────────────────

/** Has the measurement window elapsed since the test started? Pure given `nowMs`. */
export function isMeasurementWindowElapsed(
  testStartedAtIso: string | null,
  measurementHours: number,
  nowMs: number,
): boolean {
  if (!testStartedAtIso) return false;
  const started = Date.parse(testStartedAtIso);
  if (!Number.isFinite(started)) return false;
  return nowMs - started >= Math.max(0, measurementHours) * 60 * 60 * 1000;
}

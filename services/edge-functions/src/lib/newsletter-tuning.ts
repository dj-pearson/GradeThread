// US-928: Closed-loop self-tuning for the autonomous newsletter — PURE module.
//
// No supabase / env / network imports (mirrors drip-optimizer.ts) so it unit-tests
// directly (newsletter-tuning_test.ts) and the analysis job + admin console +
// assembler all share ONE source of truth. It turns recorded per-issue engagement
// (open / click / unsubscribe on the newsletter_issue_recipients ledger, attributed
// to each issue's topic / subject style / send hour) into weights that bias the
// next issue toward what engages — with two guardrails against runaway narrowing:
//   • an EXPLORATION FLOOR so under-tested topics still get airtime, and
//   • an UNSUB CEILING that PAUSES a topic (weight 0) once it earns enough unsubs.
//
// Engagement, not conversion, is the goal here: the winner optimizes CTR first,
// open rate as the secondary tiebreak (a newsletter's job is clicks-through).

// ── Per-dimension recorded outcomes (the issue ledger, aggregated) ──

export interface EngagementCount {
  sent: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
}

export function emptyCount(): EngagementCount {
  return { sent: 0, opened: 0, clicked: 0, unsubscribed: 0 };
}

export interface TuningConfig {
  /** Min sends before a dimension's rates are trusted for winner selection. */
  minSample: number;
  /** Fraction (0–1) of weight always reserved across survivors (exploration). */
  explorationFloor: number;
  /** Unsub rate above which a sufficiently-sampled dimension is paused (→ 0). */
  unsubCeiling: number;
}

export const DEFAULT_TUNING_CONFIG: TuningConfig = {
  minSample: 50,
  explorationFloor: 0.15,
  unsubCeiling: 0.005,
};

export function clampTuningConfig(over?: Partial<TuningConfig>): TuningConfig {
  const c = { ...DEFAULT_TUNING_CONFIG, ...(over ?? {}) };
  return {
    minSample: Math.max(1, Math.floor(c.minSample)),
    explorationFloor: Math.min(0.9, Math.max(0, c.explorationFloor)),
    unsubCeiling: Math.min(1, Math.max(0, c.unsubCeiling)),
  };
}

function rate(numer: number, denom: number): number {
  return denom > 0 ? numer / denom : 0;
}

// ── Topic + subject-style catalog ──
// The dimensions the assembler selects among. Each topic is a (pillar, angle)
// pair keyed by a stable id; engagement is attributed to that id. New entries are
// additive — an unknown id read back from old issues is simply ignored.

export interface NewsletterTopic {
  id: string;
  pillar: string;
  angle: string;
  label: string;
}

export const NEWSLETTER_TOPICS: NewsletterTopic[] = [
  { id: "grading-basics", pillar: "grading", angle: "education", label: "How condition grading works" },
  { id: "grading-pitfalls", pillar: "grading", angle: "mistakes", label: "Common grading mistakes to avoid" },
  { id: "reselling-pricing", pillar: "reselling", angle: "pricing", label: "Pricing pre-owned clothing right" },
  { id: "reselling-sourcing", pillar: "reselling", angle: "sourcing", label: "Sourcing inventory that sells" },
  { id: "market-trends", pillar: "market", angle: "trends", label: "What's selling right now" },
  { id: "authentication", pillar: "authenticity", angle: "spotting-fakes", label: "Spotting fakes & misreps" },
  { id: "sustainability", pillar: "sustainability", angle: "circular-fashion", label: "The case for secondhand" },
  { id: "platform-tips", pillar: "platform", angle: "workflow", label: "Get more from GradeThread" },
];

export function topicById(id: string): NewsletterTopic | null {
  return NEWSLETTER_TOPICS.find((t) => t.id === id) ?? null;
}

/** Reconstruct the catalog topic id from the (pillar, angle) stamped on an issue. */
export function topicByPillarAngle(
  pillar: string | null,
  angle: string | null,
): NewsletterTopic | null {
  if (!pillar || !angle) return null;
  return NEWSLETTER_TOPICS.find((t) => t.pillar === pillar && t.angle === angle) ?? null;
}

export interface SubjectStyle {
  id: string;
  label: string;
  /** A short instruction the copywriter uses when this style is selected. */
  guidance: string;
}

export const SUBJECT_STYLES: SubjectStyle[] = [
  { id: "benefit", label: "Benefit-led", guidance: "Lead with the concrete payoff to the reader." },
  { id: "curiosity", label: "Curiosity gap", guidance: "Open a loop the reader wants closed; don't give it away." },
  { id: "howto", label: "How-to", guidance: "Promise a clear, actionable how-to." },
  { id: "stat", label: "Stat / number", guidance: "Open with a concrete number or surprising stat." },
  { id: "question", label: "Question", guidance: "Pose a question the reader silently answers 'yes' to." },
];

export function subjectStyleById(id: string): SubjectStyle | null {
  return SUBJECT_STYLES.find((s) => s.id === id) ?? null;
}

// ── Per-dimension scored verdict ──

export interface DimensionScore {
  key: string;
  sent: number;
  openRate: number;
  clickRate: number;
  unsubRate: number;
  /** Has enough data (sent ≥ minSample) for its rates to count. */
  trusted: boolean;
  /** Paused — trusted unsub rate over the ceiling — gets zero weight. */
  paused: boolean;
  /** The chosen winner (best CTR among trusted, non-paused dimensions). */
  isWinner: boolean;
  /** Recommended new weight (0–100, integers summing to ~100). */
  weight: number;
}

/** Round a weight vector to integers summing to exactly `total` (default 100). */
function roundToTotal(weights: Map<string, number>, total = 100): Map<string, number> {
  const ids = [...weights.keys()];
  if (ids.length === 0) return new Map();
  const raw = ids.map((id) => ({ id, w: Math.max(0, weights.get(id) ?? 0) }));
  const sum = raw.reduce((s, r) => s + r.w, 0);
  if (sum <= 0) {
    const each = Math.floor(total / ids.length);
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

export interface WeightingResult {
  totalSent: number;
  /** True once a trusted, non-paused winner exists; below threshold we explore. */
  hasEnoughData: boolean;
  winnerKey: string | null;
  scores: DimensionScore[];
  /** key → recommended weight (integers, sum 100). */
  weights: Record<string, number>;
  /** keys paused by the unsub ceiling. */
  paused: string[];
}

/**
 * Re-tune selection weights for a set of dimension keys (topics or subject
 * styles) from recorded engagement:
 *  1. PAUSE any key with enough data whose unsub rate exceeds the ceiling
 *     (weight 0) — but never pause the last surviving key (keep ≥1 sendable).
 *  2. If a trusted winner exists among survivors, give it (1−floor) of the
 *     weight and split the `floor` evenly across ALL survivors so every
 *     non-paused key — including under-tested ones — keeps exploration airtime.
 *  3. Below the sample threshold there is no winner → uniform weights so the
 *     program keeps gathering data (no premature convergence).
 */
export function computeWeights(
  keys: string[],
  countsByKey: Record<string, EngagementCount>,
  config?: Partial<TuningConfig>,
): WeightingResult {
  const cfg = clampTuningConfig(config);
  const ids = [...new Set(keys)];
  if (ids.length === 0) {
    return { totalSent: 0, hasEnoughData: false, winnerKey: null, scores: [], weights: {}, paused: [] };
  }

  const score = (id: string): DimensionScore => {
    const c = countsByKey[id] ?? emptyCount();
    const sent = Math.max(0, c.sent);
    return {
      key: id,
      sent,
      openRate: rate(c.opened, sent),
      clickRate: rate(c.clicked, sent),
      unsubRate: rate(c.unsubscribed, sent),
      trusted: sent >= cfg.minSample,
      paused: false,
      isWinner: false,
      weight: 0,
    };
  };
  const scores = new Map(ids.map((id) => [id, score(id)]));
  const totalSent = ids.reduce((s, id) => s + scores.get(id)!.sent, 0);

  // Step 1 — pause high-unsub keys (with enough data), but keep ≥1 alive.
  const paused = new Set<string>();
  for (const id of ids) {
    const sc = scores.get(id)!;
    if (sc.trusted && sc.unsubRate > cfg.unsubCeiling) paused.add(id);
  }
  if (paused.size >= ids.length) {
    // Everything would pause — keep the lowest-unsub key sendable.
    const keep = [...ids].sort((a, b) =>
      (scores.get(a)!.unsubRate - scores.get(b)!.unsubRate) || a.localeCompare(b)
    )[0]!;
    paused.delete(keep);
  }

  const survivors = ids.filter((id) => !paused.has(id));

  // Winner: best CTR among trusted, non-paused survivors (open rate, then volume).
  const eligible = survivors
    .map((id) => scores.get(id)!)
    .filter((sc) => sc.trusted);
  eligible.sort((a, b) =>
    b.clickRate - a.clickRate ||
    b.openRate - a.openRate ||
    b.sent - a.sent ||
    a.key.localeCompare(b.key)
  );
  const winnerKey = eligible.length > 0 ? eligible[0]!.key : null;

  // Step 2/3 — allocate weights.
  const weights = new Map<string, number>(ids.map((id) => [id, 0]));
  if (survivors.length > 0) {
    if (winnerKey && survivors.length > 1) {
      const floorEach = (cfg.explorationFloor * 100) / survivors.length;
      for (const id of survivors) {
        weights.set(id, floorEach + (id === winnerKey ? (1 - cfg.explorationFloor) * 100 : 0));
      }
    } else {
      const each = 100 / survivors.length;
      for (const id of survivors) weights.set(id, each);
    }
  }
  const rounded = roundToTotal(weights, 100);

  for (const id of ids) {
    const sc = scores.get(id)!;
    sc.paused = paused.has(id);
    sc.isWinner = id === winnerKey;
    sc.weight = rounded.get(id) ?? 0;
  }

  return {
    totalSent,
    hasEnoughData: winnerKey !== null,
    winnerKey,
    scores: ids.map((id) => scores.get(id)!),
    weights: Object.fromEntries(ids.map((id) => [id, rounded.get(id) ?? 0])),
    paused: [...paused],
  };
}

// ── Weighted selection ──
// Deterministic given (weights, seed) so a dry-run preview and the real build
// agree, and so a test is reproducible. FNV-1a over the seed → an index into the
// cumulative weight. A key with weight 0 is never selectable.

function fnv1a(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function selectWeightedKey(
  weights: Record<string, number>,
  seed: string,
): string | null {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => a[0].localeCompare(b[0])); // stable order for determinism
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let pick = fnv1a(seed) % total;
  for (const [key, w] of entries) {
    if (pick < w) return key;
    pick -= w;
  }
  return entries[entries.length - 1]![0];
}

// ── Send-time optimization ──

export interface SendHourScore {
  hour: number;
  sent: number;
  openRate: number;
  clickRate: number;
  trusted: boolean;
}

export interface SendHourResult {
  /** Best UTC hour (0–23) by CTR among trusted hours, or null when none trusted. */
  bestHour: number | null;
  scores: SendHourScore[];
}

/**
 * Recommend the best send hour from per-hour engagement. Only hours with enough
 * data (sent ≥ minSample) are eligible; below that there's no recommendation
 * (the caller keeps its default cadence). CTR-first, open-rate tiebreak.
 */
export function recommendSendHour(
  byHour: Record<number, EngagementCount>,
  config?: Partial<TuningConfig>,
): SendHourResult {
  const cfg = clampTuningConfig(config);
  const scores: SendHourScore[] = [];
  for (let h = 0; h < 24; h++) {
    const c = byHour[h];
    if (!c || c.sent <= 0) continue;
    const sent = Math.max(0, c.sent);
    scores.push({
      hour: h,
      sent,
      openRate: rate(c.opened, sent),
      clickRate: rate(c.clicked, sent),
      trusted: sent >= cfg.minSample,
    });
  }
  const eligible = scores.filter((s) => s.trusted);
  eligible.sort((a, b) =>
    b.clickRate - a.clickRate || b.openRate - a.openRate || b.sent - a.sent || a.hour - b.hour
  );
  return {
    bestHour: eligible.length > 0 ? eligible[0]!.hour : null,
    scores: scores.sort((a, b) => a.hour - b.hour),
  };
}

// ── Aggregation helper ──
// Fold raw ledger rows into per-key engagement counts. `keyFn` returns the
// dimension key for a row (or null to skip it); `signals` reports whether the row
// opened / clicked / unsubscribed.

export function aggregateEngagement<T>(
  rows: T[],
  keyFn: (row: T) => string | null,
  signals: (row: T) => { opened: boolean; clicked: boolean; unsubscribed: boolean },
): Record<string, EngagementCount> {
  const out: Record<string, EngagementCount> = {};
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const c = out[key] ?? (out[key] = emptyCount());
    c.sent += 1;
    const s = signals(row);
    if (s.opened) c.opened += 1;
    if (s.clicked) c.clicked += 1;
    if (s.unsubscribed) c.unsubscribed += 1;
  }
  return out;
}

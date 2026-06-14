// US-875: content-freshness selection + material-change math.
//
// Pure helpers (no DB, no Deno.env, no clock) so the staleness ranking, the
// thrash guard, and the "is this refresh material?" decision are unit-testable
// with fixtures (content-freshness_test.ts). jobs-content-refresh.ts does the IO
// (load posts, load GSC, call the model, write) and delegates every judgement
// call here.

export interface FreshnessPost {
  id: string;
  slug: string;
  // ISO timestamps. published_at can be null for a published-but-unstamped row
  // (defensive — those sort last / are ineligible).
  published_at: string | null;
  last_refreshed_at: string | null;
  // For the fallback importance signal when GSC is unavailable: a longer,
  // more-invested article is treated as more pillar-like.
  reading_time_min: number | null;
}

export interface FreshnessOptions {
  // A post is not refreshed more than once per this many days (thrash guard).
  cooldownDays: number;
  // A post must be at least this old (since its freshness anchor) to be eligible.
  minStaleDays: number;
}

export interface RankedPost {
  id: string;
  slug: string;
  // Days since max(published_at, last_refreshed_at).
  ageDays: number;
  // Importance weight: normalized GSC score when available, else the pillar
  // fallback derived from reading time. Always ≥ 1.
  importance: number;
  // ageDays * importance — higher means "refresh me sooner".
  score: number;
  // Passes the thrash guard (cooldown) AND the minimum-staleness floor.
  eligible: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function anchorMs(post: FreshnessPost): number | null {
  // The freshness anchor is the most recent of published_at / last_refreshed_at.
  const pub = post.published_at ? Date.parse(post.published_at) : NaN;
  const ref = post.last_refreshed_at ? Date.parse(post.last_refreshed_at) : NaN;
  const vals = [pub, ref].filter((v) => Number.isFinite(v));
  if (vals.length === 0) return null;
  return Math.max(...vals);
}

// Fallback importance when GSC data is missing for a post: anchor on 1.0 and
// add a small, bounded boost for longer (more invested / pillar-like) articles
// so a 12-minute cornerstone outranks a 2-minute note of the same age.
export function fallbackImportance(readingTimeMin: number | null): number {
  const rt = typeof readingTimeMin === "number" && readingTimeMin > 0
    ? readingTimeMin
    : 0;
  return 1 + Math.min(rt, 15) / 15; // 1.0 .. 2.0
}

// Normalize a raw GSC score (impressions + clicks summed over the lookback) into
// a 1..3 importance multiplier relative to the busiest post in the set, so GSC
// importance always dominates the flat fallback (>=2 for any real traffic) but
// stays bounded. maxScore is the largest raw score across the candidate set.
export function gscImportance(rawScore: number, maxScore: number): number {
  if (rawScore <= 0 || maxScore <= 0) return 1;
  return 1 + 2 * (rawScore / maxScore); // 1 .. 3
}

// US-879 striking-distance boost: a post ranking ~5-20 with rising impressions
// is "almost there" — a refresh has outsized upside, so bump its importance
// (and thus its refresh priority) by up to +60%. `score01` is the 0..1 striking
// score from content-search-signals.ts (0 = not striking distance → no boost).
export const STRIKING_BOOST_MAX = 1.6;
export function strikingBoost(score01: number): number {
  const s = Math.max(0, Math.min(1, score01));
  return 1 + (STRIKING_BOOST_MAX - 1) * s;
}

/**
 * Rank published posts by staleness weighted by importance, oldest/most-
 * important first. `gscScoreByPath` maps a post slug → raw GSC score (impressions
 * + clicks) over the lookback window; pass an empty map to use the reading-time
 * fallback for every post (graceful GSC-absent degradation). `nowMs` is injected
 * so the ranking is deterministic in tests.
 *
 * US-879: `strikingByPath` optionally maps a slug → striking-distance score
 * (0..1); a post in striking distance gets its importance multiplied by
 * strikingBoost() so "almost ranking" posts are refreshed first. Omit it (or
 * pass an empty map) for the original behavior.
 */
export function rankStalePosts(
  posts: FreshnessPost[],
  gscScoreByPath: Map<string, number>,
  nowMs: number,
  opts: FreshnessOptions,
  strikingByPath?: Map<string, number>,
): RankedPost[] {
  const maxGsc = posts.reduce(
    (m, p) => Math.max(m, gscScoreByPath.get(p.slug) ?? 0),
    0,
  );

  const ranked: RankedPost[] = [];
  for (const post of posts) {
    const anchor = anchorMs(post);
    if (anchor == null) continue; // no usable date → never eligible
    const ageDays = (nowMs - anchor) / DAY_MS;

    const raw = gscScoreByPath.get(post.slug) ?? 0;
    const baseImportance = raw > 0
      ? gscImportance(raw, maxGsc)
      : fallbackImportance(post.reading_time_min);
    // Striking-distance posts get prioritized for a refresh (US-879).
    const boost = strikingByPath
      ? strikingBoost(strikingByPath.get(post.slug) ?? 0)
      : 1;
    const importance = baseImportance * boost;

    // Thrash guard: a refresh within the cooldown window blocks re-selection.
    const refMs = post.last_refreshed_at
      ? Date.parse(post.last_refreshed_at)
      : NaN;
    const daysSinceRefresh = Number.isFinite(refMs)
      ? (nowMs - refMs) / DAY_MS
      : Infinity;
    const cooledDown = daysSinceRefresh >= opts.cooldownDays;
    const oldEnough = ageDays >= opts.minStaleDays;

    ranked.push({
      id: post.id,
      slug: post.slug,
      ageDays,
      importance,
      score: ageDays * importance,
      eligible: cooledDown && oldEnough,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/** The highest-scoring eligible post, or null when nothing qualifies. */
export function pickStalePost(ranked: RankedPost[]): RankedPost | null {
  return ranked.find((r) => r.eligible) ?? null;
}

// ── Material-change detection ─────────────────────────────────

// Collapse HTML to a comparable bag of words: strip tags, lowercase, split on
// non-word runs. Used by materialChangeRatio so formatting-only edits (a tag
// rename, attribute tweak, whitespace) don't read as a content change.
export function htmlToWords(html: string): string[] {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface MaterialChange {
  oldWords: number;
  newWords: number;
  // Words present in new but not old (added) + present in old but not new
  // (removed), as a fraction of the original length.
  changedRatio: number;
  // Net growth in word count, as a fraction of the original length (can be
  // negative if the refresh trimmed).
  growthRatio: number;
  material: boolean;
}

export interface MaterialChangeOptions {
  // Minimum changed-word fraction to count as material (e.g. 0.10 = 10%).
  minChangedRatio: number;
  // OR a net growth of at least this fraction (e.g. 0.08 = grew 8%).
  minGrowthRatio: number;
}

const DEFAULT_MATERIAL_OPTS: MaterialChangeOptions = {
  minChangedRatio: 0.1,
  minGrowthRatio: 0.08,
};

/**
 * Decide whether a refreshed body differs enough from the original to be worth
 * publishing. Uses a multiset word diff (not a strict set) so repeated words and
 * length changes count. A change is material when EITHER enough words changed OR
 * the article grew/shrank by enough — trivial diffs (typo fix, reorder) are not.
 */
export function materialChangeRatio(
  oldHtml: string,
  newHtml: string,
  opts: MaterialChangeOptions = DEFAULT_MATERIAL_OPTS,
): MaterialChange {
  const oldWords = htmlToWords(oldHtml);
  const newWords = htmlToWords(newHtml);

  const oldCount = oldWords.length;
  const newCount = newWords.length;

  // Multiset diff: count per-word frequency, sum absolute differences.
  const freq = new Map<string, number>();
  for (const w of oldWords) freq.set(w, (freq.get(w) ?? 0) + 1);
  for (const w of newWords) freq.set(w, (freq.get(w) ?? 0) - 1);
  let changed = 0;
  for (const v of freq.values()) changed += Math.abs(v);

  const denom = Math.max(oldCount, 1);
  const changedRatio = changed / denom;
  const growthRatio = (newCount - oldCount) / denom;

  const material = changedRatio >= opts.minChangedRatio ||
    Math.abs(growthRatio) >= opts.minGrowthRatio;

  return {
    oldWords: oldCount,
    newWords: newCount,
    changedRatio,
    growthRatio,
    material,
  };
}

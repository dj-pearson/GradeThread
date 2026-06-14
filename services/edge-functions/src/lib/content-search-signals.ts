// US-879: Google Search Console → content engine closed loop.
//
// The gsc-sync cron (admin-seo.ts) already ingests per-(date, query, page,
// country, device) rows into public.gsc_performance (US-308). This module turns
// that raw signal into three actionable products:
//
//   1. Content gaps      — high-impression queries with NO dedicated post; queued
//                          into content_topics tagged source='gsc_opportunity'
//                          (consumed by the scheduler's bank refill).
//   2. Striking distance — pages ranking positions ~5-20 with rising impressions;
//                          a per-slug boost the freshness selector (US-875) uses
//                          to prioritize "almost ranking" posts for a refresh.
//   3. Title/meta wins   — high-impression / low-CTR queries surfaced in the
//                          weekly digest as title + meta-description rewrites.
//
// This file holds ONLY the PURE selectors (aggregate*, find*, *Score,
// isQueryCovered, toTitleCase) — plain functions over plain rows, no DB, no
// clock — so they're unit-testable with fixtures (content-search-signals_test
// .ts) without booting the service-role Supabase client. The gsc_performance IO
// (loaders, the gap-queue writer, the digest assembler) lives in
// content-search-signals-loaders.ts; every loader degrades to empty results when
// GSC is unconfigured or a query fails, so the whole loop is an OPTIONAL input:
// the engine still runs on the pillar map.

// ── Pure types ───────────────────────────────────────────────────

export interface RawSignalRow {
  query: string | null;
  page: string | null;
  impressions: number;
  clicks: number;
  position: number;
  date: string; // YYYY-MM-DD
}

export interface QuerySignal {
  query: string;
  impressions: number;
  clicks: number;
  ctr: number; // clicks / impressions, recomputed (0 when no impressions)
  position: number; // impression-weighted average rank
}

export interface PageSignal {
  page: string;
  impressions: number;
  clicks: number;
  position: number; // impression-weighted average rank
  impressionsRecent: number; // impressions on/after the window midpoint
  impressionsOlder: number; // impressions before the window midpoint
}

// ── Pure aggregation ─────────────────────────────────────────────

/**
 * Roll the raw cross-product rows up to one signal per query. gsc-sync stores
 * the full (date, query, page, country, device) cross-product, so a single
 * query spans many rows; we sum impressions/clicks and impression-weight the
 * average position. Output is sorted by impressions, busiest first.
 */
export function aggregateQuerySignals(rows: RawSignalRow[]): QuerySignal[] {
  const map = new Map<
    string,
    { impressions: number; clicks: number; posWeighted: number }
  >();
  for (const r of rows) {
    const q = (r.query ?? "").trim().toLowerCase();
    if (!q) continue;
    const imp = Math.max(0, r.impressions ?? 0);
    const e = map.get(q) ?? { impressions: 0, clicks: 0, posWeighted: 0 };
    e.impressions += imp;
    e.clicks += Math.max(0, r.clicks ?? 0);
    e.posWeighted += (r.position ?? 0) * imp;
    map.set(q, e);
  }
  const out: QuerySignal[] = [];
  for (const [query, e] of map) {
    out.push({
      query,
      impressions: e.impressions,
      clicks: e.clicks,
      ctr: e.impressions > 0 ? e.clicks / e.impressions : 0,
      position: e.impressions > 0 ? e.posWeighted / e.impressions : 0,
    });
  }
  out.sort((a, b) => b.impressions - a.impressions);
  return out;
}

/**
 * Roll the raw rows up to one signal per page, splitting impressions into the
 * recent vs older half of the window so a rising trend can be detected.
 * `midpointDate` (YYYY-MM-DD) is the cutoff: rows on/after it count as recent.
 */
export function aggregatePageSignals(
  rows: RawSignalRow[],
  midpointDate: string,
): PageSignal[] {
  const map = new Map<
    string,
    {
      impressions: number;
      clicks: number;
      posWeighted: number;
      recent: number;
      older: number;
    }
  >();
  for (const r of rows) {
    const p = (r.page ?? "").trim();
    if (!p) continue;
    const imp = Math.max(0, r.impressions ?? 0);
    const e = map.get(p) ??
      { impressions: 0, clicks: 0, posWeighted: 0, recent: 0, older: 0 };
    e.impressions += imp;
    e.clicks += Math.max(0, r.clicks ?? 0);
    e.posWeighted += (r.position ?? 0) * imp;
    if (r.date >= midpointDate) e.recent += imp;
    else e.older += imp;
    map.set(p, e);
  }
  const out: PageSignal[] = [];
  for (const [page, e] of map) {
    out.push({
      page,
      impressions: e.impressions,
      clicks: e.clicks,
      position: e.impressions > 0 ? e.posWeighted / e.impressions : 0,
      impressionsRecent: e.recent,
      impressionsOlder: e.older,
    });
  }
  return out;
}

// ── Striking distance ────────────────────────────────────────────

export interface StrikingOptions {
  minPosition: number; // outside [min,max] → not striking distance
  maxPosition: number;
  sweetLow: number; // ideal band (full fit) low edge
  sweetHigh: number; // ideal band high edge
  minImpressions: number; // volume floor — ignore long-tail noise
}

export const DEFAULT_STRIKING_OPTS: StrikingOptions = {
  minPosition: 5,
  maxPosition: 20,
  sweetLow: 8,
  sweetHigh: 12,
  minImpressions: 20,
};

/**
 * How well an average rank sits in the striking-distance band: 1.0 inside the
 * sweet band, tapering linearly to 0 at the min/max edges, 0 outside. Page 11
 * (top of page 2) is the highest-leverage spot, hence the central sweet band.
 */
export function positionFit(position: number, o: StrikingOptions): number {
  if (position < o.minPosition || position > o.maxPosition) return 0;
  if (position >= o.sweetLow && position <= o.sweetHigh) return 1;
  if (position < o.sweetLow) {
    const span = o.sweetLow - o.minPosition;
    return span <= 0 ? 1 : (position - o.minPosition) / span;
  }
  const span = o.maxPosition - o.sweetHigh;
  return span <= 0 ? 1 : (o.maxPosition - position) / span;
}

/**
 * Striking-distance score 0..1 for a page: position fit, gated by a volume floor
 * and a rising-impression trend (recent half > older half). A page that is well
 * placed but losing impressions scores 0 — we refresh the ones with momentum.
 */
export function strikingScore(
  page: PageSignal,
  o: StrikingOptions = DEFAULT_STRIKING_OPTS,
): number {
  if (page.impressions < o.minImpressions) return 0;
  if (page.impressionsRecent <= page.impressionsOlder) return 0; // not rising
  return positionFit(page.position, o);
}

// ── Content gaps + title/meta opportunities ──────────────────────

/**
 * A query is "covered" when any known keyword matches it (case-insensitive,
 * containment in either direction) — i.e. we already have a post targeting that
 * search. Anything not covered with real impressions is a content gap.
 */
export function isQueryCovered(
  query: string,
  coveredKeywords: Set<string>,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (coveredKeywords.has(q)) return true;
  for (const kw of coveredKeywords) {
    if (!kw) continue;
    if (q.includes(kw) || kw.includes(q)) return true;
  }
  return false;
}

export interface GapOptions {
  minImpressions: number;
  maxPosition?: number; // optionally ignore queries we already rank #1 for
  limit: number;
}

/** High-impression queries with no matching post, busiest first. */
export function findContentGaps(
  signals: QuerySignal[],
  coveredKeywords: Set<string>,
  o: GapOptions,
): QuerySignal[] {
  const out: QuerySignal[] = [];
  for (const s of signals) {
    if (s.impressions < o.minImpressions) continue;
    if (o.maxPosition !== undefined && s.position > o.maxPosition) continue;
    if (isQueryCovered(s.query, coveredKeywords)) continue;
    out.push(s);
    if (out.length >= o.limit) break;
  }
  return out;
}

export interface TitleMetaOptions {
  minImpressions: number;
  maxCtr: number; // "low CTR" ceiling
  maxPosition: number; // only queries we actually rank for
  limit: number;
}

/** High-impression / low-CTR queries — title + meta rewrite candidates. */
export function findTitleMetaOpportunities(
  signals: QuerySignal[],
  o: TitleMetaOptions,
): QuerySignal[] {
  return signals
    .filter(
      (s) =>
        s.impressions >= o.minImpressions &&
        s.ctr <= o.maxCtr &&
        s.position > 0 &&
        s.position <= o.maxPosition,
    )
    .slice(0, o.limit);
}

export function toTitleCase(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ── Digest opportunities (shape) ───────────────────────

// The weekly-digest view of the GSC signal. Pure shape + empty value here; the
// assembler that fills it from gsc_performance lives in the loaders module.
export interface SearchOpportunities {
  /** Posts ranking ~5-20 with rising impressions — refresh-priority targets. */
  striking_pages: Array<{
    page: string;
    slug: string | null;
    position: number;
    impressions: number;
    clicks: number;
  }>;
  /** High-impression queries with no dedicated post. */
  content_gaps: Array<{ query: string; impressions: number; position: number }>;
  /** High-impression / low-CTR queries — title + meta rewrite candidates. */
  title_meta: Array<{
    query: string;
    impressions: number;
    clicks: number;
    ctr: number;
    position: number;
  }>;
}

export const EMPTY_SEARCH_OPPORTUNITIES: SearchOpportunities = {
  striking_pages: [],
  content_gaps: [],
  title_meta: [],
};

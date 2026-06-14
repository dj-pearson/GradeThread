// US-879: Google Search Console → content engine closed loop (IO layer).
//
// The gsc-sync cron (admin-seo.ts) ingests per-(date, query, page, country,
// device) rows into public.gsc_performance (US-308). This module reads that
// signal and turns it into three actionable products via the PURE selectors in
// content-search-signals.ts:
//
//   1. Content gaps      — high-impression queries with NO dedicated post; queued
//                          into content_topics tagged source='gsc_opportunity'
//                          (queueGscGapTopics, called by the scheduler refill).
//   2. Striking distance — pages ranking ~5-20 with rising impressions; a
//                          per-slug boost the freshness selector (US-875) uses to
//                          prioritize "almost ranking" posts (loadStrikingDistanceBySlug).
//   3. Title/meta wins   — high-impression / low-CTR queries surfaced in the
//                          weekly digest (loadSearchOpportunities).
//
// Every loader is best-effort: it degrades to empty results whenever GSC is
// unconfigured or a query fails, so the whole loop is an OPTIONAL input — the
// engine still runs on the pillar map.

import { supabaseAdmin } from "./supabase.ts";
import {
  type ContentProduct,
  type ContentSurface,
  isKeywordDuplicate,
} from "./content-history.ts";
import {
  aggregatePageSignals,
  aggregateQuerySignals,
  DEFAULT_STRIKING_OPTS,
  EMPTY_SEARCH_OPPORTUNITIES,
  findContentGaps,
  findTitleMetaOpportunities,
  type QuerySignal,
  type RawSignalRow,
  type SearchOpportunities,
  type StrikingOptions,
  strikingScore,
  toTitleCase,
} from "./content-search-signals.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function loadRawSignals(days: number): Promise<RawSignalRow[]> {
  const since = ymd(Date.now() - days * DAY_MS);
  const { data, error } = await supabaseAdmin
    .from("gsc_performance")
    .select("query, page, impressions, clicks, position, date")
    .gte("date", since);
  if (error || !data) {
    if (error) {
      console.warn("[search-signals] gsc_performance read failed:", error.message);
    }
    return [];
  }
  return data as unknown as RawSignalRow[];
}

/** Best-effort per-query aggregates over the window. Empty when GSC is absent. */
export async function loadQuerySignals(days = 28): Promise<QuerySignal[]> {
  try {
    return aggregateQuerySignals(await loadRawSignals(days));
  } catch (e) {
    console.warn("[search-signals] loadQuerySignals failed (degrading):", e);
    return [];
  }
}

/**
 * Per-blog-slug striking-distance score (0..1) over the window. The freshness
 * selector multiplies a post's importance by strikingBoost(score) so an almost-
 * ranking post is refreshed sooner. Empty map → no boost (graceful degrade).
 */
export async function loadStrikingDistanceBySlug(
  days = 28,
  o: StrikingOptions = DEFAULT_STRIKING_OPTS,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const rows = await loadRawSignals(days);
    if (rows.length === 0) return out;
    const mid = ymd(Date.now() - Math.floor(days / 2) * DAY_MS);
    for (const p of aggregatePageSignals(rows, mid)) {
      const m = /\/blog\/([a-z0-9-]+)/i.exec(p.page);
      if (!m) continue;
      const slug = m[1].toLowerCase();
      const score = strikingScore(p, o);
      if (score > 0) out.set(slug, Math.max(out.get(slug) ?? 0, score));
    }
  } catch (e) {
    console.warn("[search-signals] striking load failed (degrading):", e);
  }
  return out;
}

/** Keywords we already cover for this slice — history index + live bank. */
async function loadCoveredKeywords(
  surface: ContentSurface,
  productFocus: ContentProduct,
): Promise<Set<string>> {
  const set = new Set<string>();
  const focusFilter = productFocus === "both"
    ? ["gradethread", "flipdesk", "both"]
    : [productFocus, "both"];

  const { data: hist } = await supabaseAdmin
    .from("content_history_index")
    .select("primary_keyword, secondary_keywords")
    .eq("surface", surface)
    .in("product_focus", focusFilter)
    .not("primary_keyword", "is", null);
  for (const r of hist ?? []) {
    const pk = (r.primary_keyword as string | null)?.trim().toLowerCase();
    if (pk) set.add(pk);
    const secs = (r.secondary_keywords as string[] | null) ?? [];
    for (const s of secs) {
      const v = String(s).trim().toLowerCase();
      if (v) set.add(v);
    }
  }

  const { data: topics } = await supabaseAdmin
    .from("content_topics")
    .select("primary_keyword")
    .eq("surface", surface)
    .in("product_focus", focusFilter)
    .in("status", ["queued", "assigned", "used"]);
  for (const r of topics ?? []) {
    const pk = (r.primary_keyword as string | null)?.trim().toLowerCase();
    if (pk) set.add(pk);
  }
  return set;
}

export interface QueueGapResult {
  queued: number;
  gaps: string[];
}

/**
 * Find GSC content gaps for the slice and queue the top ones into
 * content_topics tagged source='gsc_opportunity'. Returns 0 when GSC is absent,
 * when nothing clears the impression floor, or when every gap dedups against the
 * history index / live bank. The dedup gate is double: the covered-keyword set
 * AND a per-row isKeywordDuplicate check (catches a race with a concurrent tick).
 */
export async function queueGscGapTopics(input: {
  surface: ContentSurface;
  productFocus: ContentProduct;
  limit: number;
  lookbackDays?: number;
  minImpressions?: number;
}): Promise<QueueGapResult> {
  if (input.limit <= 0) return { queued: 0, gaps: [] };
  try {
    const signals = await loadQuerySignals(input.lookbackDays ?? 28);
    if (signals.length === 0) return { queued: 0, gaps: [] };

    const covered = await loadCoveredKeywords(input.surface, input.productFocus);
    const gaps = findContentGaps(signals, covered, {
      minImpressions: input.minImpressions ?? 30,
      maxPosition: 30,
      limit: input.limit * 3, // over-pull; the live dedup below drops some
    });
    if (gaps.length === 0) return { queued: 0, gaps: [] };

    const queuedKeywords: string[] = [];
    const rows: Array<Record<string, unknown>> = [];
    for (const g of gaps) {
      if (rows.length >= input.limit) break;
      if (queuedKeywords.includes(g.query)) continue;
      if (await isKeywordDuplicate(input.surface, input.productFocus, g.query)) {
        continue;
      }
      queuedKeywords.push(g.query);
      rows.push({
        surface: input.surface,
        product_focus: input.productFocus,
        title: toTitleCase(g.query),
        angle:
          `Search-demand topic: the site already earns ${Math.round(g.impressions)} ` +
          `impressions for "${g.query}" (avg position ${round1(g.position)}) with no ` +
          `dedicated post yet — write the page that captures it.`,
        primary_keyword: g.query,
        secondary_keywords: [],
        search_intent: "informational",
        status: "queued",
        generated_by: "ai",
        source: "gsc_opportunity",
      });
    }
    if (rows.length === 0) return { queued: 0, gaps: [] };

    const { data, error } = await supabaseAdmin
      .from("content_topics")
      .insert(rows)
      .select("id");
    if (error) {
      console.warn("[search-signals] gap topic insert failed:", error.message);
      return { queued: 0, gaps: [] };
    }
    return { queued: data?.length ?? 0, gaps: queuedKeywords };
  } catch (e) {
    console.warn("[search-signals] queueGscGapTopics failed (degrading):", e);
    return { queued: 0, gaps: [] };
  }
}

/**
 * The weekly-digest view of the GSC signal: striking-distance pages, content
 * gaps, and title/meta rewrite candidates. Best-effort — returns the empty
 * shape whenever GSC has no data.
 */
export async function loadSearchOpportunities(opts?: {
  days?: number;
  surface?: ContentSurface;
  productFocus?: ContentProduct;
}): Promise<SearchOpportunities> {
  const days = opts?.days ?? 28;
  try {
    const rows = await loadRawSignals(days);
    if (rows.length === 0) return EMPTY_SEARCH_OPPORTUNITIES;

    const querySignals = aggregateQuerySignals(rows);
    const mid = ymd(Date.now() - Math.floor(days / 2) * DAY_MS);
    const pages = aggregatePageSignals(rows, mid);

    const striking = pages
      .map((p) => ({ p, score: strikingScore(p) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.p.impressions - a.p.impressions)
      .slice(0, 10)
      .map((x) => {
        const m = /\/blog\/([a-z0-9-]+)/i.exec(x.p.page);
        return {
          page: x.p.page,
          slug: m ? m[1].toLowerCase() : null,
          position: round1(x.p.position),
          impressions: x.p.impressions,
          clicks: x.p.clicks,
        };
      });

    const covered = await loadCoveredKeywords(
      opts?.surface ?? "blog",
      opts?.productFocus ?? "both",
    );
    const content_gaps = findContentGaps(querySignals, covered, {
      minImpressions: 30,
      maxPosition: 30,
      limit: 10,
    }).map((s) => ({
      query: s.query,
      impressions: s.impressions,
      position: round1(s.position),
    }));

    const title_meta = findTitleMetaOpportunities(querySignals, {
      minImpressions: 50,
      maxCtr: 0.02,
      maxPosition: 15,
      limit: 10,
    }).map((s) => ({
      query: s.query,
      impressions: s.impressions,
      clicks: s.clicks,
      ctr: round3(s.ctr),
      position: round1(s.position),
    }));

    return { striking_pages: striking, content_gaps, title_meta };
  } catch (e) {
    console.warn("[search-signals] loadSearchOpportunities failed:", e);
    return EMPTY_SEARCH_OPPORTUNITIES;
  }
}

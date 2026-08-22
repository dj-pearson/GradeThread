// US-2786: find out which brands are worth crawling, instead of guessing.
//
// The nightly crawl walks brand_knowledge, so it can only ever reach brands
// somebody already researched by hand. The brands a thrift seller actually
// pulls off a rack are invisible to it, and no list we write down fixes that —
// the answer has to be measured.
//
// ── WHY THIS DOES NOT MINE THE CRAWL'S OWN LISTINGS ─────────────────────────
//
// The obvious design, and the one US-2786 was written with, is "read the Brand
// aspect off the listings discovery already fetched". That is circular. The
// crawl searches WITH a Brand aspect filter, so every listing it sees carries
// the brand it searched for; mining those yields the 230 brands we started
// with and nothing else. The story's AC2 says as much and is wrong about it,
// which is worth recording rather than quietly working around.
//
// So the prospect pass runs its own UNFILTERED walk of eBay's clothing
// category, newest first, and tallies the Brand aspect of every listing that
// DECLARES a style code. That measures the thing AC2 actually wanted — how
// often a brand's sellers fill the Style Code box — and it is the only way to
// see a brand nobody here has heard of.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
//
// It never writes brand_knowledge. A candidate is evidence for a human, and
// promotion still goes through the US-1718 sourced seed flow, which rejects a
// fact with no source_url. Nothing here has a source_url, because a tally is a
// measurement rather than a claim about a brand.
//
// Pure — no eBay, no database, no clock.

import {
  declaredProductName,
  declaredStyleCode,
  declaredStyleCodeRaw,
} from "./style-code-aspects.ts";
import {
  type DiscoveryListing,
  type DiscoveryStateRow,
  EXHAUSTED_EMPTY_PASSES,
  MAX_DISCOVERY_OFFSET,
  MIN_STYLE_CODE_LENGTH,
} from "./style-code-discovery.ts";

/** Listings pulled per prospect pass, and how many get their specifics read.
 *  Deliberately smaller than the brand crawl's budget: prospecting is a survey,
 *  and it competes for the same eBay allowance as work with a known payoff. */
export const DEFAULT_PROSPECT_LOOKUPS = 25;

/** eBay aspect names that carry the brand. "Brand" is near-universal in
 *  clothing categories; the others appear on a minority of listings. */
const BRAND_ASPECTS = ["Brand", "Manufacturer"];

/**
 * Is the curated brand pool actually used up?
 *
 * US-2786 AC1: the prospect pass waits for evidence, not for a hunch. Used up
 * means every brand in brand_knowledge has been crawled at least once AND has
 * either wrapped its cursor or gone EXHAUSTED_EMPTY_PASSES passes without
 * finding a code the index did not already hold.
 *
 * A pool with one never-crawled brand left is not exhausted. That brand may be
 * the best one, and spending the survey budget before looking at it is the
 * expensive way to find that out.
 */
export function poolExhausted(state: readonly DiscoveryStateRow[]): boolean {
  if (state.length === 0) return false;
  return state.every((row) => {
    if (!row.last_run_at) return false;
    return (row.page_offset ?? 0) >= MAX_DISCOVERY_OFFSET ||
      (row.empty_passes ?? 0) >= EXHAUSTED_EMPTY_PASSES;
  });
}

/** How much of the pool is done, for the admin surface. Always a fraction of
 *  the whole pool, never of the brands that happen to have a state row. */
export function poolProgress(
  state: readonly DiscoveryStateRow[],
  totalBrands: number,
): { crawled: number; exhausted: number; total: number } {
  return {
    crawled: state.filter((r) => !!r.last_run_at).length,
    exhausted: state.filter((r) =>
      !!r.last_run_at &&
      ((r.page_offset ?? 0) >= MAX_DISCOVERY_OFFSET ||
        (r.empty_passes ?? 0) >= EXHAUSTED_EMPTY_PASSES)
    ).length,
    total: totalBrands,
  };
}

function firstAspect(
  aspects: Record<string, string>,
  names: readonly string[],
): string | null {
  for (const want of names) {
    for (const [k, v] of Object.entries(aspects)) {
      if (k.trim().toLowerCase() !== want.toLowerCase()) continue;
      const value = (v ?? "").trim();
      if (value) return value;
    }
  }
  return null;
}

export interface ProspectSighting {
  /** The brand exactly as eBay's aspect spells it. The crawl searches on this. */
  brandLabel: string;
  /** True when this listing declared a style code in a structured field. */
  declaredCode: boolean;
  /** The declared code, when there was one. Kept because a code is worth having
   *  even for a brand nobody has curated — see AC4. */
  codeRaw: string | null;
  name: string | null;
  title: string;
  url: string | null;
}

/**
 * What one unfiltered listing says about its brand.
 *
 * Returns null when the listing names no brand at all, which is common and is
 * not evidence about anything.
 *
 * `canonicalize` is deliberately the punctuation-and-case normalizer rather
 * than a decoder: a brand with no `brand_style_codes` spec has no canonical
 * form to resolve to, and pretending otherwise would file codes under a key a
 * later decoder would have to undo (AC4 — that re-key is US-2714's job).
 */
export function harvestSighting(args: {
  listing: DiscoveryListing;
  canonicalize: (raw: string) => string;
  ownItemIds: ReadonlySet<string>;
}): ProspectSighting | null {
  const { listing, canonicalize, ownItemIds } = args;
  if (ownItemIds.has(listing.itemId)) return null;

  const brandLabel = firstAspect(listing.aspects, BRAND_ASPECTS);
  if (!brandLabel) return null;
  // "Unbranded" and friends are a real eBay value and are not a brand.
  const lowered = brandLabel.toLowerCase();
  if (lowered === "unbranded" || lowered === "handmade" || lowered === "none") {
    return null;
  }

  const codeNorm = declaredStyleCode(listing, canonicalize);
  const usable = !!codeNorm && codeNorm.length >= MIN_STYLE_CODE_LENGTH;

  return {
    brandLabel,
    declaredCode: usable,
    codeRaw: usable ? declaredStyleCodeRaw(listing) ?? codeNorm : null,
    name: usable ? declaredProductName(listing) : null,
    title: listing.title.trim(),
    url: listing.url?.trim() || null,
  };
}

export interface CandidateTally {
  brandKey: string;
  brandLabel: string;
  listingsSeen: number;
  listingsWithCode: number;
}

/**
 * Collapse a pass's sightings into one row per brand.
 *
 * Brands already in `brand_knowledge` are dropped here rather than at the
 * write: they are already crawled, and a candidate row for one would be a
 * second place recording the same brand with worse numbers.
 *
 * The longest label seen wins, because the crawl has to search on this string
 * and "AF" is not a query that finds Abercrombie.
 */
export function tallyCandidates(args: {
  sightings: readonly ProspectSighting[];
  brandKeyFor: (label: string) => string | null;
  knownBrandKeys: ReadonlySet<string>;
}): CandidateTally[] {
  const { sightings, brandKeyFor, knownBrandKeys } = args;
  const byKey = new Map<string, CandidateTally>();

  for (const s of sightings) {
    const key = brandKeyFor(s.brandLabel);
    if (!key || knownBrandKeys.has(key)) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.listingsSeen++;
      if (s.declaredCode) existing.listingsWithCode++;
      if (s.brandLabel.length > existing.brandLabel.length) {
        existing.brandLabel = s.brandLabel;
      }
      continue;
    }
    byKey.set(key, {
      brandKey: key,
      brandLabel: s.brandLabel,
      listingsSeen: 1,
      listingsWithCode: s.declaredCode ? 1 : 0,
    });
  }

  // Best code-fill rate first, then volume. This is the order an operator
  // reads, and computing it here keeps the SQL and the UI from each having
  // their own idea of what "most promising" means.
  return [...byKey.values()].sort((a, b) =>
    b.listingsWithCode / b.listingsSeen - a.listingsWithCode / a.listingsSeen ||
    b.listingsSeen - a.listingsSeen ||
    a.brandKey.localeCompare(b.brandKey)
  );
}

export interface ProspectOutcome {
  scanned: number;
  inspected: number;
  /** Listings that named a brand at all. */
  branded: number;
  /** Listings that declared a style code. */
  declared: number;
  /** Distinct uncurated brands tallied this pass. */
  candidates: number;
  /** Codes written for uncurated brands. */
  codes: number;
  ownSkipped: number;
  nextOffset: number;
  failed: boolean;
  /** False when the pass did not run because the curated pool is not used up. */
  ran: boolean;
}

export function emptyProspectOutcome(offset: number): ProspectOutcome {
  return {
    scanned: 0,
    inspected: 0,
    branded: 0,
    declared: 0,
    candidates: 0,
    codes: 0,
    ownSkipped: 0,
    nextOffset: offset,
    failed: false,
    ran: false,
  };
}

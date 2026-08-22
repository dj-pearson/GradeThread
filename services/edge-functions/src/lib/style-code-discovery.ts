// US-2782: fill the style-code index with codes nobody here has ever listed.
//
// Every existing path into the index starts from a code we have already met.
// ai-tag-ocr reads one off a tag a seller photographed; the US-2690 sweep takes
// codes already on items or already in the index and asks the market what they
// are. So the index can only describe garments that have already passed through
// the building — and the codes worth knowing are the other ones. The reseller
// standing in a thrift store, and the visitor who lands on /style/:code and gets
// a blank, are both asking about a garment we have never seen.
//
// This module crawls BRAND-first instead. Pick a brand we hold knowledge on, page
// through its live listings, and keep the codes sellers already typed into eBay's
// structured fields.
//
// ── THE RULE THAT DOES NOT MOVE ─────────────────────────────────────────────
//
// A TITLE NEVER CREATES A CODE AND NEVER CREATES A NAME.
//
// US-2751 recorded why and none of it changes because the crawl runs in a new
// direction: a title is marketing text from a seller who may have bought the
// garment with nothing but a size dot, and our own sellers publish with titles
// our AI wrote, so reading titles back counts our own output as corroboration.
// An item specific is different in kind — a seller who filled the Style Code box
// typed it off a tag on purpose. harvestListing reuses declaredStyleCode and
// declaredProductName rather than carrying a softer copy of that judgement.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// Not a queue: the work-list is DERIVED every tick from the brand table joined to
// the cursor table. A tick that dies loses its cursor advance and nothing else.
//
// Pure — no eBay, no database, no clock. Every rule above is a unit test.

import {
  declaredProductName,
  declaredStyleCode,
  declaredStyleCodeRaw,
  type ListingAspects,
} from "./style-code-aspects.ts";
import { MIN_STYLE_CODE_LENGTH } from "./style-code-observations.ts";

export { MIN_STYLE_CODE_LENGTH };

/** Clothing, Shoes & Accessories. eBay refuses an aspect_filter without a
 *  category scope, and the Brand aspect is the whole difference between a brand
 *  crawl and a keyword search that happens to mention the brand. */
export const EBAY_CLOTHING_CATEGORY_ID = "11450";

/** eBay Browse caps limit + offset at 10,000. Past this a brand's crawl has
 *  reached as deep as the API will go and starts again from the top. */
export const MAX_DISCOVERY_OFFSET = 9_950;

/** Listings asked for per search call. eBay's Browse maximum. */
export const DISCOVERY_PAGE_SIZE = 50;

/** Brands per tick, and item-specific lookups per brand. The tick costs
 *  brands x (1 search + lookups) eBay calls, drawn from the same app-level
 *  allowance the comps ladder and the seller Add flow use.
 *
 *  RAISED FROM 3 TO 12 after the first production run (2026-08-21), which
 *  reported `considered: 230, crawled: 3, deferred: 227`. At three a night a
 *  single pass over the knowledge base takes 77 nights, so the seven-day
 *  cooldown never binds and the BUDGET is the whole schedule. Twelve is 252
 *  calls a night and a full pass every 19 nights. */
export const DEFAULT_BRANDS_PER_RUN = 12;
export const DEFAULT_LOOKUPS_PER_BRAND = 20;

/** A brand is not re-crawled inside this window. Listings do not turn over fast
 *  enough for a second pass the same week to reach anything new. */
export const BRAND_COOLDOWN_DAYS = 7;

/** The long cooldown, applied to a brand that has wrapped its cursor or gone
 *  several passes without a new code. Still re-crawled eventually: inventory
 *  turns over, and a brand that was empty in March is not empty forever. */
export const EXHAUSTED_COOLDOWN_DAYS = 30;

/** Consecutive passes finding no new code before a brand counts as exhausted. */
export const EXHAUSTED_EMPTY_PASSES = 3;

/** Titles kept per code. Matches MAX_TITLES_PER_OBSERVATION: one search
 *  returning ten near-identical listings is one piece of evidence. */
export const MAX_TITLES_PER_CODE = 3;

const MS_PER_DAY = 86_400_000;

// ── Choosing what to crawl ──────────────────────────────────────────────────

/** A brand we hold knowledge on. The label is what eBay's Brand aspect matches;
 *  the key is what everything here files under. */
export interface DiscoveryBrandRow {
  brandKey: string;
  brandLabel: string;
}

/** Where a brand's last crawl stopped. Column names, because these rows arrive
 *  straight from style_code_discovery_brands and renaming them in between is a
 *  mapping layer that exists only to be wrong once. */
export interface DiscoveryStateRow {
  brand_key: string;
  page_offset: number;
  last_run_at: string | null;
  empty_passes: number;
}

export interface DiscoveryTarget {
  brandKey: string;
  brandLabel: string;
  /** Where this tick starts paging. */
  offset: number;
  /** True when the stored cursor passed the ceiling and this pass restarts. */
  wrapped: boolean;
}

export interface DiscoveryWorkList {
  targets: DiscoveryTarget[];
  /** Brands looked at before any filtering. */
  considered: number;
  /** Eligible brands the budget could not reach this tick. Reported rather than
   *  dropped: a job that lists only what it did reads as "we covered
   *  everything" on a run that covered a third of the rotation. */
  deferred: number;
  skippedCooldown: number;
  skippedExhausted: number;
}

function daysSince(iso: string | null, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / MS_PER_DAY;
}

/**
 * The brands this tick spends its eBay budget on.
 *
 * Least recently crawled first, with a brand nobody has ever crawled ahead of
 * every brand that has. Brands inside their cooldown are skipped; a brand whose
 * cursor reached the paging ceiling restarts at zero and takes the long
 * cooldown rather than looping the first page nightly.
 */
export function pickDiscoveryTargets(args: {
  brands: readonly DiscoveryBrandRow[];
  state: readonly DiscoveryStateRow[];
  budget: number;
  now: Date;
  /** US-2787: brands an operator asked for by hand. Their cooldown is skipped —
   *  a manual run exists precisely to look at a brand NOW — but nothing else
   *  changes: the cursor still wraps at the ceiling, and a forced brand still
   *  competes for the budget rather than being handed an extra eBay call. */
  forceBrandKeys?: ReadonlySet<string>;
}): DiscoveryWorkList {
  const { brands, state, budget, now } = args;
  const forced = args.forceBrandKeys ?? new Set<string>();

  const byKey = new Map<string, DiscoveryStateRow>();
  for (const row of state) byKey.set(row.brand_key, row);

  let skippedCooldown = 0;
  let skippedExhausted = 0;
  const eligible: Array<DiscoveryTarget & { age: number; forced: boolean }> = [];
  const seenBrands = new Set<string>();

  for (const brand of brands) {
    const key = brand.brandKey.trim();
    const label = brand.brandLabel.trim() || key;
    // A brand listed twice under the same key is one brand. Two crawls of it in
    // one tick would spend the budget twice and advance one cursor.
    if (!key || seenBrands.has(key)) continue;
    seenBrands.add(key);

    const row = byKey.get(key);
    const cursor = Math.max(0, row?.page_offset ?? 0);
    const emptyPasses = Math.max(0, row?.empty_passes ?? 0);
    const wrapped = cursor >= MAX_DISCOVERY_OFFSET;
    const exhausted = wrapped || emptyPasses >= EXHAUSTED_EMPTY_PASSES;
    const cooldown = exhausted ? EXHAUSTED_COOLDOWN_DAYS : BRAND_COOLDOWN_DAYS;
    const age = daysSince(row?.last_run_at ?? null, now);

    if (age < cooldown && !forced.has(key)) {
      if (exhausted) skippedExhausted++;
      else skippedCooldown++;
      continue;
    }

    eligible.push({
      brandKey: key,
      brandLabel: label,
      offset: wrapped ? 0 : cursor,
      wrapped,
      age,
      // A forced brand leads the queue outright. Ranking it by age instead
      // would let 200 never-crawled brands push out the one an operator just
      // clicked, which is the opposite of what they asked for.
      forced: forced.has(key),
    });
  }

  // Oldest first; never-crawled brands carry Infinity and lead. Ties break on
  // the key so a tick is reproducible rather than dependent on table order.
  eligible.sort((a, b) =>
    Number(b.forced) - Number(a.forced) ||
    b.age - a.age ||
    a.brandKey.localeCompare(b.brandKey)
  );

  // A forced brand is guaranteed a slot even when the budget is smaller than
  // the number of brands asked for; without this a manual run could report
  // success having crawled somebody else entirely.
  const cap = Math.max(
    Math.max(0, Math.floor(budget)),
    eligible.filter((e) => e.forced).length,
  );
  const targets = eligible
    .slice(0, cap)
    .map(({ age: _age, forced: _forced, ...t }) => t);

  return {
    targets,
    considered: brands.length,
    deferred: Math.max(0, eligible.length - targets.length),
    skippedCooldown,
    skippedExhausted,
  };
}

// ── Harvesting one listing ──────────────────────────────────────────────────

/** A listing plus where it lives, which is the evidence URL we keep. */
export interface DiscoveryListing extends ListingAspects {
  url?: string | null;
}

export interface DiscoveryFind {
  itemId: string;
  /** Canonical key. This is what the code is filed under. */
  codeNorm: string;
  /** Exactly what the seller typed, kept for display. */
  codeRaw: string;
  /** The product name from a structured field, when the same listing had one. */
  name: string | null;
  title: string;
  url: string | null;
}

/**
 * What one listing is worth to the crawl.
 *
 * A find requires a code in a STRUCTURED field. A listing whose title contains a
 * perfect style code and whose aspects are empty produces nothing — that is the
 * point of the module, not an oversight in it.
 */
export function harvestListing(args: {
  listing: DiscoveryListing;
  canonicalize: (raw: string) => string;
  ownItemIds: ReadonlySet<string>;
}): DiscoveryFind | null {
  const { listing, canonicalize, ownItemIds } = args;

  // Ours. Learning our own AI-written specifics back as market evidence is one
  // guess wearing three hats, and the crawl finds far more of our listings than
  // the sweep does because it searches by brand rather than by a code.
  if (ownItemIds.has(listing.itemId)) return null;

  const codeNorm = declaredStyleCode(listing, canonicalize);
  if (!codeNorm) return null;
  // Two characters match everything. Same floor as every other write path.
  if (codeNorm.length < MIN_STYLE_CODE_LENGTH) return null;

  const codeRaw = declaredStyleCodeRaw(listing) ?? codeNorm;

  return {
    itemId: listing.itemId,
    codeNorm,
    codeRaw,
    name: declaredProductName(listing),
    title: listing.title.trim(),
    url: listing.url?.trim() || null,
  };
}

// ── Collapsing a page into writes ───────────────────────────────────────────

export interface DiscoveryWrite {
  codeNorm: string;
  codeRaw: string;
  /** Null when the page's named listings did not agree, or none had a name. */
  name: string | null;
  /** Listings backing that name. Zero when name is null. */
  supporting: number;
  titles: Array<{ title: string; url: string | null }>;
  evidenceUrl: string | null;
}

/** Same-answer test: same words in the same order, ignoring case and
 *  punctuation. The rule the aspect evidence and the re-key planner both use. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

/**
 * One write per code, however many listings of it a page held.
 *
 * Ten copies of one garment are one piece of evidence. And when the named
 * listings DISAGREE the name comes back null rather than by majority — two
 * people who both read a tag and disagree is a question for a human, which is
 * the same refusal aspectEvidence makes.
 */
export function planDiscoveryWrites(
  finds: readonly DiscoveryFind[],
): DiscoveryWrite[] {
  const groups = new Map<string, DiscoveryFind[]>();
  for (const find of finds) {
    const list = groups.get(find.codeNorm);
    if (list) list.push(find);
    else groups.set(find.codeNorm, [find]);
  }

  const writes: DiscoveryWrite[] = [];
  for (const [codeNorm, group] of groups) {
    const named = group.filter((f): f is DiscoveryFind & { name: string } =>
      typeof f.name === "string" && f.name.length > 0
    );
    const first = named[0]?.name ?? null;
    const agree = first !== null && named.every((f) => sameName(f.name, first));

    const titles: Array<{ title: string; url: string | null }> = [];
    const seenTitles = new Set<string>();
    for (const f of group) {
      if (titles.length >= MAX_TITLES_PER_CODE) break;
      const key = f.title.toLowerCase();
      if (!f.title || seenTitles.has(key)) continue;
      seenTitles.add(key);
      titles.push({ title: f.title, url: f.url });
    }

    writes.push({
      codeNorm,
      // The first raw spelling seen. They normalize to one key by definition,
      // so any of them displays correctly and picking one is not a judgement.
      codeRaw: group[0]!.codeRaw,
      name: agree ? first : null,
      supporting: agree ? named.length : 0,
      titles,
      evidenceUrl: group.find((f) => f.url)?.url ?? null,
    });
  }

  return writes;
}

// ── Reporting ───────────────────────────────────────────────────────────────

export interface BrandOutcome {
  brandKey: string;
  /** Listings the search returned. */
  scanned: number;
  /** Listings whose item specifics were fetched. Bounded by the budget. */
  inspected: number;
  /** Listings that declared a code in a structured field. */
  declared: number;
  /** Distinct codes written this pass. */
  codes: number;
  /** Codes not already in the index before this pass. */
  newCodes: number;
  /** Names written to style_code_names. */
  names: number;
  ownSkipped: number;
  /** Where the cursor now points. */
  nextOffset: number;
  failed: boolean;
}

export interface DiscoverySummary {
  crawled: number;
  scanned: number;
  inspected: number;
  declared: number;
  codes: number;
  newCodes: number;
  names: number;
  ownSkipped: number;
  failed: number;
}

export function summarizeDiscovery(
  outcomes: readonly BrandOutcome[],
): DiscoverySummary {
  const sum = (pick: (o: BrandOutcome) => number) =>
    outcomes.reduce((n, o) => n + pick(o), 0);
  return {
    crawled: outcomes.length,
    scanned: sum((o) => o.scanned),
    inspected: sum((o) => o.inspected),
    declared: sum((o) => o.declared),
    codes: sum((o) => o.codes),
    newCodes: sum((o) => o.newCodes),
    names: sum((o) => o.names),
    ownSkipped: sum((o) => o.ownSkipped),
    failed: outcomes.filter((o) => o.failed).length,
  };
}

// ── One brand's pass ────────────────────────────────────────────────────────

/** Everything the crawl touches outside itself. The live implementations live
 *  in the job route; tests pass their own and the whole pass runs with no eBay,
 *  no database and no clock. Same seam the sweep uses. */
export interface DiscoveryDeps {
  /** One page of a brand's live listings. */
  page(args: {
    brandLabel: string;
    offset: number;
    limit: number;
  }): Promise<Array<{ itemId: string; title: string; url: string | null }>>;
  /** Item specifics for one listing. Null when eBay would not serve them. */
  aspects(itemId: string): Promise<DiscoveryListing | null>;
  /** Canonical key for a raw code under this brand. */
  canonicalize(brandKey: string, raw: string): string;
  /** Which of these codes the index already holds for this brand. */
  knownCodes(brandKey: string, codes: readonly string[]): Promise<Set<string>>;
  writeCode(brandKey: string, write: DiscoveryWrite): Promise<void>;
  writeName(brandKey: string, write: DiscoveryWrite): Promise<void>;
  markCrawled(args: {
    brandKey: string;
    nextOffset: number;
    listingsSeen: number;
    codesFound: number;
    newCodes: number;
  }): Promise<void>;
}

/**
 * Crawl one brand: a page, a bounded number of item-specific lookups, and the
 * writes those produce.
 *
 * Our own listings are dropped BEFORE any lookup is spent on them. The crawl
 * searches by brand rather than by code, so it meets far more of our own
 * inventory than the sweep ever does, and paying eBay to read back specifics
 * our AI wrote is the expensive version of learning nothing.
 *
 * A failed pass records the attempt at the SAME offset. The cursor must not
 * advance past listings nobody looked at, and the recorded attempt is what
 * stops a permanently failing brand from being retried every single night.
 */
export async function crawlBrand(args: {
  target: DiscoveryTarget;
  deps: DiscoveryDeps;
  ownItemIds: ReadonlySet<string>;
  lookups: number;
  pageSize?: number;
}): Promise<BrandOutcome> {
  const { target, deps, ownItemIds, lookups } = args;
  const pageSize = args.pageSize ?? DISCOVERY_PAGE_SIZE;
  const base: BrandOutcome = {
    brandKey: target.brandKey,
    scanned: 0,
    inspected: 0,
    declared: 0,
    codes: 0,
    newCodes: 0,
    names: 0,
    ownSkipped: 0,
    nextOffset: target.offset,
    failed: false,
  };

  try {
    const listings = await deps.page({
      brandLabel: target.brandLabel,
      offset: target.offset,
      limit: pageSize,
    });
    base.scanned = listings.length;

    const foreign = listings.filter((l) => !ownItemIds.has(l.itemId));
    base.ownSkipped = listings.length - foreign.length;

    const finds: DiscoveryFind[] = [];
    for (const listing of foreign.slice(0, Math.max(0, lookups))) {
      base.inspected++;
      const detail = await deps.aspects(listing.itemId);
      if (!detail) continue;
      const find = harvestListing({
        // The search response carries the title and URL; the item response
        // carries the aspects. Neither alone is the evidence.
        listing: { ...detail, url: detail.url ?? listing.url },
        canonicalize: (raw) => deps.canonicalize(target.brandKey, raw),
        ownItemIds,
      });
      if (!find) continue;
      base.declared++;
      finds.push(find);
    }

    const writes = planDiscoveryWrites(finds);
    base.codes = writes.length;

    const known = await deps.knownCodes(
      target.brandKey,
      writes.map((w) => w.codeNorm),
    );
    base.newCodes = writes.filter((w) => !known.has(w.codeNorm)).length;

    for (const write of writes) {
      await deps.writeCode(target.brandKey, write);
      if (write.name) {
        await deps.writeName(target.brandKey, write);
        base.names++;
      }
    }

    base.nextOffset = nextCursor({
      offset: target.offset,
      requested: pageSize,
      returned: listings.length,
    });
  } catch (err) {
    base.failed = true;
    console.error(
      `[style-code-discovery] ${target.brandKey} pass failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    await deps.markCrawled({
      brandKey: target.brandKey,
      nextOffset: base.nextOffset,
      listingsSeen: base.scanned,
      codesFound: base.codes,
      newCodes: base.newCodes,
    });
  } catch (err) {
    // The pass still happened and its writes still landed. Losing the cursor
    // means one repeated page next time, which is cheap; failing the tick over
    // it would throw away the codes this pass just learned.
    console.error(
      `[style-code-discovery] ${target.brandKey} cursor write failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return base;
}

/**
 * Where a brand's cursor points after a pass.
 *
 * A page that came back short of what was asked for is the end of what eBay
 * will serve for this brand, so the cursor jumps to the ceiling and the next
 * pick wraps it. Advancing by the page size instead would spend a call a night
 * on an offset past the last result.
 */
export function nextCursor(args: {
  offset: number;
  requested: number;
  returned: number;
}): number {
  const { offset, requested, returned } = args;
  if (returned < requested) return MAX_DISCOVERY_OFFSET;
  return Math.min(MAX_DISCOVERY_OFFSET, offset + returned);
}

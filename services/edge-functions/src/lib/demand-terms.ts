// US-546 (AC2): eBay search-demand terms fed into the AutoLister title/
// description prompt.
//
// The previous listing prompt had no notion of what buyers actually SEARCH
// for — it leaned on the model's general knowledge. eBay's own active listings
// are a free, live demand signal: the words real sellers put in titles for a
// brand/category are the words that surface in search and convert. We mine the
// most-recurring significant terms from the comp titles eBay returns for the
// item's brand/category and feed them to the model as "high-demand search
// terms", to fold in where they truthfully apply.
//
// The miner (`mineDemandTermsFromTitles`) is PURE and dependency-free so it is
// unit-tested without any eBay/AI calls. The async `getEbaySearchDemandTerms`
// is a thin, NON-THROWING wrapper over the existing Browse comp search — any
// failure returns [] so listing generation is never blocked by it.

import { searchBrowseComps } from "./ebay-client.ts";
// US-2675: the same floor the pricing path uses to decide sold data is
// trustworthy. Imported rather than restated so the two cannot drift.
import { getRealizedCompTitles, MIN_SOLD_COMPS } from "./sold-comps.ts";

// Words that carry no search-demand signal: generic filler, condition/marketing
// boilerplate, and pronouns. Kept lowercase; matched case-insensitively.
const STOPWORDS = new Set<string>([
  "the", "and", "for", "with", "your", "you", "this", "that", "all", "new",
  "used", "size", "men", "mens", "women", "womens", "kids", "boys", "girls",
  "in", "of", "to", "a", "an", "or", "by", "on", "at", "is", "it", "from",
  "great", "good", "excellent", "nice", "perfect", "rare", "vintage", "style",
  "free", "shipping", "fast", "ship", "lot", "set", "brand", "item", "items",
  "nwt", "nwot", "euc", "vguc", "guc", "pre", "owned", "preowned", "condition",
  "authentic", "genuine", "real", "official", "deal", "sale", "look", "looks",
  "color", "colour", "very",
]);

// Strip eBay's noisy punctuation/emoji and collapse to spaced tokens.
function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// A token is demand-significant when it isn't a stopword, isn't a known seed
// term (brand/size we already have), isn't a bare 1-char token, and isn't a
// pure number with no unit context (sizes/years are kept — they're searched).
function isSignificant(token: string, seeds: Set<string>): boolean {
  if (token.length < 2) return false;
  if (STOPWORDS.has(token)) return false;
  if (seeds.has(token)) return false;
  // Drop pure punctuation residue handled by tokenize; keep alphanumerics.
  return true;
}

export interface MineDemandOptions {
  // Brand/size/known words to exclude — no value re-suggesting what we already
  // put in the title. Compared case-insensitively, tokenized the same way.
  seedTerms?: string[];
  // Max terms to return (highest demand first). Default 12.
  max?: number;
  // Minimum number of titles a term must appear in to count as "demand" (not a
  // one-off). Default 2.
  minCount?: number;
  // What the supplied titles ARE. Only affects the label on the returned terms;
  // a single corpus cannot compute a lift against itself. Default "active".
  source?: DemandTermSource;
}

/**
 * Where a term's evidence came from. US-2675: `active` means other sellers are
 * WRITING it; `sold` means listings carrying it actually SOLD. Only the second
 * is buyer demand -- the first is seller language, which is what this miner
 * mistook for demand until now.
 */
export type DemandTermSource = "sold" | "active";

export interface DemandTerm {
  term: string;
  /** Document frequency within the corpus named by `source`. */
  count: number;
  source: DemandTermSource;
  /**
   * Sold-versus-active frequency lift. 1.0 means the term is equally common in
   * both, above 1 means it is over-represented among items that sold. Set only
   * by mineDemandTermsWithLift; the single-corpus miner leaves it undefined
   * because it has nothing to compare against.
   */
  lift?: number;
}

/**
 * Mine the most-recurring significant single words and adjacent bigrams from a
 * set of eBay listing titles. Frequency across titles is the demand proxy: a
 * term many sellers use for this brand/category is a term buyers search.
 *
 * Pure: no I/O. Returns terms ranked by recurrence (desc), then by length
 * (longer = more specific) for stable, deterministic ordering.
 */
function seedSet(seedTerms: string[] | undefined): Set<string> {
  const seeds = new Set<string>();
  for (const s of seedTerms ?? []) {
    for (const tok of tokenize(s)) seeds.add(tok);
  }
  return seeds;
}

interface Frequencies {
  /** term key -> number of TITLES it appeared in. */
  counts: Map<string, number>;
  /** term key -> a representative display form. */
  display: Map<string, string>;
  /** Titles that carried at least one usable token. The lift denominator. */
  titles: number;
}

/**
 * Document frequency over a corpus of titles: each term counted ONCE per title,
 * not per occurrence, so one keyword-stuffed listing cannot dominate.
 *
 * Extracted in US-2675 because the lift miner needs the same counts over two
 * corpora, and counting sold titles differently from active ones would make the
 * ratio between them meaningless.
 */
function documentFrequencies(titles: string[], seeds: Set<string>): Frequencies {
  const counts = new Map<string, number>();
  const display = new Map<string, string>();
  let counted = 0;

  for (const title of titles) {
    if (typeof title !== "string" || !title.trim()) continue;
    counted++;
    const lowerTokens = tokenize(title);
    const seenInTitle = new Set<string>();

    const consider = (key: string, shown: string) => {
      if (seenInTitle.has(key)) return;
      seenInTitle.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!display.has(key)) display.set(key, shown);
    };

    for (let i = 0; i < lowerTokens.length; i++) {
      const tok = lowerTokens[i]!;
      if (isSignificant(tok, seeds)) consider(tok, tok);
      // Adjacent bigram, e.g. "air max", "track jacket". Skip if either half is
      // a stopword/seed so we don't surface "the jacket" or re-emit the brand.
      const next = lowerTokens[i + 1];
      if (
        next &&
        isSignificant(tok, seeds) &&
        isSignificant(next, seeds)
      ) {
        const bigram = `${tok} ${next}`;
        consider(bigram, bigram);
      }
    }
  }

  return { counts, display, titles: counted };
}

export function mineDemandTerms(
  titles: string[],
  opts: MineDemandOptions = {},
): DemandTerm[] {
  const max = opts.max ?? 12;
  const minCount = opts.minCount ?? 2;
  const source = opts.source ?? "active";
  const { counts, display } = documentFrequencies(titles, seedSet(opts.seedTerms));

  const ranked: DemandTerm[] = [];
  for (const [key, count] of counts) {
    if (count < minCount) continue;
    ranked.push({ term: display.get(key) ?? key, count, source });
  }
  ranked.sort((a, b) =>
    b.count - a.count ||
    b.term.length - a.term.length ||
    (a.term < b.term ? -1 : a.term > b.term ? 1 : 0)
  );
  return ranked.slice(0, Math.max(0, max));
}

// ── US-2675: sold-versus-active lift ───────────────────────────────────────
//
// The original miner ranked by how often a term appears in ACTIVE listings,
// which measures what other sellers wrote, not what buyers bought. Active
// listings are the ones that have NOT sold; ranking by them optimises a title
// toward the wording of unsold inventory.
//
// Lift fixes the direction by dividing one document frequency by the other. A
// term over-represented among titles that actually sold scores above 1; a term
// only sellers use scores below it. The absolute frequency stops being the
// ranking signal and becomes a floor (minCount), which is what keeps a term
// that appeared in one lucky sale out of the list.

/**
 * Additive smoothing applied to BOTH rates before dividing.
 *
 * Without it a term absent from active titles divides by zero, and with a rate
 * that small the ratio is dominated by sampling noise: one appearance in a
 * 5-title corpus would outrank a term in 40 of 50 sold titles. 0.05 means a
 * term must clear roughly one-in-twenty presence before the ratio moves much,
 * which is about the resolution these corpora actually have.
 */
export const LIFT_SMOOTHING = 0.05;

export interface MineDemandLiftOptions extends MineDemandOptions {
  /**
   * Below this many usable sold titles the lift is not computed at all and the
   * result falls back to ranking active titles. Default MIN_SOLD_COMPS, the
   * same floor the pricing path uses to decide sold data is trustworthy.
   */
  minSoldTitles?: number;
  /** Override the smoothing constant. Tests use it; callers should not. */
  smoothing?: number;
}

/**
 * Rank terms by how much more common they are in SOLD titles than in ACTIVE
 * ones.
 *
 * Pure: no I/O, no clock, no randomness. Given the same two title arrays it
 * returns the same list in the same order.
 *
 * Falls back to the active-only ranking when there are too few sold titles to
 * divide by, and says so through each term's `source` -- a caller that cannot
 * tell which of the two happened would be reporting sold-backed confidence it
 * does not have.
 */
export function mineDemandTermsWithLift(
  soldTitles: string[],
  activeTitles: string[],
  opts: MineDemandLiftOptions = {},
): DemandTerm[] {
  const max = opts.max ?? 12;
  const minCount = opts.minCount ?? 2;
  const minSold = opts.minSoldTitles ?? MIN_SOLD_COMPS;
  const smoothing = opts.smoothing ?? LIFT_SMOOTHING;
  const seeds = seedSet(opts.seedTerms);

  const sold = documentFrequencies(soldTitles, seeds);

  // AC4: too little realized data to divide by, so do not pretend to. The
  // caller gets exactly the pre-US-2675 answer, labelled "active" so nothing
  // downstream can mistake it for sold-backed.
  if (sold.titles < minSold) {
    return mineDemandTerms(activeTitles, { ...opts, source: "active" });
  }

  const active = documentFrequencies(activeTitles, seeds);

  const soldRate = (key: string) => (sold.counts.get(key) ?? 0) / sold.titles;
  const activeRate = (key: string) =>
    active.titles === 0 ? 0 : (active.counts.get(key) ?? 0) / active.titles;

  const ranked: DemandTerm[] = [];
  for (const key of new Set([...sold.counts.keys(), ...active.counts.keys()])) {
    const soldCount = sold.counts.get(key) ?? 0;
    const activeCount = active.counts.get(key) ?? 0;
    // The one-off floor still applies, per corpus rather than summed: two
    // corpora each seeing a term once is still two coincidences.
    if (soldCount < minCount && activeCount < minCount) continue;

    const lift = (soldRate(key) + smoothing) / (activeRate(key) + smoothing);
    const source: DemandTermSource = soldCount > 0 ? "sold" : "active";
    ranked.push({
      term: sold.display.get(key) ?? active.display.get(key) ?? key,
      // The count in the corpus the term is being CREDITED to, so a reader
      // comparing count against source is not comparing two different things.
      count: source === "sold" ? soldCount : activeCount,
      source,
      lift,
    });
  }

  ranked.sort((a, b) =>
    (b.lift ?? 0) - (a.lift ?? 0) ||
    b.count - a.count ||
    b.term.length - a.term.length ||
    (a.term < b.term ? -1 : a.term > b.term ? 1 : 0)
  );
  return ranked.slice(0, Math.max(0, max));
}

/**
 * Convenience: just the term strings (highest demand first).
 */
export function mineDemandTermsFromTitles(
  titles: string[],
  opts: MineDemandOptions = {},
): string[] {
  return mineDemandTerms(titles, opts).map((t) => t.term);
}

export interface DemandTermArgs {
  brand?: string | null;
  categoryId?: string | null;
  // Extra query hint (e.g. the item's current title or a style code).
  query?: string | null;
  size?: string | null;
  conditionId?: string;
  max?: number;
}

/**
 * Fetch live eBay demand terms for an item's brand/category by mining the
 * titles of current active comps. NON-THROWING: returns [] on any error (no
 * Browse access, no signal, network failure) so listing generation proceeds
 * with the model's own knowledge.
 *
 * Free of Anthropic cost — this is one Browse (app-token) call, the same family
 * of call the comp-pricing step already makes.
 */
export async function getEbaySearchDemandTerms(
  args: DemandTermArgs,
): Promise<string[]> {
  return (await getEbaySearchDemandTermsDetailed(args)).map((t) => t.term);
}

/**
 * The same fetch, keeping the source and lift on each term (US-2675).
 *
 * Prefer this. `getEbaySearchDemandTerms` flattens to strings for the prompt,
 * where the model only needs the words, but anything that SHOWS a term to a
 * seller should say whether it came from items that sold.
 *
 * Both comp fetches are independently non-throwing, so one failing degrades the
 * answer instead of removing it: no sold data falls back to active ranking, and
 * no active data still lets sold terms through with a neutral lift.
 */
export async function getEbaySearchDemandTermsDetailed(
  args: DemandTermArgs,
): Promise<DemandTerm[]> {
  const brand = args.brand?.trim() || undefined;
  const query = args.query?.trim() || undefined;
  const q = [brand, query].filter(Boolean).join(" ").trim();
  // Need at least a query or a category to search Browse meaningfully.
  if (!q && !args.categoryId) return [];

  const seedTerms = [brand, query, args.size].filter(Boolean) as string[];
  const max = args.max ?? 12;

  const activeTitles = await (async () => {
    try {
      const res = await searchBrowseComps({
        categoryId: args.categoryId ?? undefined,
        q: q || undefined,
        brand,
        size: args.size ?? undefined,
        conditionId: args.conditionId,
        limit: 50,
      });
      return res.items.map((i) => i.title);
    } catch (err) {
      console.error(
        "[Demand Terms] active comp fetch fallback:",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  })();

  // getRealizedCompTitles is non-throwing by its own contract and needs a
  // category, which Browse does not.
  const soldTitles = args.categoryId
    ? await getRealizedCompTitles({
      categoryId: args.categoryId,
      q: q || undefined,
      brand,
      size: args.size ?? undefined,
      conditionId: args.conditionId,
    })
    : [];

  if (activeTitles.length === 0 && soldTitles.length === 0) return [];

  return mineDemandTermsWithLift(soldTitles, activeTitles, { seedTerms, max });
}

// ── US-546 (AC3): A/B title-variant sell-through summary ───────────────────
//
// AutoLister stores up to two title variants per listing (the chosen title =
// "A", the model's optional alternate = "B"; see ai-listing.ts). To later
// promote the better-converting wording we need a sell-through readout per
// variant label. This pure summarizer rolls a set of listing rows up into
// per-label totals/sold/sell-through so a report (or an auto-promotion job) can
// pick a winner. Full experiment auto-switching is a follow-up; this is the
// tracked-to-sell-through foundation the AC asks for.

export interface TitleVariant {
  label: string; // "A" | "B"
  title: string;
  active?: boolean;
}

export interface VariantSellThroughRow {
  // The label that was LIVE for this listing (the active variant).
  activeLabel: string;
  // Whether the listing sold.
  sold: boolean;
}

export interface VariantSellThrough {
  label: string;
  listings: number;
  sold: number;
  sellThrough: number; // 0..1
}

export function summarizeTitleVariantSellThrough(
  rows: VariantSellThroughRow[],
): VariantSellThrough[] {
  const byLabel = new Map<string, { listings: number; sold: number }>();
  for (const r of rows) {
    const label = (r.activeLabel || "A").trim() || "A";
    const agg = byLabel.get(label) ?? { listings: 0, sold: 0 };
    agg.listings += 1;
    if (r.sold) agg.sold += 1;
    byLabel.set(label, agg);
  }
  const out: VariantSellThrough[] = [];
  for (const [label, agg] of byLabel) {
    out.push({
      label,
      listings: agg.listings,
      sold: agg.sold,
      sellThrough: agg.listings > 0 ? agg.sold / agg.listings : 0,
    });
  }
  out.sort((a, b) => b.sellThrough - a.sellThrough || (a.label < b.label ? -1 : 1));
  return out;
}

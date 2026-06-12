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
}

export interface DemandTerm {
  term: string;
  count: number;
}

/**
 * Mine the most-recurring significant single words and adjacent bigrams from a
 * set of eBay listing titles. Frequency across titles is the demand proxy: a
 * term many sellers use for this brand/category is a term buyers search.
 *
 * Pure: no I/O. Returns terms ranked by recurrence (desc), then by length
 * (longer = more specific) for stable, deterministic ordering.
 */
export function mineDemandTerms(
  titles: string[],
  opts: MineDemandOptions = {},
): DemandTerm[] {
  const max = opts.max ?? 12;
  const minCount = opts.minCount ?? 2;
  const seeds = new Set<string>();
  for (const s of opts.seedTerms ?? []) {
    for (const tok of tokenize(s)) seeds.add(tok);
  }

  // Count each term ONCE per title (document frequency), not per occurrence, so
  // a single keyword-stuffed title can't dominate the ranking.
  const counts = new Map<string, number>();
  // Preserve a representative original-cased form for display.
  const display = new Map<string, string>();

  for (const title of titles) {
    if (typeof title !== "string" || !title.trim()) continue;
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

  const ranked: DemandTerm[] = [];
  for (const [key, count] of counts) {
    if (count < minCount) continue;
    ranked.push({ term: display.get(key) ?? key, count });
  }
  ranked.sort((a, b) =>
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
  const brand = args.brand?.trim() || undefined;
  const query = args.query?.trim() || undefined;
  const q = [brand, query].filter(Boolean).join(" ").trim();
  // Need at least a query or a category to search Browse meaningfully.
  if (!q && !args.categoryId) return [];

  try {
    const res = await searchBrowseComps({
      categoryId: args.categoryId ?? undefined,
      q: q || undefined,
      brand,
      size: args.size ?? undefined,
      conditionId: args.conditionId,
      limit: 50,
    });
    return mineDemandTermsFromTitles(
      res.items.map((i) => i.title),
      { seedTerms: [brand, query, args.size].filter(Boolean) as string[], max: args.max ?? 12 },
    );
  } catch (err) {
    console.error(
      "[Demand Terms] getEbaySearchDemandTerms fallback:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
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

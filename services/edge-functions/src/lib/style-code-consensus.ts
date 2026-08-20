// US-2691: the product name a style code's listings AGREE on.
//
// US-2246 stores every title the market gave a code and reads back the single
// most-confirmed one, trimmed word by word (styleNameFromTitle). One seller's
// title is not a product name: it carries their colourway, their inseam, their
// condition abbreviation and whatever they think helps them rank. Trimming it
// produces a plausible string that is nobody's product.
//
// What IS a product name is the run of words that MOST of the titles share.
// "Commission Short Relaxed Warpstreme" survives across sellers; "Dark Olive 34
// EUC" does not. So: clean each title down to product words, then find the
// longest contiguous run present in a majority of them.
//
// Pure. No database, no eBay, no clock — the whole point is that the rule is
// checkable against fixture titles.

import {
  isSizeToken,
  normalizeTitleToken,
  TITLE_COLOR_TOKENS,
  TITLE_FILLER_TOKENS,
  TITLE_LISTING_CHATTER,
} from "./title-tokens.ts";
import { normalizeStyleCode } from "./style-code-observations.ts";

/** Below this many distinct titles there is nothing to agree. Two titles that
 *  match are a coincidence as easily as a consensus. */
export const CONSENSUS_MIN_TITLES = 3;

/** Fraction of distinct titles that must carry a run for it to be the name. */
export const CONSENSUS_MAJORITY = 0.6;

/** A name shorter than this is not an identification ("Short" is not a product);
 *  longer than this is a title, not a name. */
export const CONSENSUS_MIN_WORDS = 2;
export const CONSENSUS_MAX_WORDS = 6;

/**
 * The ceiling on a consensus name's confidence.
 *
 * Strictly below every seeded decoder confidence, which is the ordering that
 * matters: a decoder read the code off the tag, and no amount of market
 * agreement outranks the garment itself. It IS above LEARNED_CONFIDENCE_CAP,
 * because a run of words eight independent sellers used is a different class of
 * evidence from one title trimmed by regex.
 */
export const CONSENSUS_CONFIDENCE_CAP = 0.75;

/** Where the curve starts, at exactly CONSENSUS_MIN_TITLES supporters. */
export const CONSENSUS_CONFIDENCE_BASE = 0.5;

/** Per additional supporting title. */
const CONSENSUS_CONFIDENCE_STEP = 0.05;

export interface ConsensusName {
  /** Display-cased, as the supporting titles spell it. */
  name: string;
  /** Distinct titles carrying the winning run. */
  supporting: number;
  /** Distinct titles considered. */
  considered: number;
  /** Derived from `supporting`, capped. */
  confidence: number;
}

interface CleanedTitle {
  /** Lowercased comparison tokens. */
  tokens: string[];
  /** The same words as the seller spelled them, for display. */
  display: string[];
}

/**
 * Reduce a listing title to the words that could name a product: drop the
 * brand, the code itself, colours, sizes, condition grades, gender and filler.
 *
 * Bare one- and two-digit numbers go too. On a Lululemon listing those are the
 * size and the inseam ("Commission Short 11 34"), and keeping them would put a
 * different number in the middle of every seller's copy of the same name, which
 * is exactly what breaks a contiguous run. Three-digit-and-longer runs stay —
 * 501 and 5950 ARE products.
 */
export function cleanTitleForNaming(
  title: string,
  brand: string | null | undefined,
  styleCode: string | null | undefined,
): CleanedTitle {
  const codeNorm = normalizeStyleCode(styleCode);
  const brandTokens = new Set(
    (brand ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );

  const tokens: string[] = [];
  const display: string[] = [];
  for (const rawWord of title.split(/\s+/)) {
    const tok = normalizeTitleToken(rawWord);
    if (!tok) continue;
    if (brandTokens.has(tok)) continue;
    if (codeNorm && normalizeStyleCode(tok) === codeNorm) continue;
    if (TITLE_FILLER_TOKENS.has(tok)) continue;
    if (TITLE_COLOR_TOKENS.has(tok)) continue;
    if (TITLE_LISTING_CHATTER.has(tok)) continue;
    if (isSizeToken(tok)) continue;
    if (/^\d{1,2}$/.test(tok)) continue;
    tokens.push(tok);
    display.push(rawWord.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""));
  }
  return { tokens, display };
}

/** How many distinct titles a run must appear in. Always at least two. */
export function consensusThreshold(titleCount: number): number {
  return Math.max(2, Math.ceil(CONSENSUS_MAJORITY * titleCount));
}

/**
 * Confidence for a consensus name. Rises with independent supporters and
 * flattens at the cap, so no amount of agreement promotes market chatter to the
 * standing of a decoder read off the tag.
 */
export function consensusConfidence(supporting: number): number {
  const extra = Math.max(0, supporting - CONSENSUS_MIN_TITLES);
  const value = CONSENSUS_CONFIDENCE_BASE + CONSENSUS_CONFIDENCE_STEP * extra;
  return Math.min(CONSENSUS_CONFIDENCE_CAP, Math.round(value * 100) / 100);
}

/**
 * The product name a code's titles agree on, or null.
 *
 * Null is a real answer and the common one early on. Returning a best guess
 * from two titles would put a name on a listing that no seller and no decoder
 * ever supported, which is worse than the honest blank the seller can fill in.
 */
export function consensusStyleName(args: {
  titles: readonly string[];
  brand?: string | null;
  styleCode?: string | null;
}): ConsensusName | null {
  // Exact duplicates are ONE piece of evidence. Sellers copy each other's
  // titles verbatim, and three copies of one string is one seller's opinion
  // repeated, not three sellers agreeing.
  const seen = new Set<string>();
  const cleaned: CleanedTitle[] = [];
  for (const title of args.titles) {
    const key = title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const c = cleanTitleForNaming(title, args.brand, args.styleCode);
    if (c.tokens.length >= CONSENSUS_MIN_WORDS) cleaned.push(c);
  }

  const considered = cleaned.length;
  if (considered < CONSENSUS_MIN_TITLES) return null;

  const threshold = consensusThreshold(considered);
  const longest = Math.min(
    CONSENSUS_MAX_WORDS,
    Math.max(...cleaned.map((c) => c.tokens.length)),
  );

  // Longest run wins, so walk down from the longest possible.
  for (let n = longest; n >= CONSENSUS_MIN_WORDS; n--) {
    const support = new Map<string, Set<number>>();
    cleaned.forEach((c, titleIndex) => {
      for (let i = 0; i + n <= c.tokens.length; i++) {
        const run = c.tokens.slice(i, i + n).join(" ");
        let carriers = support.get(run);
        if (!carriers) support.set(run, (carriers = new Set()));
        carriers.add(titleIndex);
      }
    });

    let bestRun: string | null = null;
    let bestCount = 0;
    for (const [run, carriers] of support) {
      if (carriers.size < threshold) continue;
      // Most-supported wins; lexicographic breaks a tie so the same input
      // always produces the same name.
      if (
        carriers.size > bestCount ||
        (carriers.size === bestCount && bestRun !== null && run < bestRun)
      ) {
        bestRun = run;
        bestCount = carriers.size;
      }
    }
    if (!bestRun) continue;

    return {
      name: displayFor(bestRun, cleaned) ?? titleCase(bestRun),
      supporting: bestCount,
      considered,
      confidence: consensusConfidence(bestCount),
    };
  }

  return null;
}

/** The winning run as the first supporting seller spelled it. */
function displayFor(run: string, cleaned: readonly CleanedTitle[]): string | null {
  const want = run.split(" ");
  for (const c of cleaned) {
    for (let i = 0; i + want.length <= c.tokens.length; i++) {
      if (c.tokens.slice(i, i + want.length).join(" ") === run) {
        return c.display.slice(i, i + want.length).join(" ");
      }
    }
  }
  return null;
}

function titleCase(run: string): string {
  return run
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

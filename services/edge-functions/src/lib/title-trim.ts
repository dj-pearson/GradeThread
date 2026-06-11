// US-546: keyword-priority title trimming for eBay (and other marketplace)
// listing titles. eBay caps titles at 80 characters; the previous behaviour was
// a blind `title.slice(0, 80)`, which could cut a word in half ("...Vinta") and
// strand a dangling separator. That reads badly and hurts search relevance.
//
// eBay title best-practice puts the highest-value keywords FIRST (brand → item
// type → size/colour → modifiers), so dropping whole words from the END trims
// the lowest-priority terms while keeping the words that actually rank. This
// module does word-boundary trimming that never slices mid-word and never
// leaves a trailing separator.
//
// Pure + dependency-free so it's unit-testable without any eBay/AI calls.

export const EBAY_TITLE_MAX = 80;

// Characters we never want a trimmed title to END on (dangling separators /
// open punctuation left behind when the following word is dropped).
const TRAILING_JUNK = /[\s\-–—_/|,;:.&+(\[{<"'`]+$/u;

// Collapse runs of whitespace to single spaces and trim the ends. eBay ignores
// extra whitespace but it wastes characters against the 80-char budget.
export function normalizeTitleWhitespace(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/**
 * Trim a title to `limit` characters on word boundaries, preserving the
 * highest-priority (leading) keywords and never cutting a word in half.
 *
 * Algorithm:
 *  1. Normalize whitespace.
 *  2. If it already fits, return as-is.
 *  3. Greedily keep whole words from the front until the next word would
 *     overflow the limit, then stop — the dropped trailing words are the
 *     lowest-priority terms.
 *  4. Strip any dangling separator left at the new end.
 *  5. Edge case: if even the FIRST word is longer than the limit (no boundary
 *     to break on), hard-slice that single word so we still emit something
 *     within the limit rather than an empty string.
 */
export function trimTitleToLimit(
  title: string,
  limit: number = EBAY_TITLE_MAX,
): string {
  const normalized = normalizeTitleWhitespace(title);
  if (normalized.length <= limit) return normalized;

  const words = normalized.split(" ");
  let out = "";
  for (const word of words) {
    // +1 for the joining space once we already have content.
    const candidate = out ? `${out} ${word}` : word;
    if (candidate.length > limit) break;
    out = candidate;
  }

  // No whole word fit (first token already exceeds the limit) → hard-slice it.
  if (!out) return normalized.slice(0, limit).replace(TRAILING_JUNK, "");

  return out.replace(TRAILING_JUNK, "");
}

/**
 * Detail about how a title was trimmed, so callers can decide whether to warn
 * the seller (e.g. "12 keywords dropped to fit eBay's 80-char limit") or feed
 * the dropped terms into the item description instead.
 */
export interface TitleTrimResult {
  /** The final title, within the limit and word-boundary clean. */
  title: string;
  /** True when characters/words were removed to fit. */
  trimmed: boolean;
  /** Whole words dropped off the end (lowest-priority keywords), in order. */
  droppedWords: string[];
}

export function trimTitleWithReport(
  title: string,
  limit: number = EBAY_TITLE_MAX,
): TitleTrimResult {
  const normalized = normalizeTitleWhitespace(title);
  const trimmedTitle = trimTitleToLimit(normalized, limit);
  if (trimmedTitle === normalized) {
    return { title: trimmedTitle, trimmed: false, droppedWords: [] };
  }

  // Recover the dropped words by diffing the kept prefix against the original
  // word list. The kept title is always a whitespace-clean prefix of the
  // normalized title (except the single-giant-word hard-slice case, where there
  // are no whole "dropped words" to report).
  const keptWordCount = trimmedTitle.split(" ").filter(Boolean).length;
  const allWords = normalized.split(" ");
  const droppedWords =
    normalized.startsWith(trimmedTitle) && trimmedTitle.includes(" ")
      ? allWords.slice(keptWordCount)
      : allWords.slice(1); // hard-slice case: everything after the first token

  return { title: trimmedTitle, trimmed: true, droppedWords };
}

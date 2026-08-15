// US-2613: the certificate title must not carry the claim it exists to replace.
//
// THE OBSERVATION. A live, indexed certificate rendered as:
//
//   "Chiara Boni La Petite Robe Camel Off-Shoulder Sheath Dress Made in Italy
//    NWT — Grade 9.2 (NWOT)"
//
// NWT is New With Tags. NWOT is New Without Tags. The seller says the tags are
// attached, our grade says they are not, and both sit in the <title>, the
// og:title and therefore in the search snippet and every social preview. The
// certificate is the artefact that replaces an unverifiable adjective with a
// verified number; publishing both, adjacent, hands the reader a reason to
// trust neither.
//
// THE RULE (owner, 2026-08-15): strip recognised condition claims from the
// seller's title when composing OUR title. The body still shows what the seller
// wrote — this is a presentation rule on our page, not an edit to their
// listing, and nothing is rewritten in the database.
//
// STRIPPED UNCONDITIONALLY, not only when it disagrees. Two reasons. A claim
// that happens to AGREE is still the seller's unverified word sitting where our
// verified number goes, and it makes the title longer for no information. And a
// rule that fires only on disagreement is a rule whose behaviour depends on the
// grade, so the same listing reads differently at 9.2 and 9.6 — which is a
// worse thing to explain than "we state the condition once, and it is ours".

/**
 * Whole-word condition claims sellers put in listing titles.
 *
 * Matched as WHOLE WORDS, which is the whole difficulty: "NIB" appears inside
 * nothing useful, but a naive substring pass would eat the "euc" in a brand and
 * the "gu" in Gucci. Ordered longest-first so "new with tags" is consumed
 * before the bare "new" that follows it.
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  // Phrases first — a phrase contains words that also appear alone below.
  /\bbrand[\s-]?new\s+with\s+tags\b/gi,
  /\bnew\s+with(?:out)?\s+tags\b/gi,
  /\bnever\s+(?:worn|used)\b/gi,
  /\blike[\s-]?new\b/gi,
  /\bbrand[\s-]?new\b/gi,
  /\bgently\s+used\b/gi,
  /\bpre[\s-]?owned\b/gi,
  // Abbreviations. BNWT/BNWOT before NWT/NWOT for the same reason.
  /\bbnwot\b/gi,
  /\bbnwt\b/gi,
  /\bnwot\b/gi,
  /\bnwt\b/gi,
  /\bvguc\b/gi,
  /\beuc\b/gi,
  /\bguc\b/gi,
  /\bnib\b/gi,
  /\bdeadstock\b/gi,
  /\bds\b/gi,
];

/**
 * The seller's title with condition claims removed, tidied for display.
 *
 * NEVER returns empty. A title that is nothing but a condition claim ("NWT")
 * would otherwise leave the certificate with a bare "— Grade 9.2 (NWOT)", which
 * is worse than the contradiction it fixes: the reader loses the garment
 * entirely. In that case the original is returned unchanged and the grade suffix
 * carries the meaning.
 */
export function certDisplayTitle(sellerTitle: string): string {
  const original = String(sellerTitle ?? "");
  let out = original;
  for (const re of CLAIM_PATTERNS) out = out.replace(re, " ");

  // ORDER MATTERS, and getting it wrong is how "Coach · NWT · Tabby Bag"
  // becomes "Coach Tabby Bag" instead of "Coach · Tabby Bag". Collapse a RUN of
  // separators down to one first — the seller put a separator between brand and
  // model and that structure should survive — and only then remove the ones
  // left dangling at an end, which carry nothing.
  out = out
    // "Coach ·  · Tabby" → "Coach · Tabby". Repeated because three separators
    // in a row collapse pairwise.
    .replace(/([,;:·|—–-])(?:\s*[,;:·|—–-])+/g, "$1")
    .replace(/^[\s,;:·|—–-]+|[\s,;:·|—–-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Empty, or reduced to punctuation — keep what the seller wrote.
  return /[\p{L}\p{N}]/u.test(out) ? out : original.trim();
}

/**
 * Whether stripping changed anything. Exposed so a caller can log or test the
 * interesting case without re-deriving it.
 */
export function hasConditionClaim(sellerTitle: string): boolean {
  return certDisplayTitle(sellerTitle) !== String(sellerTitle ?? "").trim();
}

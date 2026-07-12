// US-1890: server-side eBay title policy/quality lint, shared by the publish
// pre-flight (blocks policy violations) and the composer meter (US-1892 warnings).
//
// eBay's title is the primary retrieval surface. Two classes of finding:
//   • POLICY VIOLATIONS (blockers): unrelated-brand comparison phrases ("style
//     of <brand>", "similar to <brand>") are keyword-spam / search-manipulation
//     that eBay prohibits for clothing — these must BLOCK publish.
//   • WARNINGS (non-blocking): duplicate keywords (no ranking benefit per eBay),
//     ALL-CAPS shouting (outside a brand-acronym / size allowlist), and
//     promotional filler (L@@K / WOW / !!!) that wastes the 80-char budget.
//
// Pure + dependency-free so it's unit-testable without any eBay/AI calls.

export interface TitleLintResult {
  /** eBay policy violations — publish BLOCKERS (search-manipulation, etc.). */
  policyViolations: string[];
  /** Non-blocking title-quality warnings surfaced to the seller. */
  warnings: string[];
}

// Tokens that are legitimately upper-case in a title, so ALL-CAPS shouting
// detection doesn't flag condition tags, sizes, or well-known brand acronyms.
const ALLCAPS_ALLOWLIST = new Set<string>([
  // Condition / listing tags
  "NWT", "NWOT", "NIB", "BNWT", "EUC", "VGUC", "GUC", "OOAK", "HTF",
  // Sizes / fit
  "XXS", "XS", "SM", "MD", "LG", "XL", "XXL", "XXXL", "OS", "OSFA", "REG",
  // Regions / origin
  "USA", "US", "UK", "EU", "EUR", "JP",
  // Common brand acronyms that ARE upper-case
  "DKNY", "BCBG", "APC", "YSL", "LV", "CK", "RRL", "MK", "UGG", "TNF",
  "AE", "AEO", "PJ", "GAP", "HM", "COS", "NB", "KSNY",
  // Roman-numeral series markers
  "II", "III", "IV", "VI", "VII", "VIII", "IX",
]);

// Promotional filler eBay guidance says to drop (it wastes the retrieval
// surface and reads as spam). Case-insensitive.
const FILLER_PATTERNS: RegExp[] = [
  /l@@k/i,
  /l00k/i,
  /\bwow\b/i,
  /!{2,}/,
  /\bmust\s*see\b/i,
  /[★☆✩✪➤»«▶◀¡]/,
];

// Unrelated-brand comparison / "sounds like" phrases — a search-manipulation
// policy violation for clothing (hijacking another brand's search traffic).
// Kept high-precision so a false BLOCKER can't wrongly stop a publish: the
// benign "fits like a glove/dream" is explicitly excluded.
const BRAND_COMPARISON_PATTERNS: RegExp[] = [
  /\bstyle\s+of\b/i,
  /\bin\s+the\s+style\s+of\b/i,
  /\bsimilar\s+to\b/i,
  /\bcompared?\s+to\b/i,
  /\binspired\s+by\b/i,
  /\bfits?\s+like\s+(?!a\b|an\b|new\b|glove\b|dream\b)/i,
];

/** Split a title into comparable word tokens (lowercased, punctuation-stripped). */
function tokenize(title: string): string[] {
  return title
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase())
    .filter((w) => w.length > 0);
}

/**
 * Lint an eBay title. Pure; the caller decides how to surface each bucket
 * (publish blocks on `policyViolations`, warns on `warnings`).
 */
export function lintTitle(rawTitle: string): TitleLintResult {
  const title = (rawTitle ?? "").trim();
  const policyViolations: string[] = [];
  const warnings: string[] = [];
  if (!title) return { policyViolations, warnings };

  // Policy: unrelated-brand comparison phrases.
  for (const re of BRAND_COMPARISON_PATTERNS) {
    const m = title.match(re);
    if (m) {
      policyViolations.push(
        `Remove the comparison phrase "${m[0].trim()}" — comparing to another ` +
          `brand in the title violates eBay's search-manipulation policy.`,
      );
      break; // one policy blocker is enough to convey the fix
    }
  }

  // Warning: promotional filler.
  for (const re of FILLER_PATTERNS) {
    const m = title.match(re);
    if (m) {
      warnings.push(
        `Drop promotional filler ("${m[0]}") — it wastes the 80-character search surface.`,
      );
      break;
    }
  }

  // Warning: duplicate keyword tokens (no ranking benefit per eBay).
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const tok of tokenize(title)) {
    if (tok.length < 2) continue; // ignore single chars / stray punctuation
    if (seen.has(tok)) dupes.add(tok);
    seen.add(tok);
  }
  if (dupes.size > 0) {
    warnings.push(
      `Duplicate keyword${dupes.size > 1 ? "s" : ""} (${[...dupes].join(", ")}) ` +
        `add no ranking benefit — replace with a new qualifier.`,
    );
  }

  // Warning: ALL-CAPS shouting outside the acronym/size allowlist.
  const shouted = new Set<string>();
  for (const word of title.split(/\s+/)) {
    // Strip only leading/trailing punctuation — a word with INTERNAL symbols
    // (L@@K) is filler, handled above, not an ALL-CAPS word.
    const bare = word.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (/^[A-Z]{2,}$/.test(bare) && !ALLCAPS_ALLOWLIST.has(bare)) {
      shouted.add(bare);
    }
  }
  if (shouted.size > 0) {
    warnings.push(
      `Avoid ALL-CAPS word${shouted.size > 1 ? "s" : ""} (${[...shouted].join(", ")}) — ` +
        `use title case; caps read as shouting and don't help search.`,
    );
  }

  return { policyViolations, warnings };
}

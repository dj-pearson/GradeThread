// US-1892: composer title quality meter + pack-to-80 suggestions.
//
// eBay's 80-char title is the primary retrieval surface. This pure module
// powers the composer's title meter (utilization band, brand-first check,
// policy/quality lint) and the one-click "pack the title" chips, and flags weak
// titles in bulk autolister sessions. No AI, no network — fully unit-testable.
//
// The lint rules mirror the edge publish-preflight lint (services/edge-functions
// /src/lib/title-lint.ts, US-1890) so the composer WARNS on exactly what publish
// BLOCKS/warns on. Edge and web run as separate projects and can't import each
// other, so keep the two definitions in LOCKSTEP (same convention as the
// IMAGE_TYPES / STYLE_ATTRIBUTES mirrors).

export const TITLE_MAX = 80;

// US-2680 REMOVED TITLE_GREEN_MIN, and the reason is worth keeping.
//
// This file used to paint 70–80 characters green, citing the ranking playbook.
// The playbook §2 says the opposite: "70-80 characters" is listed there as
// VENDOR LORE, not an eBay statement, and listing-quality-score.ts had already
// refused to score length for exactly that reason. So the two surfaces
// disagreed, and the composer — the one a seller actually reads while typing —
// was the one teaching the wrong lesson: pad until the bar goes green.
//
// Padding is not free. The characters go somewhere, and what they usually carry
// is a word the item specifics already hold, which eBay indexes from the
// structured field anyway. A seller following the old meter spent their 80
// characters restating Brand and Size instead of adding a term nothing else
// carries.
//
// What the meter counts now is DISTINCT SEARCHABLE TERMS: words in the title
// that are not already carried by a filled item specific. That is defensible
// against the playbook, and it moves the seller toward the only thing a title
// can add — vocabulary the structured fields do not have.

/** Distinct searchable terms at or above which the meter reads green. */
export const TERM_GREEN_MIN = 6;
/** Below this a title is too thin to match many queries at all. */
export const TERM_WEAK_BELOW = 4;

// ── lint (LOCKSTEP mirror of edge title-lint.ts) ────────────────────────────

export interface TitleLintResult {
  /** eBay policy violations — publish BLOCKERS (search-manipulation, etc.). */
  policyViolations: string[];
  /** Non-blocking title-quality warnings. */
  warnings: string[];
}

const ALLCAPS_ALLOWLIST = new Set<string>([
  "NWT", "NWOT", "NIB", "BNWT", "EUC", "VGUC", "GUC", "OOAK", "HTF",
  "XXS", "XS", "SM", "MD", "LG", "XL", "XXL", "XXXL", "OS", "OSFA", "REG",
  "USA", "US", "UK", "EU", "EUR", "JP",
  "DKNY", "BCBG", "APC", "YSL", "LV", "CK", "RRL", "MK", "UGG", "TNF",
  "AE", "AEO", "PJ", "GAP", "HM", "COS", "NB", "KSNY",
  "II", "III", "IV", "VI", "VII", "VIII", "IX",
]);

const FILLER_PATTERNS: RegExp[] = [
  /l@@k/i,
  /l00k/i,
  /\bwow\b/i,
  /!{2,}/,
  /\bmust\s*see\b/i,
  /[★☆✩✪➤»«▶◀¡]/,
];

const BRAND_COMPARISON_PATTERNS: RegExp[] = [
  /\bstyle\s+of\b/i,
  /\bin\s+the\s+style\s+of\b/i,
  /\bsimilar\s+to\b/i,
  /\bcompared?\s+to\b/i,
  /\binspired\s+by\b/i,
  /\bfits?\s+like\s+(?!a\b|an\b|new\b|glove\b|dream\b)/i,
];

function tokenize(title: string): string[] {
  return title
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase())
    .filter((w) => w.length > 0);
}

export function lintTitle(rawTitle: string): TitleLintResult {
  const title = (rawTitle ?? "").trim();
  const policyViolations: string[] = [];
  const warnings: string[] = [];
  if (!title) return { policyViolations, warnings };

  for (const re of BRAND_COMPARISON_PATTERNS) {
    const m = title.match(re);
    if (m) {
      policyViolations.push(
        `Remove the comparison phrase "${m[0].trim()}" — comparing to another ` +
          `brand in the title violates eBay's search-manipulation policy.`,
      );
      break;
    }
  }

  for (const re of FILLER_PATTERNS) {
    const m = title.match(re);
    if (m) {
      warnings.push(
        `Drop promotional filler ("${m[0]}") — it wastes the 80-character search surface.`,
      );
      break;
    }
  }

  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const tok of tokenize(title)) {
    if (tok.length < 2) continue;
    if (seen.has(tok)) dupes.add(tok);
    seen.add(tok);
  }
  if (dupes.size > 0) {
    warnings.push(
      `Duplicate keyword${dupes.size > 1 ? "s" : ""} (${[...dupes].join(", ")}) ` +
        `add no ranking benefit — replace with a new qualifier.`,
    );
  }

  const shouted = new Set<string>();
  for (const word of title.split(/\s+/)) {
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

// ── utilization + brand-first ───────────────────────────────────────────────

/**
 * US-2680: there is no "good" length any more.
 *
 * The band says only whether the title is empty, within the 80-character cap,
 * or at/over it — a hard limit, which is a real eBay constraint, rather than a
 * target, which is not. A seller at 62 characters is not doing worse than one
 * at 74 and this type no longer implies they are.
 */
export type UtilizationBand = "empty" | "within" | "full";

export interface TitleUtilization {
  used: number;
  max: number;
  /** 0–100, capped at 100. A fill indicator, NOT a score. */
  pct: number;
  band: UtilizationBand;
}

export function titleUtilization(
  title: string,
  max: number = TITLE_MAX,
): TitleUtilization {
  const used = (title ?? "").trim().length;
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const band: UtilizationBand = used === 0 ? "empty" : used >= max ? "full" : "within";
  return { used, max, pct, band };
}

// ── US-2680: distinct searchable terms ─────────────────────────────────────

export type TermBand = "empty" | "thin" | "good";

export interface TitleTerms {
  /** Title words not already carried by a filled item specific. */
  distinct: string[];
  /** Title words a filled item specific already carries. Padding, in effect. */
  redundant: string[];
  count: number;
  band: TermBand;
}

/**
 * Words that occupy characters and add no retrievable meaning. Smaller than a
 * search stopword list on purpose: this one only needs to catch what a seller
 * types to fill space.
 */
const NON_SEARCHABLE = new Set<string>([
  "the", "and", "for", "with", "your", "you", "this", "that", "all",
  "in", "of", "to", "a", "an", "or", "by", "on", "at", "is", "it", "from",
  "size", "mens", "womens", "men", "women", "kids", "unisex",
  "great", "good", "excellent", "nice", "perfect", "look", "looks",
  "free", "shipping", "fast", "ship", "item", "items", "brand",
]);

/**
 * Count what the title adds that the structured fields do not.
 *
 * A word already sitting in a filled item specific is REDUNDANT here, not
 * wrong: eBay indexes the aspect, so repeating it in the title buys nothing and
 * costs characters. That is the whole mechanism by which the old
 * pad-to-70 advice made listings worse.
 */
export function titleTerms(
  title: string,
  aspects?: Record<string, string | string[] | null | undefined>,
): TitleTerms {
  const inAspects = new Set<string>();
  for (const value of Object.values(aspects ?? {})) {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    for (const v of values) {
      for (const token of tokenize(String(v))) inAspects.add(token);
    }
  }

  const seen = new Set<string>();
  const distinct: string[] = [];
  const redundant: string[] = [];
  for (const token of tokenize(title ?? "")) {
    if (token.length < 2 || NON_SEARCHABLE.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    if (inAspects.has(token)) redundant.push(token);
    else distinct.push(token);
  }

  const count = distinct.length;
  const band: TermBand = count === 0 ? "empty" : count >= TERM_GREEN_MIN ? "good" : "thin";
  return { distinct, redundant, count, band };
}

/**
 * True when the title leads with the brand (eBay CTR: front-load the brand).
 * A missing brand is treated as satisfied (nothing to front-load). Matches on a
 * word-boundary prefix so "Nike Air Max" passes for brand "Nike" but
 * "Vintage Nike Tee" does not.
 */
export function isBrandFirst(
  title: string,
  brand: string | null | undefined,
): boolean {
  const b = (brand ?? "").trim().toLowerCase();
  if (!b) return true;
  const t = (title ?? "").trim().toLowerCase();
  if (!t) return false;
  return t === b || t.startsWith(b + " ");
}

// ── pack-to-80 suggestions ──────────────────────────────────────────────────

export type SuggestionSource = "demand" | "aspect";

/**
 * US-2675: what a demand term's evidence actually is. "sold" means the term was
 * over-represented in titles of items that SOLD; "active" means it came only
 * from what other sellers are currently asking. Undefined means the draft
 * predates the distinction being recorded, which is not the same as "active".
 */
export type DemandEvidence = "ebay_search" | "sold" | "active";

/** A demand term that knows where it came from (listings.demand_terms_detail). */
export interface DemandTermInput {
  term: string;
  source?: DemandEvidence;
}

export interface PackSuggestion {
  /** The token to append (kept as-is for display; matched case-insensitively). */
  token: string;
  source: SuggestionSource;
  /** Only set for source === "demand", and only when the draft recorded it. */
  evidence?: DemandEvidence;
}

// High-value aspect names, in the order the playbook recommends surfacing them.
const HIGH_VALUE_ASPECTS = [
  "Material",
  "Pattern",
  "Style",
  "Decade",
  "Vintage",
  "Era",
  "Fit",
];

function normalize(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

// Is `token` already represented in the title? True if its normalized form
// matches an existing title token, so we never suggest a word already there.
function alreadyInTitle(titleTokens: Set<string>, token: string): boolean {
  const parts = token.split(/\s+/).map(normalize).filter((p) => p.length > 0);
  if (parts.length === 0) return true;
  // A multi-word token counts as present only if EVERY word is already there.
  return parts.every((p) => titleTokens.has(p));
}

export interface PackSuggestionsInput {
  title: string;
  /**
   * Mined demand terms for this listing (US-1890 demand-terms.ts), highest
   * first. Plain strings are the legacy `listings.demand_terms` shape; objects
   * are `demand_terms_detail` (US-2675) and carry their evidence through to
   * the chip.
   */
  demandTerms?: (string | DemandTermInput | null | undefined)[];
  /** Filled item specifics — name → value(s). Only high-value aspects are used. */
  aspects?: Record<string, string | string[] | null | undefined>;
  max?: number;
  /** Cap the number of chips returned (default 6). */
  limit?: number;
}

/**
 * Ranked append tokens NOT already in the title, each of which still fits within
 * the 80-char budget. Demand terms rank first, then high-value filled aspects in
 * playbook order. A chip that would overflow the limit is dropped (never a chip
 * that pushes past 80).
 */
export function packTitleSuggestions(
  input: PackSuggestionsInput,
): PackSuggestion[] {
  const max = input.max ?? TITLE_MAX;
  const limit = input.limit ?? 6;
  const title = (input.title ?? "").trim();
  const titleTokens = new Set(tokenize(title));
  const remaining = () =>
    max - (title.length === 0 ? 0 : title.length + 1); // +1 for the space

  const candidates: PackSuggestion[] = [];
  const pushed = new Set<string>();

  const consider = (
    raw: string | null | undefined,
    source: SuggestionSource,
    evidence?: DemandEvidence,
  ) => {
    const token = (raw ?? "").trim();
    if (!token) return;
    const key = token.toLowerCase();
    if (pushed.has(key)) return;
    if (alreadyInTitle(titleTokens, token)) return;
    candidates.push(evidence ? { token, source, evidence } : { token, source });
    pushed.add(key);
  };

  for (const term of input.demandTerms ?? []) {
    if (typeof term === "string" || term == null) consider(term, "demand");
    else consider(term.term, "demand", term.source);
  }

  if (input.aspects) {
    for (const name of HIGH_VALUE_ASPECTS) {
      // Case-insensitive aspect-name lookup.
      const key = Object.keys(input.aspects).find(
        (k) => k.toLowerCase() === name.toLowerCase(),
      );
      if (!key) continue;
      const val = input.aspects[key];
      const values = Array.isArray(val) ? val : val == null ? [] : [val];
      for (const v of values) consider(v, "aspect");
    }
  }

  // Greedily keep the highest-ranked candidates that still fit, simulating the
  // title growing as chips are appended (so the budget check is truthful).
  const out: PackSuggestion[] = [];
  let budget = remaining();
  for (const c of candidates) {
    if (out.length >= limit) break;
    const cost = c.token.length + (out.length === 0 && title.length === 0 ? 0 : 1);
    if (cost <= budget) {
      out.push(c);
      budget -= cost;
    }
  }
  return out;
}

// ── combined meter model ────────────────────────────────────────────────────

export interface TitleQuality {
  /** Characters used against the 80 cap. A hard limit, never a target (US-2680). */
  utilization: TitleUtilization;
  /** US-2680: what the title adds that the item specifics do not. */
  terms: TitleTerms;
  brandFirst: boolean;
  lint: TitleLintResult;
  suggestions: PackSuggestion[];
  /** Weak = too few distinct terms OR any lint finding — drives the bulk flag. */
  weak: boolean;
}

export interface TitleQualityInput extends PackSuggestionsInput {
  brand?: string | null;
}

export function titleQuality(input: TitleQualityInput): TitleQuality {
  const title = input.title ?? "";
  const utilization = titleUtilization(title, input.max);
  const lint = lintTitle(title);
  const brandFirst = isBrandFirst(title, input.brand);
  const suggestions = packTitleSuggestions(input);
  const terms = titleTerms(title, input.aspects);
  // US-2680: weakness is now about TERMS, not characters. An 78-character title
  // restating Brand and Size carries less than a 62-character one that does not,
  // and the old character threshold called the padded one stronger.
  const weak = terms.count < TERM_WEAK_BELOW ||
    lint.policyViolations.length > 0 ||
    lint.warnings.length > 0;
  return { utilization, terms, brandFirst, lint, suggestions, weak };
}

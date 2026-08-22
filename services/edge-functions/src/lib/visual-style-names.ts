// US-2781: the style line, recovered from listings that match the photo.
//
// ── The gap ──────────────────────────────────────────────────────────────────
// visual-aspect-consensus.ts reads only STRUCTURED item specifics, and thrift
// sellers almost never fill eBay's "Model" or "Product Line". So the pipeline
// walks past the thing US-2758 measured it being best at: a gray half-zip with
// no tag in frame returned three listings naming "Rest Less 1/2 Zip Swirl
// Scroll Thumbhole", correct down to the cuffs. That name was in the TITLES,
// and the consensus module deliberately does not read titles.
//
// ── Why it deliberately does not, and what changes here ──────────────────────
// style-code-aspects.ts opens with the reason, which the owner gave and which
// still holds word for word:
//
//   1. A title is marketing text. A seller who bought the garment with no tag
//      beyond a size dot writes their best guess, and a consensus over guesses
//      is a confident guess.
//   2. We were reading ourselves. Our own sellers publish to eBay with titles
//      our AI wrote, so those titles came back as independent corroboration -
//      three copies of one guess, agreeing because they share an author.
//
// Nothing here overturns that. The change is one word wide:
//
//   A title may GENERATE a candidate. A title may never CONFIRM one.
//
// mineStyleNames does the first. corroborateStyleName does the second, and it
// will only look at sources that are not titles: the brand knowledge base, a
// style code decoded off the garment's own tag, or an item specific a seller
// filled in on purpose. A name that passes only the first half never reaches a
// listing.
//
// Pure. No eBay calls, no database - the caller owns both.

/** How many DISTINCT non-own listings must carry a phrase for it to be mined. */
export const MIN_TITLE_SUPPORT = 2;

/** Word counts a product name plausibly has. One word is a category, not a name. */
const MIN_NAME_WORDS = 2;
const MAX_NAME_WORDS = 5;

/**
 * Tokens that are never part of a style name.
 *
 * Sizes, conditions, departments, and the vocabulary of a listing title rather
 * than of a product. Kept deliberately blunt: a false drop costs one candidate,
 * and a false keep puts "Mens Large" in front of the model as a style line.
 */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  // sizes
  "xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl", "4xl",
  "small", "medium", "large", "petite", "plus", "tall", "short", "regular",
  "size", "sz", "us", "uk", "eu",
  // condition and sale language
  "euc", "vguc", "guc", "nwt", "nwot", "nib", "bnwt", "new", "used", "preowned",
  "pre", "owned", "excellent", "great", "good", "vintage", "rare", "htf",
  "condition", "worn", "gently", "like", "mint", "flaw", "flaws", "free",
  "nice", "clean", "authentic", "genuine", "guaranteed", "fast", "shipping",
  "lot", "bundle", "read", "description", "see", "photos", "pics",
  // department and fit words that appear in every title
  "mens", "men", "womens", "women", "unisex", "boys", "girls", "kids", "youth",
  "ladies", "adult",
  // colours
  "black", "white", "gray", "grey", "blue", "navy", "red", "green", "pink",
  "purple", "yellow", "orange", "brown", "beige", "tan", "cream", "ivory",
  "olive", "teal", "burgundy", "maroon", "charcoal", "khaki", "multicolor",
  "multi", "color", "colour", "heather",
  // glue
  "and", "the", "with", "for", "in", "of", "a", "an",
]);

/** A word that is only digits, or digits with a unit, carries no name. */
function isNumericish(word: string): boolean {
  return /^[0-9]+(\.[0-9]+)?[a-z"']{0,3}$/.test(word);
}

/**
 * Title -> the words a style name could be built from.
 *
 * Punctuation becomes a BREAK, not a space. "Pullover, Gray" must not produce
 * the phrase "pullover gray" - sellers separate the product from its
 * description with punctuation far more reliably than they order their words.
 */
export function titleSegments(
  title: string,
  brandWords: ReadonlySet<string>,
): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  const push = () => {
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (const raw of title.toLowerCase().split(/([^a-z0-9'/]+)/)) {
    if (!raw) continue;
    if (/[^a-z0-9'/]/.test(raw)) {
      // Whitespace continues the phrase; anything else ends it.
      if (!/^\s+$/.test(raw)) push();
      continue;
    }
    const word = raw.replace(/^'+|'+$/g, "");
    if (!word) continue;
    if (brandWords.has(word) || NOISE_WORDS.has(word) || isNumericish(word)) {
      push();
      continue;
    }
    current.push(word);
  }
  push();
  return segments;
}

export interface MinedStyleName {
  /** The phrase, in the casing the first listing used. */
  name: string;
  /** Distinct non-own listings whose title carried it. */
  support: number;
}

export interface MineArgs {
  listings: ReadonlyArray<{ itemId: string; title: string }>;
  /** Canonical brand, so its own words never become the style name. */
  brand: string | null;
  /** Our own eBay listing ids. Excluded BEFORE anything is counted. */
  ownItemIds: ReadonlySet<string>;
}

/**
 * Candidate style names, most-supported first.
 *
 * A phrase is mined when at least MIN_TITLE_SUPPORT distinct listings carry it.
 * Longer phrases win ties: "Better Sweater Fleece" says more than "Better
 * Sweater", and the corroboration step is what decides whether either survives.
 *
 * This is HALF a mechanism on purpose. Its output is not fit to ship.
 */
export function mineStyleNames(args: MineArgs): MinedStyleName[] {
  const brandWords = new Set(
    (args.brand ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  // "Lululemon Athletica" and "Levi's" both need their possessive/plural forms
  // caught, or the brand walks straight into the name.
  for (const w of [...brandWords]) {
    brandWords.add(`${w}s`);
    brandWords.add(w.replace(/s$/, ""));
  }

  const supportByPhrase = new Map<string, Set<string>>();
  const displayByPhrase = new Map<string, string>();

  for (const l of args.listings) {
    // Excluded BEFORE the tally, never after. Removing our own listings from
    // the WINNER would still have let our own AI's wording pick it.
    if (!l.itemId || args.ownItemIds.has(l.itemId)) continue;
    const seenHere = new Set<string>();
    for (const segment of titleSegments(l.title, brandWords)) {
      for (let n = MIN_NAME_WORDS; n <= MAX_NAME_WORDS; n++) {
        for (let i = 0; i + n <= segment.length; i++) {
          const phrase = segment.slice(i, i + n).join(" ");
          if (seenHere.has(phrase)) continue;
          seenHere.add(phrase);
          let carriers = supportByPhrase.get(phrase);
          if (!carriers) {
            carriers = new Set();
            supportByPhrase.set(phrase, carriers);
            displayByPhrase.set(phrase, phrase);
          }
          carriers.add(l.itemId);
        }
      }
    }
  }

  const out: MinedStyleName[] = [];
  for (const [phrase, carriers] of supportByPhrase) {
    if (carriers.size < MIN_TITLE_SUPPORT) continue;
    out.push({ name: displayByPhrase.get(phrase) ?? phrase, support: carriers.size });
  }
  return out.sort(
    (a, b) =>
      b.support - a.support ||
      b.name.split(" ").length - a.name.split(" ").length ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Sources allowed to confirm a mined name. Strongest first.
 *
 * NOT A TITLE AMONG THEM, which is the entire point:
 *
 *   style_code    a code printed on this garment's own tag, decoded against
 *                 brand_style_codes. Nothing to be uncertain about.
 *   brand_styles  a name in the knowledge base, put there by a human.
 *   aspect_model  eBay's "Model" / "Product Line" - a field a seller filled in
 *                 on purpose, which is the distinction style-code-aspects.ts
 *                 draws between a specific and a title.
 */
export const CORROBORATION_SOURCES = [
  "style_code",
  "brand_styles",
  "aspect_model",
] as const;

export type CorroborationSource = (typeof CORROBORATION_SOURCES)[number];

export interface CorroborationInput {
  /** brand_styles names and aliases for this brand. */
  knownStyleNames: readonly string[];
  /** The name a style code off the tag decoded to, when one did. */
  decodedStyleName: string | null;
  /** Model / Product Line values the matched listings DECLARED as specifics. */
  aspectProductNames: readonly string[];
}

/** Compare on words, ignoring case and runs of whitespace. Nothing looser:
 *  "Better Sweater Vest" is a different garment from "Better Sweater". */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().split(/\s+/).join(" ");
  return norm(a) === norm(b) && norm(a).length > 0;
}

/**
 * Does something that is not a title back this name?
 *
 * Null means no, and null means the name does not reach the listing. It may
 * still be worth a human's attention — see the caller — but it is not evidence.
 */
export function corroborateStyleName(
  name: string,
  input: CorroborationInput,
): { source: CorroborationSource } | null {
  if (input.decodedStyleName && sameName(name, input.decodedStyleName)) {
    return { source: "style_code" };
  }
  if (input.knownStyleNames.some((k) => sameName(name, k))) {
    return { source: "brand_styles" };
  }
  if (input.aspectProductNames.some((k) => sameName(name, k))) {
    return { source: "aspect_model" };
  }
  return null;
}

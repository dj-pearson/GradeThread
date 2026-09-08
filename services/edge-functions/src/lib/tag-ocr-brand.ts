// US-3139: resolve a brand out of a raw OCR string read off a garment tag.
//
// The AutoLister names a photo group "Item 3" the moment it is created. This
// module is the half of the auto-namer that needs the curated brand table:
// the browser runs the OCR (tesseract.js, no AI, no cost) and posts the text
// here, and this turns "LEV1S\n505\n32 X 34" into "Levi's".
//
// Everything is PURE — no Anthropic, no Supabase — so it unit-tests directly.
//
// Two matchers, in order, because neither alone is enough:
//
//   1. detectBrandInText — the canonical spellings, word-boundary matched and
//      longest-first. Reaches "The North Face" in a sentence.
//   2. an n-gram window over BRAND_ALIASES — the MISSPELLINGS, which is what a
//      tag actually prints ("LEVIS", "THE NORTHFACE", "LEVI STRAUSS"). The
//      alias table is a whole-field lookup, so it is only safe over text with
//      DETECT_EXCLUDED_FROM_TEXT applied to the result.
//
// (2) without that guard would be actively harmful: "mother" is an alias key
// for the LA denim house, and "mother of pearl buttons" is one of the most
// common phrases printed near a care label.

import {
  canonicalizeBrand,
  DETECT_EXCLUDED_FROM_TEXT,
  detectBrandInText,
  isKnownBrand,
} from "./brand-normalize.ts";

// The digit-for-letter substitutions an OCR engine makes on a woven label.
// Deliberately short: every entry costs a false repair somewhere, and these
// four are the ones that actually fire on brand words.
const OCR_DIGIT_TO_LETTER: Record<string, string> = {
  "0": "O",
  "1": "I",
  "5": "S",
  "8": "B",
};

function isLetter(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z]/.test(ch);
}

/**
 * Fold the digits an OCR engine mistakes for letters back into letters, but
 * ONLY where the digit sits next to a letter. A digit among digits is a real
 * number — a size, an RN, a fibre percentage — and repairing those would turn
 * "RN 105050" into a word. Pure.
 */
export function repairOcrConfusions(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const swap = OCR_DIGIT_TO_LETTER[ch];
    if (swap && (isLetter(text[i - 1]) || isLetter(text[i + 1]))) {
      out += swap;
    } else {
      out += ch;
    }
  }
  return out;
}

// Longest brand phrase the window scan will consider. "Polo Ralph Lauren" is
// three; four leaves headroom without turning the scan into a sentence search.
const MAX_BRAND_WORDS = 4;

// Below this many characters (after brandKey normalization) a window is an OCR
// fragment, not a brand: "XL", "S", "CO". The alias table does hold two-letter
// keys, but they are only safe as a whole seller-typed field, never as one
// window plucked out of a care label.
const MIN_BRAND_KEY_LENGTH = 3;

function keyLength(window: string): number {
  return window.toLowerCase().replace(/[^a-z0-9]/g, "").length;
}

/** The alias-table pass: the longest window that resolves to a non-excluded
 *  canonical wins. Returns null when no window is a known brand. */
function brandFromAliasWindows(text: string): string | null {
  const words = text.split(/[^A-Za-z0-9'&-]+/).filter(Boolean);
  for (let size = Math.min(MAX_BRAND_WORDS, words.length); size >= 1; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      const window = words.slice(start, start + size).join(" ");
      if (keyLength(window) < MIN_BRAND_KEY_LENGTH) continue;
      if (!isKnownBrand(window)) continue;
      const canonical = canonicalizeBrand(window);
      if (!canonical) continue;
      // The ordinary-word guard. See DETECT_EXCLUDED_FROM_TEXT's comment in
      // brand-normalize.ts — a care label is prose and needs it just as an
      // eBay title does.
      if (DETECT_EXCLUDED_FROM_TEXT.has(canonical)) continue;
      return canonical;
    }
  }
  return null;
}

/**
 * The canonical brand printed on the tag, or null when the text names none.
 * Tries the text as read first, then again with the OCR digit confusions
 * repaired, so a clean read is never distorted by the repair. Pure.
 */
export function brandFromOcrText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!/[A-Za-z]/.test(text)) return null;

  const repaired = repairOcrConfusions(text);
  const candidates = repaired === text ? [text] : [text, repaired];

  for (const candidate of candidates) {
    const canonical = detectBrandInText(candidate);
    if (canonical) return canonical;
  }
  for (const candidate of candidates) {
    const alias = brandFromAliasWindows(candidate);
    if (alias) return alias;
  }
  return null;
}

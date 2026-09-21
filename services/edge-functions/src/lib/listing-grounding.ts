// US-3211: the listing prose may not claim a fact the item row cannot back.
//
// WHY THIS EXISTS, with the receipts. A seller reported an AI writing "linen
// blend" into listings for garments with no linen in them
// (vault/50-business/competitors/forum-sentiment.md section 8). Buyers on
// r/Ebay call an AI description "a license to return because the nonsense the
// AI writes can be used against you" -- three threads, 900+ combined upvotes.
// The damage is not that the prose reads badly. It is that a fibre content a
// buyer can check, and we invented, is a not-as-described case the seller
// loses.
//
// ── IT DROPS THE SENTENCE, NOT THE WORD ─────────────────────────────────────
// AC3 allows either. Removing "linen" from "linen blend construction with a
// soft hand" leaves "blend construction with a soft hand", which still asserts
// something and reads like a bug. A sentence is the smallest unit that can be
// removed and leave prose a person would write.
//
// ── A CLOSED VOCABULARY, AND WHY IT IS NOT A MODEL ──────────────────────────
// The fibre, era and origin lists below are fixed. Asking a model "is this
// claim grounded?" would be a second unverifiable opinion about the first
// one, and the first time the two disagreed nobody would know which was right.
// A closed list is auditable, its gaps are visible in the file, and a test can
// pin every entry. What it cannot do is catch a claim phrased in words nobody
// listed -- so this is a floor, not a guarantee, and the code says so where a
// reader will see it.
//
// ── BRANDS COME FROM THE SIZING CORPUS ──────────────────────────────────────
// SIZING_CHARTS already carries ~440 brands with their match tokens, compiled
// into the edge. A brand token found in the prose that is not the item's own
// brand is an invented brand.
//
// ⚠ SHORT TOKENS ARE THE TRAP. That corpus contains "alo" for Alo Yoga, and a
// substring match would fire on "also". Everything here is word-boundary and
// at least MIN_BRAND_TOKEN characters, and the constant carries the reason.
// US-3319/US-3324 is the same trap costing a whole story: a bare "duluth"
// token resolved Duluth Pack garments to Duluth Trading's chart.

import { SIZING_CHARTS } from "./sizing-charts.ts";

export const GROUNDING_VERSION = 1;

/** What kind of claim was found to be unsupported. */
export type ClaimKind = "material" | "size" | "brand" | "era" | "origin";

export interface RemovedClaim {
  kind: ClaimKind;
  /** The offending token, as it appeared. */
  token: string;
  /** The sentence that was dropped, trimmed. */
  sentence: string;
}

export interface GroundingResult {
  text: string;
  removed: RemovedClaim[];
  version: number;
}

/**
 * Everything the prose is allowed to assert.
 *
 * All of it is text the seller or the grader can point at: the item row, the
 * tag OCR recorded in `ai_field_sources`, and the grade report. Nothing here
 * is derived from the prose being checked, which is the whole point.
 */
export interface GroundingFacts {
  brand?: string | null;
  size?: string | null;
  material?: string | null;
  color?: string | null;
  style?: string | null;
  title?: string | null;
  /** The seller's own condition notes. They typed them; they can back them. */
  conditionNotes?: string | null;
  /** Raw strings from ai_field_sources, e.g. what the tag OCR read. */
  ocrText?: readonly string[];
  /** Anything the grade report observed in words. */
  gradeText?: readonly string[];
}

/**
 * Fibres and materials a listing might name.
 *
 * Deliberately generous on the left (every spelling a model might use) and
 * closed on the right: a word that is not here is never checked, and a word
 * that IS here must be backed. `blend` and `mix` are absent on purpose --
 * they assert nothing on their own.
 */
export const MATERIAL_TOKENS: readonly string[] = [
  "acetate", "acrylic", "alpaca", "angora", "bamboo", "bouclé", "boucle",
  "cashmere", "chambray", "chenille", "chiffon", "corduroy", "cotton",
  "crepe", "denim", "elastane", "faux fur", "faux leather", "flannel",
  "fleece", "gabardine", "georgette", "hemp", "jersey", "jute", "lace",
  "lambswool", "leather", "linen", "lurex", "lycra", "merino", "mesh",
  "microfiber", "microfibre", "modal", "mohair", "neoprene", "nylon",
  "organza", "pima", "polyamide", "polyester", "poplin", "ramie", "rayon",
  "sateen", "satin", "seersucker", "shearling", "silk", "spandex", "suede",
  "taffeta", "tencel", "terry", "tulle", "tweed", "twill", "velour",
  "velvet", "viscose", "wool",
];

/**
 * Era claims. A date is a fact a buyer checks against a tag, and "vintage"
 * has a marketplace definition (20+ years) rather than being a mood.
 */
export const ERA_TOKENS: readonly string[] = [
  "vintage", "antique", "deadstock", "nos", "retro",
  "y2k", "mod", "edwardian", "victorian",
  "1920s", "1930s", "1940s", "1950s", "1960s", "1970s", "1980s", "1990s",
  "2000s", "20s", "30s", "40s", "50s", "60s", "70s", "80s", "90s",
];

/** The minimum length of a brand token that may be matched on its own. */
export const MIN_BRAND_TOKEN = 4;

/**
 * Brand tokens that are ordinary English and must never match alone.
 *
 * Every one of these is a real entry in the sizing corpus and every one would
 * otherwise fire on prose that names no brand at all.
 */
const BRAND_STOPWORDS = new Set([
  "gap", "next", "public", "everlane", "universal", "standard", "life",
  "outdoor", "american", "british", "national", "united", "the north",
  "free", "lucky", "true", "old", "new", "point", "range", "champion",
  "quest", "state", "title", "vintage", "classic", "express", "current",
  "element", "frame", "goods", "kit", "market", "mountain", "patagonia",
]);

let brandIndex: Map<string, string> | null = null;

/**
 * token -> canonical brand name, for every token worth matching on.
 *
 * Built once. `patagonia` sits in the stoplist above NOT because it is an
 * English word but because it is a place; a listing that mentions Patagonia
 * the region is not claiming the label.
 */
export function brandTokens(): Map<string, string> {
  if (brandIndex) return brandIndex;
  const index = new Map<string, string>();
  for (const chart of SIZING_CHARTS) {
    for (const token of chart.brandMatch) {
      const t = token.trim().toLowerCase();
      if (t.length < MIN_BRAND_TOKEN) continue;
      if (BRAND_STOPWORDS.has(t)) continue;
      if (!index.has(t)) index.set(t, chart.brand);
    }
  }
  brandIndex = index;
  return index;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'");
}

/** Everything the facts allow, as one lowercased haystack. */
function haystack(facts: GroundingFacts): string {
  return norm(
    [
      facts.brand, facts.size, facts.material, facts.color, facts.style,
      facts.title, facts.conditionNotes,
      ...(facts.ocrText ?? []),
      ...(facts.gradeText ?? []),
    ].filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .join(" \n "),
  );
}

function containsWord(hay: string, token: string): boolean {
  // Word boundaries on both sides. A material list entry can hold a space
  // ("faux fur"), which \b still handles correctly at each end.
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(hay);
}

/**
 * Split prose into sentences.
 *
 * Crude on purpose: a full stop, question mark, exclamation or newline ends
 * one. A decimal point inside a measurement ("25.5 inches") is protected by
 * requiring whitespace or end-of-string after the stop. Nothing here needs to
 * be a correct sentence tokeniser -- it needs to cut at a place a reader would
 * accept, and to put the pieces back byte-for-byte, which splitSentences does
 * by keeping the delimiters.
 */
export function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    buf += ch;
    const next = text[i + 1];
    const ends = (ch === "." || ch === "!" || ch === "?") &&
      (next === undefined || /\s/.test(next));
    if (ends || ch === "\n") {
      parts.push(buf);
      buf = "";
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * The claims one sentence makes that the facts do not support.
 *
 * Exported so a test can assert the DETECTION separately from the removal,
 * and so a caller that wants to warn rather than cut has the same answer.
 */
export function unsupportedClaims(
  sentence: string,
  facts: GroundingFacts,
): RemovedClaim[] {
  const hay = haystack(facts);
  const text = norm(sentence);
  const out: RemovedClaim[] = [];
  const seen = new Set<string>();

  const flag = (kind: ClaimKind, token: string) => {
    const key = `${kind}:${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, token, sentence: sentence.trim() });
  };

  for (const token of MATERIAL_TOKENS) {
    if (containsWord(text, token) && !containsWord(hay, token)) {
      flag("material", token);
    }
  }
  for (const token of ERA_TOKENS) {
    if (containsWord(text, token) && !containsWord(hay, token)) {
      flag("era", token);
    }
  }

  // "made in X" -- the country has to be somewhere in the facts.
  for (const m of text.matchAll(/\bmade in ([a-z][a-z .'-]{2,24}?)\b/g)) {
    const country = m[1]!.trim();
    if (!containsWord(hay, country)) flag("origin", country);
  }

  // "size M", "size 32x30". Compared against the item's own size only: a
  // second size in the prose is a second claim, and only one can be right.
  const declared = norm(facts.size ?? "").trim();
  for (const m of text.matchAll(/\bsize\s+([a-z0-9][a-z0-9/x.-]{0,9})\b/g)) {
    const claimed = m[1]!.trim();
    if (!declared) {
      flag("size", claimed);
      continue;
    }
    if (!containsWord(declared, claimed) && !containsWord(claimed, declared)) {
      flag("size", claimed);
    }
  }

  // A brand from the corpus that is not this garment's brand.
  const ownBrand = norm(facts.brand ?? "");
  for (const [token, brand] of brandTokens()) {
    if (!containsWord(text, token)) continue;
    if (ownBrand && containsWord(ownBrand, token)) continue;
    if (containsWord(hay, token)) continue;
    flag("brand", brand);
  }

  return out;
}

/**
 * Drop every sentence that makes a claim the facts cannot back (AC3).
 *
 * Returns the surviving prose and what went, so the caller can tell the seller
 * rather than quietly shortening their listing. An empty result is a real
 * outcome: prose that was entirely invented is better gone than trimmed.
 */
export function groundProse(
  text: string,
  facts: GroundingFacts,
): GroundingResult {
  if (!text || !text.trim()) {
    return { text: text ?? "", removed: [], version: GROUNDING_VERSION };
  }
  const kept: string[] = [];
  const removed: RemovedClaim[] = [];
  for (const sentence of splitSentences(text)) {
    if (!sentence.trim()) {
      kept.push(sentence);
      continue;
    }
    const claims = unsupportedClaims(sentence, facts);
    if (claims.length === 0) {
      kept.push(sentence);
      continue;
    }
    removed.push(...claims);
  }
  return {
    // Collapse the whitespace a dropped sentence leaves behind, without
    // touching paragraph breaks the seller may have meant.
    text: kept.join("").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
    removed,
    version: GROUNDING_VERSION,
  };
}

/** Pull the plain strings out of `ai_field_sources` for the facts. */
export function ocrTextFrom(sources: unknown): string[] {
  if (!sources || typeof sources !== "object") return [];
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof v === "string") {
      out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) {
        walk(x, depth + 1);
      }
    }
  };
  walk(sources, 0);
  return out;
}

// 2026-09-02: which style code a listing files under, and what the brand
// decoders make of it.
//
// generateListing used to hand the OCR'd code to resolveStyleCode, which is
// the SNEAKER resolver (Nike/Jordan/adidas/New Balance shapes). For every
// apparel brand it returned null, so styleCodeRaw was null, the Style Code
// aspect stayed empty, and every mined product name was dropped with "no style
// code to file them under". Prod on 2026-09-02: 1001 items, 0 Style Code
// aspects, 71 Lululemon items with no product name in the title.
//
// PRECEDENCE, strongest first: the label the OCR just read; what an earlier
// pass stored on attributes.mpn; the sneaker resolver. The sneaker resolver
// keeps its comp-query and brand role for sneakers; it no longer decides
// whether apparel has a code.
//
// A decoder runs INSIDE the pack the tag's brand selected (decoder bar,
// vault/20-domain/brands/brand-kb-decoder-bar.md). A hit cannot spell a brand
// onto a foreign tag; it canonicalises the spelling (US-2714). The size-dot
// decoder stays OFF here, as everywhere: it only fires when a caller has
// isolated the dot region, and nothing does yet (REGION_SCOPED_DECODER_KINDS).
// A bare number the OCR called a style code is therefore not a code, and the
// MIN_STYLE_CODE_LENGTH the index already enforces keeps it out. Pure.

import {
  decodeTagCode,
  DEFAULT_DECODER_SPECS,
  type DecodeResult,
  type DecoderSpec,
  REGION_SCOPED_DECODER_KINDS,
} from "./brand-decoders.ts";
import {
  type BrandKnowledgePack,
  decoderSpecsFromPack,
} from "./brand-knowledge.ts";
import { brandKey as toBrandKey } from "./brand-normalize.ts";
import {
  canonicalStyleCode,
  type LearnedStyle,
  MIN_STYLE_CODE_LENGTH,
  styleNameFromTitle,
} from "./style-code-observations.ts";
import {
  TAG_GROUND_TRUTH_MIN_CONFIDENCE,
  type TagGroundTruth,
} from "./ai-tag-ocr.ts";

export type ListingStyleCodeSource =
  | "tag_ocr"
  | "item_attribute"
  | "sneaker_resolver";

export interface ListingStyleCode {
  /** The code exactly as it will be filed and searched, or null. */
  styleCodeRaw: string | null;
  /** canonicalStyleCode() of the above under the brand key ("" when none). */
  styleCodeNorm: string;
  /** Where styleCodeRaw came from. */
  source: ListingStyleCodeSource | null;
  /** Decoder hit inside the brand's pack, when one fired. */
  decoded: DecodeResult | null;
}

function confident(
  field: { value: string; confidence: number } | undefined,
  min: number,
): string | null {
  if (!field) return null;
  const v = field.value.trim();
  return v !== "" && field.confidence >= min ? v : null;
}

function storedString(
  attrs: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const raw = attrs?.[key];
  const s = Array.isArray(raw) ? raw[0] : raw;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : null;
}

// OCR reads a letter slot as the digit that looks like it. On a Lululemon size
// dot the colour letter sits right before the first dot ("LM5609S.0419"), and
// the first prod dry run brought it back as "LM56095.0419.000054.000". Only
// the LAST character of the first dot-segment is ever substituted, and only a
// variant that a decoder then recognises is used, so the decoder is the proof.
const CONFUSABLE_LETTER: Record<string, string> = {
  "0": "O",
  "1": "I",
  "2": "Z",
  "5": "S",
  "8": "B",
};

/**
 * The spellings of one transcribed code worth trying against the decoders, in
 * order: as read; the first two dot-segments; the first segment; then each of
 * those with the confusable letter slot corrected. The whole rim of a size dot
 * is what a model asked to transcribe VERBATIM produces, and the style number
 * is its prefix. Pure, deduplicated, the original always first.
 */
export function styleCodeSpellings(code: string): string[] {
  // Only a dotted rim string has a defined letter slot; anything else is
  // tried exactly as read.
  if (!code.includes(".")) return [code];
  const out: string[] = [code];
  const segs = code.split(".");
  if (segs.length >= 3) out.push(segs.slice(0, 2).join("."));
  out.push(segs[0]!);
  for (const c of [...out]) {
    const [head = "", ...rest] = c.split(".");
    const last = head.at(-1) ?? "";
    const fix = CONFUSABLE_LETTER[last];
    if (fix) out.push([head.slice(0, -1) + fix, ...rest].join("."));
  }
  return [...new Set(out)];
}

// ── the rim of a size dot is a CIRCLE (US-3086) ────────────────────────────
//
// styleCodeSpellings assumes the style number is the PREFIX of what the model
// transcribed, which is true only when the OCR happened to start where the code
// starts. A Lululemon size dot has no start: the string runs around the rim of a
// circle, so a model reading it can begin anywhere and the style number wraps.
// The 2026-09-02 prod backfill (US-3085) filed five rims raw for exactly that
// reason: LW3DUTS224000011302 begins on the code, 0000F80000DLW5B0303 begins
// eleven characters into the date block.
//
// So: try every window of the doubled string against the pack's own anchored
// shapes, in the order the specs define. The windows are candidate SPELLINGS,
// not decodes; decodeTagCode still has to accept one, inside the pack the tag's
// brand already selected. See vault/20-domain/brands/brand-kb-decoder-bar.md
// for why a substring search is admissible here and nowhere else.

/** The index's own floor: below this a window is not an identity. Every seeded
 *  style shape is longer, so this only bounds the scan. */
const RIM_MIN_WINDOW = MIN_STYLE_CODE_LENGTH;

/**
 * Longest transcription treated as a rim. The search is quadratic in the
 * length, and a string this long is a paragraph of OCR rather than a code.
 */
const RIM_MAX_LENGTH = 64;

/**
 * The decoder specs the rim search may use: the pack's own, or the in-code
 * defaults for its brand when it has none seeded (the same fallback
 * decodeTagCode applies), minus the region-scoped kinds. `size_dot` matching a
 * two-digit window would turn every rim into a size.
 */
export function rimDecoderSpecs(
  brandKey: string,
  packSpecs: DecoderSpec[],
): DecoderSpec[] {
  const specs = packSpecs.length > 0
    ? packSpecs
    : DEFAULT_DECODER_SPECS.filter((s) => s.brandKey === brandKey);
  return specs.filter((s) => !REGION_SCOPED_DECODER_KINDS.has(s.decoderKind));
}

/**
 * Every window of the circular string that one of `specs` matches whole, in
 * spec order, then by start position, then by length. Pure and deduplicated;
 * the string as read is never returned (the caller has already tried it).
 *
 * Every exact window is offered before any repaired one, so a repair is only
 * ever reached when nothing matched as transcribed. The repair is the
 * confusable letter slot on the window's LAST character, which is where the
 * prod rims lost their colour initial ("LW5B030" for LW5B03O). Same rule as
 * styleCodeSpellings: a repair is used only when a decoder then recognises it.
 *
 * `specs` empty means no search at all, which is how the caller keeps this
 * inside a resolved pack.
 */
export function styleCodeRimWindows(
  code: string,
  specs: DecoderSpec[],
): string[] {
  const s = code.trim();
  if (specs.length === 0) return [];
  if (s.length <= RIM_MIN_WINDOW || s.length > RIM_MAX_LENGTH) return [];
  const doubled = s + s;
  const exact: string[] = [];
  const repaired: string[] = [];
  for (const spec of specs) {
    let re: RegExp;
    try {
      re = new RegExp(spec.pattern, "i");
    } catch {
      continue; // a malformed spec matches nothing, exactly as runDecoderSpec has it
    }
    for (let start = 0; start < s.length; start++) {
      for (let len = RIM_MIN_WINDOW; len <= s.length; len++) {
        const window = doubled.slice(start, start + len);
        if (window === s) continue;
        // A window with no digit in it is a WORD. The shapes accept [A-Z0-9]
        // in the body, so "WOMENS" inside any transcription matches the 2017
        // spec exactly, and a model asked for a style code does sometimes hand
        // back label prose. Every real style number carries digits; this is the
        // one thing an anchored pattern cannot say for itself once the anchors
        // are being slid along a string.
        if (!/\d/.test(window)) continue;
        if (re.test(window)) {
          exact.push(window);
          continue;
        }
        const fix = CONFUSABLE_LETTER[window.at(-1) ?? ""];
        if (!fix) continue;
        const mended = window.slice(0, -1) + fix;
        if (re.test(mended)) repaired.push(mended);
      }
    }
  }
  return [...new Set([...exact, ...repaired])];
}

export function resolveListingStyleCode(args: {
  ocr: TagGroundTruth | null;
  itemAttributes: Record<string, unknown> | null | undefined;
  sneakerStyleCode: string | null;
  brand: string | null;
  pack: BrandKnowledgePack | null;
  minConfidence?: number;
}): ListingStyleCode {
  const min = args.minConfidence ?? TAG_GROUND_TRUTH_MIN_CONFIDENCE;
  const key = args.pack?.key ?? (args.brand ? toBrandKey(args.brand) : "");
  const specs = args.pack ? decoderSpecsFromPack(args.pack) : [];

  // Candidates in precedence order; the first one long enough to be a code wins.
  const candidates: Array<{ code: string; source: ListingStyleCodeSource }> = [];
  const ocrCode = confident(args.ocr?.style_code, min);
  if (ocrCode) candidates.push({ code: ocrCode, source: "tag_ocr" });
  const stored = storedString(args.itemAttributes, "mpn");
  if (stored) candidates.push({ code: stored, source: "item_attribute" });
  const sneaker = args.sneakerStyleCode?.trim();
  if (sneaker) candidates.push({ code: sneaker, source: "sneaker_resolver" });

  // US-3086: the rim rotation search runs ONLY inside an already-resolved pack.
  // A window that matches re-confirms the brand that selected the pack; it can
  // never recover one, which is what makes a substring search admissible here.
  const rimSpecs = args.pack ? rimDecoderSpecs(key, specs) : [];

  for (const c of candidates) {
    // The first spelling a decoder recognises wins; otherwise the code as read.
    let code = c.code;
    let decoded: DecodeResult | null = null;
    if (key) {
      const tryAll = (spellings: string[]) => {
        for (const spelling of spellings) {
          const hit = decodeTagCode(key, spelling, specs);
          if (hit) {
            code = spelling;
            decoded = hit;
            return true;
          }
        }
        return false;
      };
      // Whole-string spellings first; the rim windows are the salvage pass, so
      // a code that reads straight through never pays for the search.
      if (!tryAll(styleCodeSpellings(c.code))) {
        tryAll(styleCodeRimWindows(c.code, rimSpecs));
      }
    }
    const norm = canonicalStyleCode(key, code);
    if (norm.length < MIN_STYLE_CODE_LENGTH) continue;
    return { styleCodeRaw: code, styleCodeNorm: norm, source: c.source, decoded };
  }
  return { styleCodeRaw: null, styleCodeNorm: "", source: null, decoded: null };
}

// ── the product name from the style-code index ─────────────────────────────

export interface LearnedStyleForListing {
  /** A RESOLVED product name (official/admin/seller/consensus/corroborated public). */
  resolvedName: string | null;
  resolvedSource: string | null;
  /** An observation-only guess (trimmed listing title), never a fact. */
  candidateName: string | null;
  confidence: number;
}

/**
 * The key the resolved name is filed under in the tag ground-truth block. Named
 * for what it is: the block's header says "read verbatim off the tag", and this
 * one line is not - it is what OUR index says the code on the tag means.
 */
export const STYLE_NAME_GROUND_TRUTH_KEY =
  "product_name_from_style_code_index";

/**
 * Split what the index knows into a fact and a guess. lookupLearnedStyle
 * returns a resolved 00628 name when any source has answered (already gated
 * by pickStyleCodeName: a public submission needs corroboration), else the
 * most-seen listing title. Only the former may be written; the latter is
 * offered to the model under the UNVERIFIED EXTERNAL GUESS block. Pure.
 */
export function learnedStyleForListing(
  learned: LearnedStyle | null,
  brand: string | null,
  code: string | null,
): LearnedStyleForListing {
  if (!learned) {
    return { resolvedName: null, resolvedSource: null, candidateName: null, confidence: 0 };
  }
  const resolved = learned.resolvedName?.trim() ?? "";
  if (resolved !== "") {
    return {
      resolvedName: resolved,
      resolvedSource: learned.resolvedSource ?? null,
      candidateName: null,
      confidence: learned.confidence,
    };
  }
  return {
    resolvedName: null,
    resolvedSource: null,
    candidateName: styleNameFromTitle(learned.productTitle, brand, code),
    confidence: learned.confidence,
  };
}

/**
 * Put a RESOLVED name where the listing reads facts from: knownFields.style
 * (unless the seller typed a style), the tag ground-truth block (so the title
 * leads with it), and attributes.model (so the registry projects it onto the
 * leaf's Model aspect, fill-only). A candidate writes nothing here. Pure.
 */
export function applyLearnedStyleToListing(args: {
  learned: LearnedStyleForListing;
  knownFields: Record<string, unknown>;
  tagGroundTruth: Record<string, string> | undefined;
  tagAttributes: Record<string, string>;
  sellerTypedStyle: string | null;
}): {
  knownFields: Record<string, unknown>;
  tagGroundTruth: Record<string, string> | undefined;
  tagAttributes: Record<string, string>;
} {
  const name = args.learned.resolvedName;
  if (!name) {
    return {
      knownFields: args.knownFields,
      tagGroundTruth: args.tagGroundTruth,
      tagAttributes: args.tagAttributes,
    };
  }
  const knownFields = { ...args.knownFields };
  if (!args.sellerTypedStyle || args.sellerTypedStyle.trim() === "") {
    knownFields.style = name;
  }
  const tagGroundTruth = {
    ...(args.tagGroundTruth ?? {}),
    [STYLE_NAME_GROUND_TRUTH_KEY]: name,
  };
  const tagAttributes = { ...args.tagAttributes };
  if (!tagAttributes.model) tagAttributes.model = name;
  return { knownFields, tagGroundTruth, tagAttributes };
}

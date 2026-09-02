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

import { decodeTagCode, type DecodeResult } from "./brand-decoders.ts";
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

  for (const c of candidates) {
    // The first spelling a decoder recognises wins; otherwise the code as read.
    let code = c.code;
    let decoded: DecodeResult | null = null;
    if (key) {
      for (const spelling of styleCodeSpellings(c.code)) {
        const hit = decodeTagCode(key, spelling, specs);
        if (hit) {
          code = spelling;
          decoded = hit;
          break;
        }
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

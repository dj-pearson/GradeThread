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
  MIN_STYLE_CODE_LENGTH,
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
    const norm = canonicalStyleCode(key, c.code);
    if (norm.length < MIN_STYLE_CODE_LENGTH) continue;
    return {
      styleCodeRaw: c.code,
      styleCodeNorm: norm,
      source: c.source,
      decoded: key ? decodeTagCode(key, c.code, specs) : null,
    };
  }
  return { styleCodeRaw: null, styleCodeNorm: "", source: null, decoded: null };
}

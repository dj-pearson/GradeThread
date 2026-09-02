// US-543: dedicated tag-OCR ground-truth pass for AutoLister.
//
// Brand / size / fiber content / style code / RN# are the fields a listing
// most often HALLUCINATES when they're inferred implicitly from a busy garment
// photo. This module runs a separate, focused vision pass over ONLY the tag /
// care-label photo(s) — nothing else in the frame to distract the model — and
// reads those fields VERBATIM off the label as ground truth. The result is
// merged into the listing call's knownFields and flagged as authoritative so it
// is weighted ABOVE the model's own visual inference (see ai-listing.ts).
//
// The Anthropic call (extractTagGroundTruth) is isolated from the pure mapping
// (normalizeTagOcr) and the pure merge (mergeTagGroundTruth) so both can be
// unit-tested without hitting the API.

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, getDefaultModel } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { withRetry } from "./retry.ts";

// flipdesk_photo_type values that carry a readable brand/size/care label.
export const TAG_PHOTO_TYPES: ReadonlySet<string> = new Set(["tag", "tag_2"]);

// US-2210: the grading taxonomy (public.image_type) names the same photo
// "label"/"label_2" where FlipDesk names it "tag"/"tag_2". Two vocabularies for
// one photograph, both already in prod, so the grading pipeline filters on this
// set rather than TAG_PHOTO_TYPES.
export const GRADING_TAG_PHOTO_TYPES: ReadonlySet<string> = new Set([
  "label",
  "label_2",
]);

// 2026-09-02: label-like types that are worth an OCR look when no photo is
// typed tag. `interior` is the inside of a garment (where the woven label is)
// and `marking` is an explicit maker's mark. `internal` is deliberately NOT
// here: US-1549 makes it seller-reference only (price tags, receipts) and
// filterListablePhotos already drops it before any model sees it.
export const TAG_OCR_FALLBACK_TYPES: ReadonlySet<string> = new Set([
  "interior",
  "marking",
]);

/**
 * The photos the tag-OCR pass should read, in priority order: every tag-typed
 * photo first (input order kept), then the label-like fallbacks, capped. Pure.
 */
export function selectTagOcrPhotos<T extends { type?: string | null }>(
  photos: T[],
  max = 4,
): T[] {
  const tags = photos.filter((p) => p.type && TAG_PHOTO_TYPES.has(p.type));
  const fallbacks = photos.filter(
    (p) => p.type && TAG_OCR_FALLBACK_TYPES.has(p.type),
  );
  return [...tags, ...fallbacks].slice(0, max);
}

/**
 * 2026-09-02: what to do with a holistic role pass when nothing was typed tag.
 * The photos the classifier called `tag` are read by OCR whatever their stored
 * type; only rows still on the generic `detail` default (or untyped) are
 * relabelled, so a seller's own choice is never clobbered (same guard as the
 * per-photo classifier in flipdesk-ai.ts). Pure.
 */
export function planTagRoleWriteback<
  T extends { id?: string; type?: string | null },
>(
  photos: T[],
  roles: Record<string, string>,
): { tagPhotos: T[]; writeback: string[] } {
  const tagPhotos = photos.filter((p) => p.id && roles[p.id] === "tag");
  const writeback = tagPhotos
    .filter((p) => !p.type || p.type === "detail")
    .map((p) => p.id as string);
  return { tagPhotos, writeback };
}

export interface TagPhoto {
  /** A fetchable URL, or a `data:image/...;base64,...` URI. */
  url: string;
  type?: string;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Build the Anthropic image source for a tag photo. The FlipDesk callers pass
 * fetchable URLs; the grading pipeline (US-2210) passes the SAME resident
 * base64 data URIs its per-image pass already holds, so the tag read costs no
 * extra download and stays inside the pipeline's memory gate. Accepting both
 * shapes here keeps either caller from having to convert. Pure — exported for
 * tests.
 */
export function tagImageSource(
  url: string,
): { type: "base64"; media_type: ImageMediaType; data: string } | {
  type: "url";
  url: string;
} {
  const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
  if (match) {
    return {
      type: "base64",
      media_type: match[1] as ImageMediaType,
      data: match[2],
    };
  }
  return { type: "url", url };
}

// One read field off the tag, with the verbatim string and a calibrated
// confidence. Mirrors ai-extract.ts:FieldSuggestion's shape but tag-scoped.
export interface TagField {
  value: string;
  confidence: number; // 0..1
}

// The verbatim ground-truth fields a care/brand label carries. Keys map to
// inventory_items columns where one exists (brand/size/material/style); rn is
// label-only and flows into item specifics.
//
// Widened 2026-09-02 from five fields to eight. The care label already in the
// frame carries three more facts eBay has an aspect for and buyers filter on:
// the care instructions ("Garment Care"), the country of origin ("Country of
// Origin", SELECTION_ONLY in every cached apparel leaf) and the product line
// printed beside the brand ("Product Line": Dri-FIT, HeatGear, Align). Reading
// them here costs a few dozen output tokens on a call that is already looking
// at the label; leaving them to the vision passes meant they came back blank
// on almost every draft, because "never guess" is the right rule for a model
// looking at a garment and the wrong one for a label it can read.
export interface TagGroundTruth {
  brand?: TagField;
  size?: TagField;
  fiber_content?: TagField;
  style_code?: TagField;
  rn_number?: TagField;
  /** Care instructions as printed, e.g. "Machine wash cold, tumble dry low". */
  care_instructions?: TagField;
  /** Country name only ("Vietnam"), never the "Made in" prefix. */
  country_of_origin?: TagField;
  /** The sub-brand / line printed on the label ("Dri-FIT", "Align"). */
  product_line?: TagField;
}

export interface TagOcrResult {
  fields: TagGroundTruth;
  /** US-2212: raw era id the model picked, if any. Resolved by tag-era.ts. */
  eraId?: string;
  /** US-2212: the model's confidence in that pick. */
  eraConfidence?: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

// Below this confidence a tag read is too uncertain to override the item's
// existing value or be presented to the model as authoritative ground truth.
export const TAG_GROUND_TRUTH_MIN_CONFIDENCE = 0.4;

const READ_TAG_TOOL: Anthropic.Tool = {
  name: "read_garment_tag",
  description:
    "Transcribe brand, size, fiber/material content, style code, RN number, care instructions, country of origin and any printed product line EXACTLY as printed on the garment's tag/care label. Omit any field not legibly present.",
  input_schema: {
    type: "object",
    properties: {
      brand: { type: "string", description: "Brand/maker name printed on the tag, verbatim." },
      size: { type: "string", description: "Size as printed (e.g. M, 32x34, 10, EU 42), verbatim." },
      fiber_content: {
        type: "string",
        description:
          "Fiber/material content exactly as printed (e.g. '100% Cotton', '60% Cotton 40% Polyester').",
      },
      style_code: {
        type: "string",
        description: "Style / style number / model code printed on the tag, verbatim.",
      },
      rn_number: {
        type: "string",
        description: "RN# (Registered Identification Number), digits only or 'RN 12345' as printed.",
      },
      care_instructions: {
        type: "string",
        description:
          "Care instructions as printed on the care label, compact, comma-separated (e.g. 'Machine wash cold, tumble dry low, do not bleach'). Words only; do not describe care symbols you cannot read as text.",
      },
      country_of_origin: {
        type: "string",
        description:
          "Country of manufacture as printed, COUNTRY NAME ONLY (e.g. 'Vietnam' for 'Made in Vietnam'). Omit if not printed.",
      },
      product_line: {
        type: "string",
        description:
          "A product line / sub-brand / collection name printed on the label beside or below the brand (e.g. 'Dri-FIT', 'HeatGear', 'Align', 'Tech Fleece'). NOT the brand itself, NOT a style code. Omit if none is printed.",
      },
      // US-2212: only meaningful when the caller supplied an era reference
      // block. With no block the instructions never mention it and the model
      // has no ids to return, so the extra property is inert.
      tag_era: {
        type: "string",
        description:
          "ONLY if a list of known tag generations was provided AND the label clearly matches exactly one: that generation's id (e.g. 'era_2'). Omit when unsure, ambiguous, or unlisted.",
      },
      confidence: {
        type: "object",
        description:
          "Per-field legibility confidence 0..1. Provide an entry for every field you returned.",
        additionalProperties: { type: "number" },
      },
    },
    required: ["confidence"],
  },
};

const SYSTEM =
  "You are an OCR specialist for an apparel reseller. You are shown ONLY the " +
  "brand/size/care label of a single garment. Transcribe what is printed on the " +
  "label EXACTLY — do not normalize, expand, translate, or guess. If a field is " +
  "not clearly legible on the label, omit it entirely rather than inferring it. " +
  "Read it verbatim and call read_garment_tag.";

// US-2212: `eraBlock` is the brand's known tag generations, rendered by
// tag-era.ts. Empty string => the returned string is byte-identical to before
// the era feature existed, which a test pins.
export function userInstructions(eraBlock = ""): string {
  return [
    "Read the garment tag/label photo(s) and transcribe, verbatim, only what is printed:",
    "- brand (the maker name)",
    "- size",
    "- fiber/material content (e.g. '100% Cotton')",
    "- style code / style number",
    "- RN number (RN#)",
    "- care instructions (compact, comma-separated, words only)",
    "- country of origin (country name only, e.g. 'Vietnam')",
    "- product line / sub-brand printed beside the brand (e.g. 'Dri-FIT'), if any",
    "Omit any field you cannot read clearly. Give a 0..1 confidence for each field you return.",
    ...(eraBlock ? ["", eraBlock, ""] : []),
    "Then call read_garment_tag.",
  ].join("\n");
}

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Map the model's read_garment_tag tool output into a TagGroundTruth, keeping
 * only legible string values and clamping confidences. Pure — no network — so
 * it can be unit-tested directly. A field with no matching confidence defaults
 * to 0 (treated as below the ground-truth threshold downstream).
 */
export function normalizeTagOcr(raw: unknown): TagGroundTruth {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const conf = (o.confidence && typeof o.confidence === "object"
    ? o.confidence
    : {}) as Record<string, unknown>;
  const out: TagGroundTruth = {};
  const keys: Array<keyof TagGroundTruth> = [
    "brand",
    "size",
    "fiber_content",
    "style_code",
    "rn_number",
    "care_instructions",
    "country_of_origin",
    "product_line",
  ];
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string" && v.trim().length > 0) {
      const value = key === "country_of_origin"
        ? cleanCountryOfOrigin(v)
        : v.trim();
      if (!value) continue;
      out[key] = { value, confidence: clamp01(conf[key]) };
    }
  }
  return out;
}

/**
 * The country name alone. Labels print "Made in Vietnam", "Hecho en Mexico",
 * "Fabrique au Portugal", and the model is asked for the bare name but does
 * not always comply. eBay's Country of Origin list holds bare names, so a
 * prefix left on the value is a value the normalizer cannot land. Pure.
 */
export function cleanCountryOfOrigin(raw: string): string {
  return raw
    .trim()
    .replace(/^(made|manufactured|produced|assembled)\s+in\b\s*/i, "")
    .replace(/^(hecho|fabricado|fabricada|producido)\s+en\b\s*/i, "")
    .replace(/^fabriqu\S*\s+(au|en|aux)\s+/i, "")
    .replace(/^(hergestellt|produziert)\s+in\s+/i, "")
    .replace(/[.\s]+$/g, "")
    .trim();
}

// Maps tag-OCR ground-truth keys onto the knownFields keys the listing prompt
// already understands (inventory_items columns + rn_number passthrough).
const GROUND_TRUTH_TO_KNOWN_FIELD: Record<keyof TagGroundTruth, string> = {
  brand: "brand",
  size: "size",
  fiber_content: "material",
  style_code: "style",
  rn_number: "rn_number",
  // The three label facts added 2026-09-02, keyed by the inventory_items
  // ATTRIBUTE the aspect registry reads them from, so the same word reaches
  // the prompt, the registry projection and the stored item.
  care_instructions: "garment_care",
  country_of_origin: "country_of_manufacture",
  product_line: "product_line",
};

/**
 * The tag reads that belong on `inventory_items.attributes`, fill-only.
 *
 * `mergeTagGroundTruth` feeds the PROMPT. This feeds the aspect registry
 * (resolveItemAspects reads `attributes.garment_care`, `.country_of_manufacture`,
 * `.product_line`, `.mpn`) and the item row, which is what makes the label's
 * facts land on the category's real aspect names without asking the model to
 * copy them, and survive to the next generation.
 *
 * The style code doubles as the MPN. A code printed on the label ("CJ1682-010",
 * "LW3CWDS") is exactly what eBay's MPN / Style Code aspect wants, and until
 * now it only ever reached the prompt as `style` and the sneaker decoder.
 *
 * Fill-only: a value the seller already typed on the item is never replaced,
 * even by a confident read. Pure.
 */
export function tagAttributeFill(
  tag: TagGroundTruth,
  existing: Record<string, unknown> | null | undefined,
  minConfidence: number = TAG_GROUND_TRUTH_MIN_CONFIDENCE,
): Record<string, string> {
  const current = existing ?? {};
  const out: Record<string, string> = {};
  const put = (attribute: string, field: TagField | undefined) => {
    if (!field || field.confidence < minConfidence) return;
    const stored = current[attribute];
    if (typeof stored === "string" && stored.trim() !== "") return;
    if (Array.isArray(stored) && stored.length > 0) return;
    if (stored != null && typeof stored !== "string" && !Array.isArray(stored)) return;
    out[attribute] = field.value;
  };
  put("garment_care", tag.care_instructions);
  put("country_of_manufacture", tag.country_of_origin);
  put("product_line", tag.product_line);
  put("mpn", tag.style_code);
  return out;
}

export interface MergeTagGroundTruthResult {
  // knownFields with confident tag reads applied (tag wins over prior values).
  merged: Record<string, unknown>;
  // The subset that came verbatim off the tag — passed to the model as
  // authoritative, to be weighted above its own visual inference.
  groundTruth: Record<string, string>;
}

/**
 * Fold confident tag-OCR reads into the listing's knownFields. A tag read at or
 * above the confidence threshold WINS over any prior value for that field —
 * the label is the highest-authority source for brand/size/fiber/style — and is
 * additionally surfaced as authoritative ground truth for the prompt. Low-
 * confidence reads are ignored so an illegible label never clobbers a known-good
 * value. Pure — no network — so it can be unit-tested directly.
 */
export function mergeTagGroundTruth(
  knownFields: Record<string, unknown>,
  tag: TagGroundTruth,
  minConfidence: number = TAG_GROUND_TRUTH_MIN_CONFIDENCE,
): MergeTagGroundTruthResult {
  const merged: Record<string, unknown> = { ...knownFields };
  const groundTruth: Record<string, string> = {};
  for (const [gtKey, field] of Object.entries(tag) as Array<[
    keyof TagGroundTruth,
    TagField | undefined,
  ]>) {
    if (!field || field.confidence < minConfidence) continue;
    const target = GROUND_TRUTH_TO_KNOWN_FIELD[gtKey];
    merged[target] = field.value;
    groundTruth[target] = field.value;
  }
  return { merged, groundTruth };
}

/**
 * Run the focused tag-OCR vision pass over the supplied tag photo(s). Pass ONLY
 * tag/care-label photos (filter on TAG_PHOTO_TYPES) so the model has nothing
 * else in frame to distract from a verbatim read. Throws on API failure; the
 * caller treats a throw as "no ground truth available" and continues.
 */
export async function extractTagGroundTruth(
  photos: TagPhoto[],
  // US-2212: the brand's known tag generations, rendered by tag-era.ts. "" (the
  // default, and what every pre-existing caller passes) leaves the prompt
  // byte-identical and the model with no ids to return.
  eraBlock = "",
): Promise<TagOcrResult> {
  if (photos.length === 0) {
    throw new Error("extractTagGroundTruth requires at least one tag photo");
  }
  enterAiFeature("tag_ocr"); // US-894 spend attribution

  const model = getDefaultModel(); // vision-capable
  const client = getAnthropicClient();

  const content: Anthropic.ContentBlockParam[] = [];
  photos.forEach((photo, i) => {
    content.push({
      type: "text",
      text: `Tag photo ${i + 1}${photo.type ? ` (${photo.type})` : ""}:`,
    });
    content.push({ type: "image", source: tagImageSource(photo.url) });
  });
  content.push({ type: "text", text: userInstructions(eraBlock) });

  const response = await withRetry(
    () =>
      client.messages.create({
        model,
        max_tokens: 512,
        system: SYSTEM,
        tools: [READ_TAG_TOOL],
        tool_choice: { type: "tool", name: "read_garment_tag" },
        messages: [{ role: "user", content }],
      }),
    {
      onRetry: ({ attempt, delayMs }) =>
        console.warn(
          `[AI TagOCR] Anthropic call retry #${attempt} after ${delayMs}ms backoff`,
        ),
    },
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return a tag read");
  }
  const fields = normalizeTagOcr(toolUse.input);
  // US-2212: carried out raw and resolved by tag-era.ts against the SAME list
  // the block was rendered from — this module never decides what an era means.
  const rawInput = (toolUse.input ?? {}) as Record<string, unknown>;
  const rawEra = typeof rawInput.tag_era === "string" ? rawInput.tag_era : undefined;
  const rawEraConf = (rawInput.confidence &&
      typeof rawInput.confidence === "object"
    ? (rawInput.confidence as Record<string, unknown>).tag_era
    : undefined);

  return {
    fields,
    ...(rawEra ? { eraId: rawEra, eraConfidence: clamp01(rawEraConf) } : {}),
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

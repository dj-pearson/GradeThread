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

// The five verbatim ground-truth fields a care/brand label carries. Keys map to
// inventory_items columns where one exists (brand/size/material/style); rn is
// label-only and flows into item specifics.
export interface TagGroundTruth {
  brand?: TagField;
  size?: TagField;
  fiber_content?: TagField;
  style_code?: TagField;
  rn_number?: TagField;
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
    "Transcribe brand, size, fiber/material content, style code, and RN number EXACTLY as printed on the garment's tag/care label. Omit any field not legibly present.",
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
  ];
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string" && v.trim().length > 0) {
      out[key] = { value: v.trim(), confidence: clamp01(conf[key]) };
    }
  }
  return out;
}

// Maps tag-OCR ground-truth keys onto the knownFields keys the listing prompt
// already understands (inventory_items columns + rn_number passthrough).
const GROUND_TRUTH_TO_KNOWN_FIELD: Record<keyof TagGroundTruth, string> = {
  brand: "brand",
  size: "size",
  fiber_content: "material",
  style_code: "style",
  rn_number: "rn_number",
};

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

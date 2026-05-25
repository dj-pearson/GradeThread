import Anthropic from "@anthropic-ai/sdk";
import {
  getAiTemperature,
  getAnthropicClient,
  getDefaultModel,
  getLightweightModel,
  isCachingEnabled,
} from "./ai-config.ts";

// Model routing: text-only requests use the cheap lightweight model; any
// request that includes a photo uses the vision-capable default model.
// Both names come from Coolify Team Shared Variables — see ai-config.ts.
export function getHaikuModel(): string {
  return getLightweightModel();
}

export function getSonnetModel(): string {
  return getDefaultModel();
}

// Approximate per-million-token pricing (USD). Used only for budget
// guardrails — exact billing is not the goal. Keyed by the model family
// prefix so that pinned date variants still resolve.
const PRICING: Array<{ match: RegExp; in: number; out: number }> = [
  { match: /haiku/i, in: 1.0, out: 5.0 },
  { match: /sonnet/i, in: 3.0, out: 15.0 },
  { match: /opus/i, in: 15.0, out: 75.0 },
];
const FALLBACK_PRICING = { in: 1.0, out: 5.0 };

export const ITEM_CATEGORIES = [
  "clothing",
  "shoes",
  "watches",
  "sports_cards",
  "collectibles",
  "electronics",
  "other",
] as const;

const EXTRACT_FIELDS = [
  "title",
  "brand",
  "style",
  "size",
  "color",
  "material",
  "item_category",
  "condition_notes",
] as const;

export interface FieldSuggestion {
  value: string;
  confidence: number; // 0..1
  source: string; // "text" | "photo:tag" | "photo:front" | ...
}

export interface ExtractPhoto {
  url: string;
  type?: string; // front | back | tag | detail | defect | flatlay | on_model
}

export interface ExtractInput {
  text?: string;
  photos?: ExtractPhoto[];
  knownFields?: Record<string, unknown>;
}

export interface FieldConflict {
  field: string;
  text_value: string;
  photo_value: string;
}

export interface ExtractionResult {
  suggestions: Record<string, FieldSuggestion>;
  conditionSummary: string | null;
  conflicts: FieldConflict[];
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const price = PRICING.find((p) => p.match.test(model)) ?? FALLBACK_PRICING;
  const cost = (tokensIn / 1_000_000) * price.in +
    (tokensOut / 1_000_000) * price.out;
  return Math.round(cost * 100000) / 100000;
}

// Static — kept in a cache-controlled system block to cut repeat-call cost.
const SYSTEM_PROMPT =
  `You extract structured resale-item attributes for FlipDesk, a reseller tool.
You are given a free-text description and/or photos of a single second-hand item.

Hard rules:
- Never guess. If the input does not support a field, omit it entirely.
- item_category MUST be one of: ${ITEM_CATEGORIES.join(", ")}. Never invent a category.
- size: normalize to a common token (XS, S, M, L, XL, XXL, a numeric size, or a shoe size) only when unambiguous; otherwise omit it.
- title: produce a clean, listing-ready title (brand + key descriptors), not a copy of the raw text.
- color: a single primary color word. material: the primary fabric/material.
- condition_notes: only condition hints explicitly present in the input.
- For every field you return, give a calibrated confidence from 0 to 1, and a source string.

Photo guidance (when photos are present):
- The 'tag' photo carries the care label — read brand, size, and fiber/material content verbatim from it. It is the highest-value input.
- 'front', 'flatlay', 'on_model' photos: use for color, item_category, and garment style.
- 'detail' and 'defect' photos: use for condition_notes and condition_summary.
- Set each field's source to where it came from: 'text', or 'photo:<type>' (e.g. 'photo:tag').
- Read label text robustly across blurry or angled shots — if a label is hard to read, return the field with LOW confidence rather than a confident guess. Skip images you genuinely cannot interpret.

When BOTH text and photos are provided:
- Photos win for brand, size, and material; text wins for condition_notes.
- If text and photos genuinely disagree on a field, do NOT silently pick one — add an entry to conflicts with both values.

Fields supplied as already-known are ground truth — do not contradict them; only fill genuine gaps.
Always also return a short condition_summary describing the item's observed condition.`;

function fieldSchema(description: string) {
  return {
    type: "object" as const,
    description,
    properties: {
      value: { type: "string" as const },
      confidence: {
        type: "number" as const,
        description: "0..1 calibrated confidence",
      },
      source: {
        type: "string" as const,
        description: "'text' or 'photo:<type>'",
      },
    },
    required: ["value", "confidence"],
  };
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "extract_item_fields",
  description:
    "Return the structured resale-item fields you can determine from the provided text and/or images. Omit any field you cannot support.",
  input_schema: {
    type: "object",
    properties: {
      title: fieldSchema("Clean, listing-ready item title"),
      brand: fieldSchema("Brand or maker name"),
      style: fieldSchema("Style name, model, silhouette, or model number"),
      size: fieldSchema("Normalized size token"),
      color: fieldSchema("Primary color"),
      material: fieldSchema("Primary material or fabric"),
      item_category: {
        type: "object",
        description: "Item category",
        properties: {
          value: { type: "string", enum: [...ITEM_CATEGORIES] },
          confidence: { type: "number" },
          source: { type: "string" },
        },
        required: ["value", "confidence"],
      },
      condition_notes: fieldSchema(
        "Brief condition hints explicitly mentioned or visible"
      ),
      condition_summary: {
        type: "string",
        description: "A short overall condition summary of the item",
      },
      conflicts: {
        type: "array",
        description:
          "Fields where the text and the photos genuinely disagree",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            text_value: { type: "string" },
            photo_value: { type: "string" },
          },
          required: ["field", "text_value", "photo_value"],
        },
      },
    },
  },
};

function buildUserPrompt(input: ExtractInput): string {
  const parts: string[] = [];
  if (input.text && input.text.trim()) {
    parts.push(`ITEM DESCRIPTION:\n${input.text.trim()}`);
  }
  const known = input.knownFields ?? {};
  const knownEntries = Object.entries(known).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );
  if (knownEntries.length > 0) {
    parts.push(
      `ALREADY KNOWN (ground truth — do not contradict, only fill gaps):\n` +
        JSON.stringify(Object.fromEntries(knownEntries), null, 2)
    );
  }
  parts.push(
    "Call extract_item_fields with only the fields you can confidently determine."
  );
  return parts.join("\n\n");
}

/**
 * Extracts structured item attributes from text and/or photos, routing to
 * Haiku (text-only) or Sonnet (any photo). Throws on transport/parse errors
 * so the caller can return a 502 without charging a log row.
 */
export async function extractItemFields(
  input: ExtractInput
): Promise<ExtractionResult> {
  const photos = input.photos ?? [];
  const hasPhotos = photos.length > 0;
  const model = hasPhotos ? getSonnetModel() : getHaikuModel();
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  const content: Anthropic.ContentBlockParam[] = [];
  // Interleave a labelled caption before each image so the model knows
  // which shot is the tag, the front, etc.
  photos.forEach((photo, i) => {
    content.push({
      type: "text",
      text: `Photo ${i + 1}${photo.type ? ` (${photo.type})` : ""}:`,
    });
    content.push({ type: "image", source: { type: "url", url: photo.url } });
  });
  content.push({ type: "text", text: buildUserPrompt(input) });

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
    : { type: "text", text: SYSTEM_PROMPT };

  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    ...(temperature !== undefined ? { temperature } : {}),
    system: [systemBlock],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "extract_item_fields" },
    messages: [{ role: "user", content }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return structured fields");
  }

  const raw = toolUse.input as Record<string, unknown>;
  const defaultSource = hasPhotos ? "photo" : "text";
  const suggestions: Record<string, FieldSuggestion> = {};

  for (const key of EXTRACT_FIELDS) {
    const field = raw[key];
    if (!field || typeof field !== "object") continue;
    const f = field as { value?: unknown; confidence?: unknown; source?: unknown };
    if (
      f.value === undefined ||
      f.value === null ||
      String(f.value).trim() === ""
    ) {
      continue;
    }
    let confidence = Number(f.confidence);
    if (Number.isNaN(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));
    const source =
      typeof f.source === "string" && f.source.trim() !== ""
        ? f.source
        : defaultSource;
    suggestions[key] = {
      value: String(f.value).trim(),
      confidence,
      source,
    };
  }

  const conditionSummary =
    typeof raw.condition_summary === "string" &&
      raw.condition_summary.trim() !== ""
      ? raw.condition_summary.trim()
      : null;

  const conflicts: FieldConflict[] = Array.isArray(raw.conflicts)
    ? (raw.conflicts as unknown[])
        .filter(
          (c): c is FieldConflict =>
            !!c &&
            typeof c === "object" &&
            typeof (c as FieldConflict).field === "string"
        )
        .map((c) => ({
          field: c.field,
          text_value: String(c.text_value ?? ""),
          photo_value: String(c.photo_value ?? ""),
        }))
    : [];

  return {
    suggestions,
    conditionSummary,
    conflicts,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

// ─── Listing copy generation (US-165) ──────────────────────────────

export interface ListingCopyInput {
  attributes: Record<string, unknown>;
  conditionNotes?: string;
  measurements?: Record<string, unknown>;
  photos?: ExtractPhoto[];
}

export interface ListingCopyResult {
  title: string;
  description: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const LISTING_SYSTEM_PROMPT =
  `You are a resale listing copywriter for FlipDesk. Given an item's known
attributes (and optionally photos), write a polished, search-friendly listing.

Rules:
- title: lead with brand, then item type, then key attributes (size, color,
  material). Keep it under 80 characters — marketplace title limits.
- description: a short opening line, then attribute bullet points, then a clear
  condition statement, then measurements if provided.
- CONDITION HONESTY IS CRITICAL: only state condition facts that are present in
  the supplied condition notes or that you can plainly see in the photos. Never
  invent or upgrade condition claims — over-promising condition causes returns.
- Do not fabricate attributes that were not supplied.`;

const LISTING_TOOL: Anthropic.Tool = {
  name: "write_listing_copy",
  description: "Return a marketplace-ready listing title and description.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Search-friendly title, <80 chars" },
      description: {
        type: "string",
        description: "Structured buyer-facing description",
      },
    },
    required: ["title", "description"],
  },
};

/**
 * Generates a listing title + description. Routes to Sonnet when photos are
 * present (so copy can reference visible condition), Haiku otherwise.
 */
export async function generateListingCopy(
  input: ListingCopyInput
): Promise<ListingCopyResult> {
  const photos = input.photos ?? [];
  const hasPhotos = photos.length > 0;
  const model = hasPhotos ? getSonnetModel() : getHaikuModel();
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  const content: Anthropic.ContentBlockParam[] = [];
  photos.forEach((photo, i) => {
    content.push({
      type: "text",
      text: `Photo ${i + 1}${photo.type ? ` (${photo.type})` : ""}:`,
    });
    content.push({ type: "image", source: { type: "url", url: photo.url } });
  });

  const lines: string[] = [
    "ITEM ATTRIBUTES:",
    JSON.stringify(input.attributes, null, 2),
  ];
  if (input.conditionNotes && input.conditionNotes.trim()) {
    lines.push(`CONDITION NOTES:\n${input.conditionNotes.trim()}`);
  }
  if (input.measurements && Object.keys(input.measurements).length > 0) {
    lines.push(`MEASUREMENTS:\n${JSON.stringify(input.measurements, null, 2)}`);
  }
  lines.push("Call write_listing_copy with the finished listing.");
  content.push({ type: "text", text: lines.join("\n\n") });

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? { type: "text", text: LISTING_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
    : { type: "text", text: LISTING_SYSTEM_PROMPT };

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    ...(temperature !== undefined ? { temperature } : {}),
    system: [systemBlock],
    tools: [LISTING_TOOL],
    tool_choice: { type: "tool", name: "write_listing_copy" },
    messages: [{ role: "user", content }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return listing copy");
  }
  const raw = toolUse.input as { title?: unknown; description?: unknown };
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  if (!title && !description) {
    throw new Error("AI returned empty listing copy");
  }

  return {
    title,
    description,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

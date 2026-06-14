// Vision helpers for Photo Dump Reconciliation (US-283, US-286).
//
// Two focused Claude Vision calls used by the reconcile board:
//   • classifyPhotoTypes — label each photo as front|back|tag|detail|defect|
//     flatlay|on_model so a freshly-committed cluster has sensible photo_types.
//   • groupSimilarPhotos — find sets of photos that show the SAME garment so the
//     optional visual second pass can merge out-of-order shots.
//
// Both accept images either as public URLs or inline base64 (the reconcile
// board sends downscaled base64 because dump photos aren't uploaded yet).
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, getDefaultModel, getAiTemperature } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";

export interface VisionImage {
  /** Public URL (post-upload) … */
  url?: string;
  /** … or inline base64 (pre-upload dump photos). */
  data?: string;
  mediaType?: string;
}

// The reconcile photo-type vocabulary (US-286 AC). A subset of FlipdeskPhotoType.
export const RECONCILE_PHOTO_TYPES = [
  "front",
  "back",
  "tag",
  "detail",
  "defect",
  "flatlay",
  "on_model",
] as const;
export type ReconcilePhotoType = (typeof RECONCILE_PHOTO_TYPES)[number];

export interface PhotoClassification {
  index: number;
  type: ReconcilePhotoType;
  confidence: number;
}

function imageBlock(img: VisionImage): Anthropic.ContentBlockParam {
  if (img.url) {
    return { type: "image", source: { type: "url", url: img.url } };
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: (img.mediaType ?? "image/jpeg") as
        | "image/jpeg"
        | "image/png"
        | "image/webp"
        | "image/gif",
      data: img.data ?? "",
    },
  };
}

function captionedContent(images: VisionImage[], trailingPrompt: string): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: "text", text: `Photo ${i}:` });
    content.push(imageBlock(img));
  });
  content.push({ type: "text", text: trailingPrompt });
  return content;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_photos",
  description:
    "Classify each provided clothing photo into exactly one shot type. Index matches the 'Photo N' caption (0-based).",
  input_schema: {
    type: "object",
    properties: {
      classifications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number" },
            type: { type: "string", enum: [...RECONCILE_PHOTO_TYPES] },
            confidence: { type: "number", description: "0..1" },
          },
          required: ["index", "type", "confidence"],
        },
      },
    },
    required: ["classifications"],
  },
};

const SIMILAR_TOOL: Anthropic.Tool = {
  name: "group_same_garment",
  description:
    "Group photo indices that depict the SAME physical garment/item. Each group is a list of 0-based photo indices. A photo shown alone is its own single-element group.",
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        items: { type: "array", items: { type: "number" } },
      },
    },
    required: ["groups"],
  },
};

/** Classify each photo into a reconcile photo type. Index is 0-based. */
export async function classifyPhotoTypes(images: VisionImage[]): Promise<PhotoClassification[]> {
  if (images.length === 0) return [];
  enterAiFeature("reconcile"); // US-894 spend attribution
  const client = getAnthropicClient();
  const temperature = getAiTemperature();
  const response = await client.messages.create({
    model: getDefaultModel(),
    max_tokens: 1024,
    ...(temperature !== undefined ? { temperature } : {}),
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_photos" },
    messages: [
      {
        role: "user",
        content: captionedContent(
          images,
          "Classify each photo above into one shot type. front=full front of garment, back=full back, tag=brand/size/care label close-up, detail=fabric/hardware close-up, defect=damage/flaw, flatlay=laid flat top-down, on_model=worn by a person.",
        ),
      },
    ],
  });
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return [];
  const raw = (toolUse.input as { classifications?: unknown }).classifications;
  if (!Array.isArray(raw)) return [];
  const out: PhotoClassification[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as { index?: unknown; type?: unknown; confidence?: unknown };
    if (
      typeof o.index === "number" &&
      typeof o.type === "string" &&
      (RECONCILE_PHOTO_TYPES as readonly string[]).includes(o.type)
    ) {
      out.push({
        index: o.index,
        type: o.type as ReconcilePhotoType,
        confidence: typeof o.confidence === "number" ? o.confidence : 0.5,
      });
    }
  }
  return out;
}

/** Returns same-garment groups of 0-based photo indices. */
export async function groupSimilarPhotos(images: VisionImage[]): Promise<number[][]> {
  if (images.length < 2) return images.map((_, i) => [i]);
  enterAiFeature("reconcile"); // US-894 spend attribution
  const client = getAnthropicClient();
  const temperature = getAiTemperature();
  const response = await client.messages.create({
    model: getDefaultModel(),
    max_tokens: 1024,
    ...(temperature !== undefined ? { temperature } : {}),
    tools: [SIMILAR_TOOL],
    tool_choice: { type: "tool", name: "group_same_garment" },
    messages: [
      {
        role: "user",
        content: captionedContent(
          images,
          "Group the photos that show the same physical garment together (same item from different angles/closeups). Return groups of 0-based photo indices.",
        ),
      },
    ],
  });
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return images.map((_, i) => [i]);
  const raw = (toolUse.input as { groups?: unknown }).groups;
  if (!Array.isArray(raw)) return images.map((_, i) => [i]);
  const groups: number[][] = [];
  for (const g of raw) {
    if (Array.isArray(g)) {
      const idxs = g.filter((n): n is number => typeof n === "number" && n >= 0 && n < images.length);
      if (idxs.length > 0) groups.push(idxs);
    }
  }
  return groups.length > 0 ? groups : images.map((_, i) => [i]);
}

/** Converts same-garment groups into the flat similar-pair list the board expects. */
export function groupsToPairs(groups: number[][], ids: string[]): Array<{ a: string; b: string }> {
  const pairs: Array<{ a: string; b: string }> = [];
  for (const g of groups) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = ids[g[i]!];
        const b = ids[g[j]!];
        if (a && b) pairs.push({ a, b });
      }
    }
  }
  return pairs;
}

const MATCH_HINTS_TOOL: Anthropic.Tool = {
  name: "item_match_hints",
  description:
    "From clothing photos (especially the brand/size tag and front), return the brand and a few short keywords (item type, model, color, distinctive features) that would help match this to an existing catalog entry. Omit anything you can't read confidently.",
  input_schema: {
    type: "object",
    properties: {
      brand: { type: "string", description: "Brand/maker, or empty if unreadable" },
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "3-6 short matching keywords",
      },
      confidence: { type: "number", description: "0..1 confidence in these hints" },
    },
    required: ["keywords", "confidence"],
  },
};

export interface MatchHints {
  brand: string | null;
  keywords: string[];
  confidence: number;
}

/** Extracts brand + keyword hints from a cluster's photos for item matching. */
export async function extractMatchHints(images: VisionImage[]): Promise<MatchHints> {
  if (images.length === 0) return { brand: null, keywords: [], confidence: 0 };
  enterAiFeature("reconcile"); // US-894 spend attribution
  const client = getAnthropicClient();
  const temperature = getAiTemperature();
  const response = await client.messages.create({
    model: getDefaultModel(),
    max_tokens: 512,
    ...(temperature !== undefined ? { temperature } : {}),
    tools: [MATCH_HINTS_TOOL],
    tool_choice: { type: "tool", name: "item_match_hints" },
    messages: [
      {
        role: "user",
        content: captionedContent(
          images,
          "Read the brand/size tag and identify this garment. Return brand + short matching keywords.",
        ),
      },
    ],
  });
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return { brand: null, keywords: [], confidence: 0 };
  const raw = toolUse.input as { brand?: unknown; keywords?: unknown; confidence?: unknown };
  const brand = typeof raw.brand === "string" && raw.brand.trim() ? raw.brand.trim() : null;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : [];
  const confidence = typeof raw.confidence === "number" ? raw.confidence : 0.5;
  return { brand, keywords, confidence };
}


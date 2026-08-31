// The one vision call /prospect spends on naming the garment (US-3026).
//
// WHAT IT REPLACES, AND WHY A NEW FUNCTION. /prospect identified through
// `extractMatchHints`, which was written for Photo Dump Reconciliation (US-283).
// Reconcile is matching a photo to an inventory row it already has, so "brand
// plus three-to-six short keywords" is exactly right there: it only has to be
// enough to pick the correct row out of a list the seller already typed.
//
// /prospect has no list. Its output IS the product name, the comp query and the
// link a human clicks, and a flat keyword bag cannot serve those three - see
// prospect-query.ts for why they want different words. The measured failure was
// a We The Free off-the-shoulder cropped top coming back as "We The Free",
// which is a perfectly good reconcile hint and a useless sourcing answer.
//
// So this asks for FIELDS: type, colour, cut, material, size, style code. Same
// one metered AI action, same photos, a different question. Reconcile keeps the
// function it was written for, unchanged - editing that prompt to serve this
// route would have changed matching behaviour on a board nobody was complaining
// about.
//
// THE OTHER HALF: THE PHOTOS ARE LABELLED. extractMatchHints captions its
// images "Photo 0", "Photo 1" and leaves the model to work out which one is the
// tag. /prospect knows - the seller filled named slots (US-2923) - and telling
// it costs nothing. A model that knows photo 1 is a care label stops trying to
// read a silhouette out of it.

import Anthropic from "@anthropic-ai/sdk";
import { getAiTemperature, getAnthropicClient, getDefaultModel } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import type { VisionImage } from "./ai-reconcile.ts";
import { emptyIdentity, type GarmentIdentity } from "./prospect-query.ts";

/** A photo plus what the seller said it shows. */
export interface RoledVisionImage extends VisionImage {
  /** "front", "tag", "back", "flatlay", "label", or null when unlabelled. */
  role?: string | null;
}

const ROLE_CAPTIONS: Readonly<Record<string, string>> = {
  front: "Photo of the whole garment (front)",
  back: "Photo of the whole garment (back)",
  flatlay: "Photo of the whole garment, laid flat",
  tag: "Close-up of the brand/size tag",
  label: "Close-up of the care or brand label",
};

function captionFor(role: string | null | undefined, index: number): string {
  const key = typeof role === "string" ? role.trim().toLowerCase() : "";
  const named = ROLE_CAPTIONS[key];
  return named ? `${named}:` : `Photo ${index}:`;
}

function imageBlock(img: VisionImage): Anthropic.ContentBlockParam {
  if (img.url) return { type: "image", source: { type: "url", url: img.url } };
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

const IDENTIFY_TOOL: Anthropic.Tool = {
  name: "identify_garment",
  description:
    "Name a single second-hand garment precisely enough that a reseller could find the same item in eBay's sold listings. Read any tag in frame for the brand, size and style code; describe the garment itself from the full-garment photo. Leave a field out entirely rather than guessing at it.",
  input_schema: {
    type: "object",
    properties: {
      brand: {
        type: "string",
        description:
          "Brand exactly as printed on the tag, in its own capitalisation. Prefer the specific sub-label over the parent house when both appear (We The Free, not Free People). Omit if no tag text is legible.",
      },
      garment_type: {
        type: "string",
        description:
          "What the garment IS, one to three words, as a reseller would title it: 'cropped top', 'flannel shirt', 'wide leg jean', 'quarter zip pullover'. Not a category path.",
      },
      color: {
        type: "string",
        description: "The single dominant colour, one word.",
      },
      descriptors: {
        type: "array",
        items: { type: "string" },
        description:
          "Up to 4 short phrases that make THIS garment findable rather than describing garments in general: neckline, sleeve, cut, pattern, closure ('off the shoulder', 'balloon sleeve', 'ribbed', 'floral'). Skip anything true of most clothes.",
      },
      material: {
        type: "string",
        description: "Main fabric if the care label states it ('cotton', 'merino wool').",
      },
      gender: {
        type: "string",
        enum: ["women", "men", "unisex", "kids"],
        description: "Who it is cut for, if the tag or cut makes it clear.",
      },
      size: { type: "string", description: "Size as printed on the tag." },
      style_code: {
        type: "string",
        description:
          "The brand's own product/style number off the tag (LW7DVCS, 511-0011). Only if you can read every character.",
      },
      confidence: {
        type: "number",
        description: "0..1, how sure you are of the brand and garment type together.",
      },
    },
    required: ["confidence"],
  },
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Identify one garment from its photos. One Anthropic call, one AI action.
 *
 * Never throws for a shape it did not expect: a response with no tool call, or
 * with fields the model invented, degrades to an empty identity, and the route
 * treats that exactly as it treats an unreadable photo. It DOES propagate a
 * transport or capacity failure, because the caller has an AI action reserved
 * and has to know to refund it.
 */
export async function identifyProspectGarment(
  images: RoledVisionImage[],
): Promise<GarmentIdentity> {
  if (images.length === 0) return emptyIdentity();

  enterAiFeature("prospect_identify"); // US-894 spend attribution
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  const content: Anthropic.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: "text", text: captionFor(img.role, i) });
    content.push(imageBlock(img));
  });
  content.push({
    type: "text",
    text:
      "Identify this one garment for resale. Read the tag for brand, size and style code; " +
      "read the garment photo for type, colour and cut. Be specific about the cut - " +
      "'cropped top' and 'off the shoulder' are what a buyer searches for, 'top' is not. " +
      "If you cannot read something, leave that field out rather than guessing.",
  });

  const response = await client.messages.create({
    model: getDefaultModel(),
    max_tokens: 512,
    ...(temperature !== undefined ? { temperature } : {}),
    tools: [IDENTIFY_TOOL],
    tool_choice: { type: "tool", name: IDENTIFY_TOOL.name },
    messages: [{ role: "user", content }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return emptyIdentity();
  const raw = toolUse.input as Record<string, unknown>;

  const id = emptyIdentity();
  id.brand = str(raw.brand);
  id.garmentType = str(raw.garment_type);
  id.color = str(raw.color);
  id.material = str(raw.material);
  id.size = str(raw.size);
  id.styleCode = str(raw.style_code);
  const gender = str(raw.gender)?.toLowerCase() ?? null;
  id.gender = gender && ["women", "men", "unisex", "kids"].includes(gender) ? gender : null;
  id.descriptors = Array.isArray(raw.descriptors)
    ? raw.descriptors
      .map((d) => str(d))
      .filter((d): d is string => d !== null)
      .slice(0, 4)
    : [];
  // A model that omits confidence is not thereby confident. 0.5 matches what
  // extractMatchHints assumed in the same spot, so the review threshold sees
  // the number it has always seen.
  id.confidence = typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1
    ? raw.confidence
    : 0.5;
  return id;
}

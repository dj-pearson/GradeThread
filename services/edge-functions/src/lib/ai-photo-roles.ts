// US-533: AI cover-photo selection + per-photo role tagging for an AutoLister
// group. A single vision pass looks at all of a group's photos at once, picks
// the strongest front/cover shot, and assigns every other photo a gallery role
// (back/tag/detail/defect). The frontend uses this to order the listing gallery
// — cover first — instead of the old "first photo = front, rest = detail".
//
// Returns the cover + a role map keyed by the caller's own photo ids, plus the
// model + token usage so the route can attribute cost. The Anthropic call is
// isolated from the pure mapping (normalizeRoleResult) so the mapping/fallbacks
// are unit-testable without hitting the API.

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, getDefaultModel } from "./ai-config.ts";
import { withRetry } from "./retry.ts";

// The subset of flipdesk_photo_type roles this pass assigns. Kept in sync with
// the enum in 00008_flipdesk_schema.sql (front|back|tag|detail|defect|...).
export const PHOTO_ROLES = ["front", "back", "tag", "detail", "defect"] as const;
export type PhotoRole = (typeof PHOTO_ROLES)[number];

export interface RolePhoto {
  id: string;
  url: string;
}

export interface PhotoRoleResult {
  coverId: string;
  roles: Record<string, PhotoRole>;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const TAG_PHOTOS_TOOL: Anthropic.Tool = {
  name: "tag_photos",
  description:
    "Choose the single best cover (front) photo and assign a role to every photo in the set.",
  input_schema: {
    type: "object",
    properties: {
      cover_index: {
        type: "integer",
        description: "1-based index of the best front/cover photo for the gallery.",
      },
      photos: {
        type: "array",
        description: "One entry per photo, each tagged with its role.",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "1-based photo index." },
            role: { type: "string", enum: [...PHOTO_ROLES] },
          },
          required: ["index", "role"],
        },
      },
    },
    required: ["cover_index", "photos"],
  },
};

const SYSTEM =
  "You are a product-photography assistant for an apparel reseller. You order a " +
  "listing's photo gallery by classifying each image and choosing the strongest " +
  "cover shot. Every photo gets exactly one role.";

function userInstructions(): string {
  return [
    "Assign each photo a role and pick the single best cover (front) photo, then call tag_photos.",
    "Roles:",
    "- front: the full garment laid out or on a hanger/model — best for the gallery cover.",
    "- back: the reverse side of the garment.",
    "- tag: a brand, size, or care label / interior tag.",
    "- detail: a close-up of fabric, stitching, hardware, print, or a logo.",
    "- defect: visible damage, a flaw, stain, hole, pilling, or wear.",
    "Choose the clearest, best-lit, most complete full-item shot as the cover. The cover must be a 'front'.",
  ].join("\n");
}

/**
 * Map the model's 1-based tool output onto the caller's photo ids with safe
 * fallbacks: every photo defaults to "detail", out-of-range/invalid entries are
 * ignored, the cover resolves to the model's pick (else an explicit "front",
 * else the first photo), and the resolved cover is always forced to "front".
 * Pure — no network — so it can be unit-tested directly.
 */
export function normalizeRoleResult(
  rawCoverIndex: unknown,
  rawRoles: unknown,
  photos: RolePhoto[],
): { coverId: string; roles: Record<string, PhotoRole> } {
  const roleSet = PHOTO_ROLES as readonly string[];
  const roles: Record<string, PhotoRole> = {};
  for (const p of photos) roles[p.id] = "detail";

  if (Array.isArray(rawRoles)) {
    for (const entry of rawRoles) {
      const idx = Number((entry as { index?: unknown })?.index);
      const role = (entry as { role?: unknown })?.role;
      const photo = Number.isInteger(idx) ? photos[idx - 1] : undefined;
      if (photo && typeof role === "string" && roleSet.includes(role)) {
        roles[photo.id] = role as PhotoRole;
      }
    }
  }

  const coverIdx = Number(rawCoverIndex);
  let coverId =
    Number.isInteger(coverIdx) && photos[coverIdx - 1]
      ? photos[coverIdx - 1]!.id
      : "";
  if (!coverId) {
    const front = photos.find((p) => roles[p.id] === "front");
    coverId = front?.id ?? photos[0]?.id ?? "";
  }
  // The gallery cover is, by definition, the front shot.
  if (coverId) roles[coverId] = "front";

  return { coverId, roles };
}

/** Run the vision pass for one group's photos. Throws on API failure. */
export async function classifyPhotoRoles(
  photos: RolePhoto[],
): Promise<PhotoRoleResult> {
  if (photos.length === 0) {
    throw new Error("classifyPhotoRoles requires at least one photo");
  }

  const model = getDefaultModel(); // vision-capable
  const client = getAnthropicClient();

  const content: Anthropic.ContentBlockParam[] = [];
  photos.forEach((photo, i) => {
    content.push({ type: "text", text: `Photo ${i + 1}:` });
    content.push({ type: "image", source: { type: "url", url: photo.url } });
  });
  content.push({ type: "text", text: userInstructions() });

  const response = await withRetry(
    () =>
      client.messages.create({
        model,
        max_tokens: 512,
        system: SYSTEM,
        tools: [TAG_PHOTOS_TOOL],
        tool_choice: { type: "tool", name: "tag_photos" },
        messages: [{ role: "user", content }],
      }),
    {
      onRetry: ({ attempt, delayMs }) =>
        console.warn(
          `[AI PhotoRoles] Anthropic call retry #${attempt} after ${delayMs}ms backoff`,
        ),
    },
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return photo roles");
  }
  const raw = toolUse.input as Record<string, unknown>;
  const { coverId, roles } = normalizeRoleResult(raw.cover_index, raw.photos, photos);

  return {
    coverId,
    roles,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

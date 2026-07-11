// US-1904: AI propose-groups for AutoLister intake. When a seller dumps photos
// with no usable EXIF (exports, screenshots, some cameras), auto-grouping leaves
// them as per-photo singletons and the grouping work lands on the seller. A
// cheap vision pass over the photos IN SHOOTING ORDER proposes where one item
// ends and the next begins ("photos 1–6 = one garment; 7 starts a new item").
//
// The model reports BOUNDARIES (the photo numbers that start a new item); the
// pure `boundariesToGroups` maps them onto contiguous runs of the caller's photo
// ids. Writes NOTHING — the client applies proposals through the US-1543
// undoable grouping mutations, and low-confidence boundaries render as review
// chips instead of being silently applied. Runs under the US-1065 action cascade
// (lightweight model first, escalate to default only on an unparseable result).

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import {
  getActionCascadeConfig,
  runActionCascade,
} from "./ai-action-cascade.ts";
import { withRetry } from "./retry.ts";

export interface ProposePhoto {
  id: string;
  /** A thumbnail URL — propose works off thumbnails, not full images. */
  url: string;
}

export interface ProposedGroup {
  photo_ids: string[];
  /** 0..1 — the model's confidence that a new item starts at this boundary. */
  confidence: number;
  reason: string;
}

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_item_boundaries",
  description:
    "Given photos of second-hand apparel in shooting order, report the photo " +
    "numbers where a NEW item begins. Photo 1 always begins the first item.",
  input_schema: {
    type: "object",
    properties: {
      boundaries: {
        type: "array",
        description:
          "Each photo number (1-based) at which a new item begins, in order. Always include 1.",
        items: {
          type: "object",
          properties: {
            photo: {
              type: "integer",
              description: "1-based photo number that STARTS a new item.",
            },
            confidence: {
              type: "number",
              description: "0..1 confidence that a new item starts here.",
            },
            reason: { type: "string", description: "One short sentence." },
          },
          required: ["photo", "confidence", "reason"],
        },
      },
    },
    required: ["boundaries"],
  },
};

const SYSTEM =
  "You are grouping an apparel reseller's photo dump into listings. The photos " +
  "are in SHOOTING ORDER: the seller photographs one garment (several angles — " +
  "front, back, tag, detail), then moves to the next. Identify where each new " +
  "garment begins. Judge by the garment itself (shape, color, fabric, print, " +
  "tag), not the background or angle. When unsure, prefer FEWER, larger items " +
  "over splitting one garment across two.";

function userInstructions(n: number): string {
  return [
    `You see ${n} photos labeled P1..P${n} in shooting order.`,
    "Call propose_item_boundaries with the photo numbers where a NEW garment begins.",
    "Always include photo 1 — it starts the first item.",
    "A typical item spans a few consecutive photos (front/back/tag/detail).",
  ].join("\n");
}

interface RawBoundary {
  photo?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

/**
 * Map the model's 1-based boundary photo-numbers onto contiguous groups of the
 * caller's photo ids. Photo 1 is always a boundary (start of the first item);
 * out-of-range/malformed boundaries are dropped and confidence is clamped. Each
 * group carries the boundary's confidence + reason. Pure + unit-tested (deno).
 */
export function boundariesToGroups(
  photos: readonly ProposePhoto[],
  rawBoundaries: unknown,
): ProposedGroup[] {
  const n = photos.length;
  if (n === 0) return [];
  // Boundary index (1-based) → its confidence/reason. Photo 1 is implicit.
  const byIndex = new Map<number, { confidence: number; reason: string }>();
  byIndex.set(1, { confidence: 1, reason: "" });
  if (Array.isArray(rawBoundaries)) {
    for (const b of rawBoundaries as RawBoundary[]) {
      const idx = Number(b?.photo);
      if (!Number.isInteger(idx) || idx < 1 || idx > n) continue;
      byIndex.set(idx, {
        confidence: idx === 1 ? 1 : clamp01(Number(b?.confidence)),
        reason: typeof b?.reason === "string" ? b.reason.trim() : "",
      });
    }
  }
  const starts = [...byIndex.keys()].sort((a, b) => a - b);
  const groups: ProposedGroup[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : n + 1; // exclusive
    const meta = byIndex.get(start)!;
    groups.push({
      photo_ids: photos.slice(start - 1, end - 1).map((p) => p.id),
      confidence: meta.confidence,
      reason: meta.reason,
    });
  }
  return groups;
}

export interface ProposeGroupsResult {
  groups: ProposedGroup[];
  model: string;
  escalated: boolean;
}

/**
 * Run the boundary-proposal vision pass over one window of ordered photos. One
 * API call per model pass (cascade-escalated only when the cheap pass can't
 * produce a parseable result). Fewer than two photos needs no model call.
 * Throws on total failure.
 */
export async function proposeItemGroups(
  photos: ProposePhoto[],
): Promise<ProposeGroupsResult> {
  if (photos.length < 2) {
    return {
      groups: photos.length === 1
        ? [{ photo_ids: [photos[0]!.id], confidence: 1, reason: "" }]
        : [],
      model: "none",
      escalated: false,
    };
  }
  enterAiFeature("autolister_propose_groups"); // US-894 spend attribution

  const client = getAnthropicClient();
  const content: Anthropic.ContentBlockParam[] = [];
  photos.forEach((p, i) => {
    content.push({ type: "text", text: `P${i + 1}:` });
    content.push({ type: "image", source: { type: "url", url: p.url } });
  });
  content.push({ type: "text", text: userInstructions(photos.length) });

  const runOn = async (model: string): Promise<unknown> => {
    const response = await withRetry(
      () =>
        client.messages.create({
          model,
          max_tokens: 1024,
          system: SYSTEM,
          tools: [PROPOSE_TOOL],
          tool_choice: { type: "tool", name: "propose_item_boundaries" },
          messages: [{ role: "user", content }],
        }),
      {
        onRetry: ({ attempt, delayMs }) =>
          console.warn(
            `[AI GroupPropose] Anthropic retry #${attempt} after ${delayMs}ms backoff`,
          ),
      },
    );
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI did not return group boundaries");
    }
    return (toolUse.input as Record<string, unknown>).boundaries;
  };

  const cascade = await runActionCascade<unknown>({
    config: await getActionCascadeConfig(),
    runOn,
    assess: (result) =>
      Array.isArray(result)
        ? { sufficient: true, reason: "ok" }
        : { sufficient: false, reason: "unparseable_boundaries" },
    onEscalate: ({ from, to, reason }) =>
      console.warn(`[AI GroupPropose] escalating ${from} → ${to}: ${reason}`),
  });

  return {
    groups: boundariesToGroups(photos, cascade.result),
    model: cascade.model,
    escalated: cascade.escalated,
  };
}

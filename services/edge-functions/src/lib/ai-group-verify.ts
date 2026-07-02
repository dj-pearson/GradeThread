// US-1544: AI group-boundary verification for AutoLister intake. After
// auto-grouping (EXIF time-gap + filename sequence + dHash), a cheap vision
// pass sanity-checks the PROPOSED grouping before the seller spends one AI
// action per listing generating from it: "groups 3 and 4 look like the same
// jacket — merge?", "photo G2-P5 looks like a different item — move it?".
//
// Cost stays O(groups), not O(photos²): the route samples each group down to
// its boundary shots (first/last — the photos that sit against the adjacent
// group) plus the cover, and ONE vision call sees all of them labeled
// "G<group>-P<photo>". The model only SUGGESTS — [{type: merge|split|move,
// …, confidence, reason}] — and nothing is ever written or auto-applied; the
// web UI renders dismissible chips whose Apply routes through the US-1543
// undoable grouping mutations.
//
// Runs under the US-1065 action cascade: first pass on the lightweight model,
// escalating to the default model only when the cheap pass can't produce a
// parseable result.

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import {
  getActionCascadeConfig,
  runActionCascade,
} from "./ai-action-cascade.ts";
import { withRetry } from "./retry.ts";

export interface VerifyGroupPhoto {
  id: string;
  url: string;
}

export interface VerifyGroup {
  id: string;
  photos: VerifyGroupPhoto[];
}

export const SUGGESTION_TYPES = ["merge", "split", "move"] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];

export interface GroupSuggestion {
  type: SuggestionType;
  /** merge: [a, b] · split: [group] · move: [from, to]. Group IDS (caller's). */
  group_ids: string[];
  /** split/move: the photo ids to split out / move. Empty for merge. */
  photo_ids: string[];
  /** 0..1 — the model's own confidence in the suggestion. */
  confidence: number;
  reason: string;
}

/** One sampled photo sent to the model, labeled G<g>-P<p> (both 1-based). */
export interface SampledPhoto {
  groupIndex: number; // 1-based group number as presented to the model
  photoId: string;
  groupId: string;
  url: string;
  label: string;
}

/**
 * Sample each group down to its boundary shots: first, last, and the cover of
 * a large group tell the boundary/outlier story; middles add cost without
 * signal. Groups are taken in order until `maxPhotos` is exhausted — the
 * caller surfaces `truncated` so the UI can say "verified the first N groups".
 * Pure + unit-tested.
 */
export function sampleGroupsForVerify(
  groups: VerifyGroup[],
  maxPhotos: number,
): { sampled: SampledPhoto[]; groupsCovered: number; truncated: boolean } {
  const sampled: SampledPhoto[] = [];
  let groupsCovered = 0;
  for (const group of groups) {
    const photos = group.photos;
    if (photos.length === 0) continue;
    const picks = photos.length <= 3
      ? photos
      : [photos[0]!, photos[Math.floor(photos.length / 2)]!, photos[photos.length - 1]!];
    if (sampled.length + picks.length > maxPhotos) {
      return { sampled, groupsCovered, truncated: true };
    }
    const groupIndex = groupsCovered + 1;
    picks.forEach((p, i) => {
      sampled.push({
        groupIndex,
        photoId: p.id,
        groupId: group.id,
        url: p.url,
        label: `G${groupIndex}-P${i + 1}`,
      });
    });
    groupsCovered++;
  }
  return { sampled, groupsCovered, truncated: false };
}

const SUGGEST_TOOL: Anthropic.Tool = {
  name: "suggest_group_fixes",
  description:
    "Report grouping mistakes in the proposed listing groups. Return an empty " +
    "array when the grouping looks correct.",
  input_schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: [...SUGGESTION_TYPES] },
            group_a: {
              type: "integer",
              description: "1-based group number the suggestion is about.",
            },
            group_b: {
              type: "integer",
              description:
                "merge: the other group to merge with; move: the destination group. Omit for split.",
            },
            photo_labels: {
              type: "array",
              items: { type: "string" },
              description:
                "split/move: the photo labels (e.g. \"G2-P3\") to split out or move. Empty for merge.",
            },
            confidence: { type: "number", description: "0..1" },
            reason: { type: "string", description: "One short sentence." },
          },
          required: ["type", "group_a", "confidence", "reason"],
        },
      },
    },
    required: ["suggestions"],
  },
};

const SYSTEM =
  "You are a quality checker for an apparel reseller's photo grouping. Each " +
  "group should contain photos of exactly ONE garment/item that will become " +
  "one listing. You compare groups (especially adjacent ones, shot back to " +
  "back) and flag likely mistakes. Only flag what you can visually justify; " +
  "an empty suggestions array is the correct answer for a good grouping.";

function userInstructions(groupsCovered: number): string {
  return [
    `You saw sampled photos from ${groupsCovered} proposed groups, labeled G<group>-P<photo>.`,
    "Call suggest_group_fixes with any of:",
    "- merge: two groups (usually adjacent numbers) that show the SAME item.",
    "- split: one group that clearly contains MORE THAN ONE distinct item — list the photo labels that belong to the other item.",
    "- move: photo(s) that belong in a different group — list the labels and the destination group_b.",
    "Judge by the garment itself (shape, color, fabric, print), not the background or angle.",
    "Be conservative: suggest only when reasonably confident, and set confidence honestly.",
  ].join("\n");
}

interface RawSuggestion {
  type?: unknown;
  group_a?: unknown;
  group_b?: unknown;
  photo_labels?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

/**
 * Map the model's group numbers / photo labels back onto the caller's ids,
 * dropping malformed or out-of-range entries and clamping confidence. Pure +
 * unit-tested.
 */
export function normalizeGroupSuggestions(
  raw: unknown,
  sampled: SampledPhoto[],
  groupIdsInOrder: string[],
): GroupSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const byLabel = new Map(sampled.map((p) => [p.label, p]));
  const groupIdOf = (n: unknown): string | null => {
    const idx = Number(n);
    return Number.isInteger(idx) ? (groupIdsInOrder[idx - 1] ?? null) : null;
  };

  const out: GroupSuggestion[] = [];
  for (const entry of raw as RawSuggestion[]) {
    const type = typeof entry?.type === "string" ? entry.type : "";
    if (!(SUGGESTION_TYPES as readonly string[]).includes(type)) continue;
    const groupA = groupIdOf(entry.group_a);
    if (!groupA) continue;
    const groupB = groupIdOf(entry.group_b);
    const confidence = Number(entry.confidence);
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    const photoIds = Array.isArray(entry.photo_labels)
      ? entry.photo_labels
        .map((l) => (typeof l === "string" ? byLabel.get(l)?.photoId : undefined))
        .filter((id): id is string => !!id)
      : [];

    if (type === "merge") {
      if (!groupB || groupB === groupA) continue;
      out.push({
        type: "merge",
        group_ids: [groupA, groupB],
        photo_ids: [],
        confidence: clamp01(confidence),
        reason,
      });
    } else if (type === "split") {
      if (photoIds.length === 0) continue;
      out.push({
        type: "split",
        group_ids: [groupA],
        photo_ids: photoIds,
        confidence: clamp01(confidence),
        reason,
      });
    } else {
      // move
      if (!groupB || groupB === groupA || photoIds.length === 0) continue;
      out.push({
        type: "move",
        group_ids: [groupA, groupB],
        photo_ids: photoIds,
        confidence: clamp01(confidence),
        reason,
      });
    }
  }
  return out;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

export interface VerifyGroupsResult {
  suggestions: GroupSuggestion[];
  model: string;
  escalated: boolean;
  groupsCovered: number;
  truncated: boolean;
}

/**
 * Run the boundary-verification vision pass over sampled groups. One API call
 * per model pass (lightweight first, cascade-escalated only when the cheap
 * pass can't produce a parseable tool result). Throws on total failure.
 */
export async function verifyGroupBoundaries(
  groups: VerifyGroup[],
  maxPhotos: number,
): Promise<VerifyGroupsResult> {
  const { sampled, groupsCovered, truncated } = sampleGroupsForVerify(groups, maxPhotos);
  if (groupsCovered < 2) {
    // Nothing to compare — a single (or zero) group has no boundaries.
    return { suggestions: [], model: "none", escalated: false, groupsCovered, truncated };
  }
  enterAiFeature("autolister_verify_groups"); // US-894 spend attribution

  const client = getAnthropicClient();
  const groupIdsInOrder: string[] = [];
  for (const p of sampled) {
    if (groupIdsInOrder[p.groupIndex - 1] === undefined) {
      groupIdsInOrder[p.groupIndex - 1] = p.groupId;
    }
  }

  const content: Anthropic.ContentBlockParam[] = [];
  for (const p of sampled) {
    content.push({ type: "text", text: `${p.label}:` });
    content.push({ type: "image", source: { type: "url", url: p.url } });
  }
  content.push({ type: "text", text: userInstructions(groupsCovered) });

  const runOn = async (model: string): Promise<unknown> => {
    const response = await withRetry(
      () =>
        client.messages.create({
          model,
          max_tokens: 1024,
          system: SYSTEM,
          tools: [SUGGEST_TOOL],
          tool_choice: { type: "tool", name: "suggest_group_fixes" },
          messages: [{ role: "user", content }],
        }),
      {
        onRetry: ({ attempt, delayMs }) =>
          console.warn(
            `[AI GroupVerify] Anthropic retry #${attempt} after ${delayMs}ms backoff`,
          ),
      },
    );
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI did not return group suggestions");
    }
    return (toolUse.input as Record<string, unknown>).suggestions;
  };

  const cascade = await runActionCascade<unknown>({
    config: await getActionCascadeConfig(),
    runOn,
    // The lightweight pass is sufficient whenever it produced a well-formed
    // suggestions array (empty is a legitimate "grouping looks right").
    assess: (result) =>
      Array.isArray(result)
        ? { sufficient: true, reason: "ok" }
        : { sufficient: false, reason: "unparseable_suggestions" },
    onEscalate: ({ from, to, reason }) =>
      console.warn(`[AI GroupVerify] escalating ${from} → ${to}: ${reason}`),
  });

  return {
    suggestions: normalizeGroupSuggestions(cascade.result, sampled, groupIdsInOrder),
    model: cascade.model,
    escalated: cascade.escalated,
    groupsCovered,
    truncated,
  };
}

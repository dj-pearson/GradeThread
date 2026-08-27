// US-537: AI photo-QA readiness score for an AutoLister item. One vision pass
// over the item's gallery scores listing-readiness 0-100 and returns concrete,
// actionable issues (blurry, dark, tag unreadable, missing back, …) so the
// queue can nudge the seller to reshoot before publishing.
//
// Reuses the same Anthropic vision approach as the grading/listing passes. The
// Anthropic call is isolated from the pure mapping (normalizeQaResult) so the
// scoring/coercion is unit-testable without the API.

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, getPhotoQaModel } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { withRetry } from "./retry.ts";

// US-2681: the §11 cover-photo vocabulary lives in ./cover-photo-spec.ts, so
// the PURE publish-preflight can read it without importing this module and
// with it the Anthropic SDK. Re-exported here because callers of the assessor
// reasonably expect the issue types beside the assessor.
export {
  type CoverIssueType,
  COVER_ISSUE_TYPES,
  coverPhotoAssessment,
  type CoverPhotoAssessment,
  type CoverPhotoStatus,
  coverPhotoWarnings,
  isCoverIssue,
} from "./cover-photo-spec.ts";
import { COVER_ISSUE_TYPES, isCoverIssue } from "./cover-photo-spec.ts";

export const QA_ISSUE_TYPES = [
  "blurry",
  "dark",
  "overexposed",
  "cropped",
  "low_resolution",
  "cluttered_background",
  "glare",
  "tag_unreadable",
  "missing_angle",
  ...COVER_ISSUE_TYPES,
  "other",
] as const;
export type QaIssueType = (typeof QA_ISSUE_TYPES)[number];


export const QA_SEVERITIES = ["low", "medium", "high"] as const;
export type QaSeverity = (typeof QA_SEVERITIES)[number];

export interface QaPhoto {
  url: string;
  type?: string; // front | back | tag | detail | defect …
}

export interface QaIssue {
  type: QaIssueType;
  severity: QaSeverity;
  message: string;
  photoIndex: number | null; // 1-based; null for set-level issues
}

export interface PhotoQaResult {
  score: number; // 0-100
  issues: QaIssue[];
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const QA_TOOL: Anthropic.Tool = {
  name: "report_photo_quality",
  description:
    "Score the item's listing photos 0-100 for readiness and list concrete issues.",
  input_schema: {
    type: "object",
    properties: {
      score: {
        type: "integer",
        description:
          "0-100 listing-readiness. 90+ = clean, well-lit, all key angles present; " +
          "<50 = serious problems (blurry/dark/missing angles) a buyer would notice.",
      },
      issues: {
        type: "array",
        description: "Specific, actionable problems. Empty if the photos are great.",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: [...QA_ISSUE_TYPES] },
            severity: { type: "string", enum: [...QA_SEVERITIES] },
            message: {
              type: "string",
              description:
                "One short sentence telling the seller exactly what to fix or reshoot.",
            },
            photo_index: {
              type: ["integer", "null"],
              description:
                "1-based index of the offending photo, or null for a set-level issue " +
                "(e.g. a missing back or tag shot).",
            },
          },
          required: ["type", "severity", "message"],
        },
      },
    },
    required: ["score", "issues"],
  },
};

const SYSTEM =
  "You are a quality-control assistant for an apparel reseller. You judge whether " +
  "a listing's photos are ready to publish and flag anything a buyer would dislike: " +
  "blur, poor lighting (too dark/bright), glare, tight crops, low resolution, busy " +
  "backgrounds, unreadable brand/size tags, and missing key angles (front, back, tag, " +
  "a close detail). Be strict but fair, and make every issue an actionable fix.\n\n" +
  // US-2681: the cover-photo half. Stated as a separate job with an explicit
  // scope, because the failure mode is the model applying it to photo 3.
  "SEPARATELY, judge PHOTO 1 ONLY against eBay image search, which matches a " +
  "buyer's query picture against listing images. Photo 1 must be one garment " +
  "filling the frame on a plain, high-contrast background, with no props, hands " +
  "or other items in shot. Use cover_garment_small, cover_multiple_garments, " +
  "cover_busy_background and cover_prop_in_frame for these, and use them ONLY for " +
  "photo 1. A tag close-up or a detail shot is SUPPOSED to be a fragment of the " +
  "garment — never report a cover_ issue against one.";

function clampScore(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Coerce the model's tool output to a clean PhotoQaResult shape. Unknown issue
 * types collapse to "other", bad severities to "medium", out-of-range photo
 * indices to null, and messages are trimmed/capped. Pure — unit-testable.
 */
export function normalizeQaResult(
  rawScore: unknown,
  rawIssues: unknown,
  photoCount: number,
): { score: number; issues: QaIssue[] } {
  const typeSet = QA_ISSUE_TYPES as readonly string[];
  const sevSet = QA_SEVERITIES as readonly string[];
  const issues: QaIssue[] = [];
  if (Array.isArray(rawIssues)) {
    for (const raw of rawIssues) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as {
        type?: unknown;
        severity?: unknown;
        message?: unknown;
        photo_index?: unknown;
      };
      const message = typeof o.message === "string" ? o.message.trim().slice(0, 300) : "";
      if (!message) continue;
      const type = (typeof o.type === "string" && typeSet.includes(o.type)
        ? o.type
        : "other") as QaIssueType;
      const severity = (typeof o.severity === "string" && sevSet.includes(o.severity)
        ? o.severity
        : "medium") as QaSeverity;
      const idx = Number(o.photo_index);
      const photoIndex =
        Number.isInteger(idx) && idx >= 1 && idx <= photoCount ? idx : null;

      // US-2681 (AC2): the slot-1 scope is ENFORCED here, not asked for in the
      // prompt and hoped for. A cover_ issue against photo 3 is dropped
      // outright: a detail shot is meant to be a fragment of the garment and a
      // tag close-up is meant to fill the frame with a label, so reporting one
      // against either is telling the seller to ruin a correct photo. The
      // prompt says the same thing, but a prompt is a request and this is the
      // guarantee.
      if (isCoverIssue(type) && photoIndex !== 1) continue;

      issues.push({ type, severity, message, photoIndex });
    }
  }
  return { score: clampScore(rawScore), issues };
}

/** Run the photo-QA vision pass for one item's gallery. Throws on API failure. */
export async function assessPhotoQuality(
  photos: QaPhoto[],
): Promise<PhotoQaResult> {
  if (photos.length === 0) {
    throw new Error("assessPhotoQuality requires at least one photo");
  }
  enterAiFeature("photo_qa"); // US-894 spend attribution

  // US-2924: the cheap model by default. The result is a listing-readiness
  // score, not a grade - but it IS a gate: auto-publish-green.ts publishes a
  // draft with no human look once the score reaches AUTO_PUBLISH_QA_MIN, and
  // that floor was set against full-model scores. PHOTO_QA_AI_MODEL rolls this
  // back without a deploy if the scores move.
  const model = getPhotoQaModel(); // vision-capable
  const client = getAnthropicClient();

  const content: Anthropic.ContentBlockParam[] = [];
  photos.forEach((photo, i) => {
    content.push({
      type: "text",
      text: `Photo ${i + 1}${photo.type ? ` (${photo.type})` : ""}:`,
    });
    content.push({ type: "image", source: { type: "url", url: photo.url } });
  });
  content.push({
    type: "text",
    text:
      "Assess these listing photos and call report_photo_quality. Consider sharpness, " +
      "lighting, framing/crop, resolution, background, tag readability, and whether the " +
      "key angles (front, back, tag, a close detail) are present. Flag a missing angle " +
      "with type \"missing_angle\" and photo_index null.",
  });

  const response = await withRetry(
    () =>
      client.messages.create({
        model,
        max_tokens: 900,
        system: SYSTEM,
        tools: [QA_TOOL],
        tool_choice: { type: "tool", name: "report_photo_quality" },
        messages: [{ role: "user", content }],
      }),
    {
      onRetry: ({ attempt, delayMs }) =>
        console.warn(
          `[AI PhotoQA] Anthropic call retry #${attempt} after ${delayMs}ms backoff`,
        ),
    },
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return a photo-QA result");
  }
  const raw = toolUse.input as Record<string, unknown>;
  const { score, issues } = normalizeQaResult(raw.score, raw.issues, photos.length);

  return {
    score,
    issues,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

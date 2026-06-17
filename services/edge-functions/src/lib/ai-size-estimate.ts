// US-1088: Size AI — infer a garment's size + gender/department when the size
// label is missing or cut off (Lululemon is notorious for this). Runs a focused
// vision pass over the item's photos — PRIORITIZING the measurement / flat-lay
// shots — and reasons from any visible measurements plus the model's knowledge
// of the brand's sizing to return a best-guess size, gender, and a calibrated
// confidence.
//
// The Anthropic call (estimateSize) is isolated from the pure decode
// (normalizeSizeEstimate) and the pure photo ordering (prioritizeMeasurement-
// Photos) so both can be unit-tested without hitting the API — same shape as
// ai-tag-ocr.ts.

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, getDefaultModel } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { withRetry } from "./retry.ts";
import {
  findSizingCharts,
  formatSizingChartsForPrompt,
} from "./sizing-charts.ts";

export interface SizePhoto {
  url: string;
  type?: string;
}

export interface SizeEstimate {
  /** Best-guess size label, "" when undeterminable. */
  size: string;
  /** "Men" | "Women" | "Unisex" | "Kids", or null when unknown. */
  gender: string | null;
  /** 0..1 calibrated confidence in the size guess. */
  confidence: number;
  rationale: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

// Below this, the UI labels the result an uncertain "best guess" rather than a
// confident answer (it never auto-applies silently — see US-1088 AC).
export const SIZE_ESTIMATE_LOW_CONFIDENCE = 0.5;

// Measurement / flat-lay photo roles carry the sizing signal (photo-profiles.ts
// emits measurement_chest/waist/length/sleeve/inseam + flatlay). A predicate so
// new measurement_* roles are covered without editing a fixed set.
export function isMeasurementPhoto(type?: string): boolean {
  if (!type) return false;
  return type.startsWith("measurement") || type === "flatlay";
}

const ESTIMATE_SIZE_TOOL: Anthropic.Tool = {
  name: "estimate_size",
  description:
    "Best-guess the garment's size and gender/department from the photos and any " +
    "visible measurements, compared against the brand's known sizing. Used when " +
    "the size label is missing or cut off.",
  input_schema: {
    type: "object",
    properties: {
      size: {
        type: "string",
        description:
          "Best-guess size label the way THIS brand labels it (e.g. 'M', '8', " +
          "'W30 L32', 'EU 42'). Empty string if you genuinely cannot tell.",
      },
      gender: {
        type: "string",
        enum: ["Men", "Women", "Unisex", "Kids", "Unknown"],
        description: "Department/gender the garment is cut for.",
      },
      confidence: {
        type: "number",
        description:
          "0..1 confidence in the size guess. Be honest: cut-off label + no " +
          "readable measurements + unknown brand = low confidence.",
      },
      rationale: {
        type: "string",
        description:
          "One or two sentences: which measurements / brand-sizing reasoning led " +
          "to the guess.",
      },
    },
    required: ["size", "confidence"],
  },
};

const SYSTEM =
  "You are a sizing expert for an apparel reseller. The garment's size label is " +
  "often missing or cut off, so you infer size from the photos. PRIORITIZE the " +
  "measurement / flat-lay photos: read any visible ruler or tape-measure values " +
  "(inches or cm) for chest/bust, waist, hip, inseam, length, and shoulder, and " +
  "compare them against the BRAND'S published size chart for this garment type to " +
  "map to the brand's own size label. Account for how the brand sizes (e.g. " +
  "Lululemon women's bottoms run numeric 0–14). Be calibrated: if you cannot read " +
  "measurements and the brand is unknown, return low confidence rather than a " +
  "confident guess. Then call estimate_size.";

function userInstructions(brand?: string | null, category?: string | null): string {
  const lines = ["Infer this garment's size and gender/department."];
  if (brand && brand.trim()) lines.push(`Brand: ${brand.trim()}`);
  if (category && category.trim()) lines.push(`Category: ${category.trim()}`);
  lines.push(
    "Read measurements off the measurement / flat-lay photos and map them to this " +
      "brand's size chart for this garment type.",
    "Return a single best-guess size, the department/gender, a 0..1 confidence, and " +
      "a short rationale. Then call estimate_size.",
  );
  return lines.join("\n");
}

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Pure decoder for the estimate_size tool output — no network, so it can be
 * unit-tested directly. Normalizes "Unknown"/blank gender to null and clamps the
 * confidence into 0..1.
 */
export function normalizeSizeEstimate(raw: unknown): {
  size: string;
  gender: string | null;
  confidence: number;
  rationale: string;
} {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const size = typeof o.size === "string" ? o.size.trim() : "";
  const g = typeof o.gender === "string" ? o.gender.trim() : "";
  const gender = g && g.toLowerCase() !== "unknown" ? g : null;
  const rationale = typeof o.rationale === "string" ? o.rationale.trim() : "";
  return { size, gender, confidence: clamp01(o.confidence), rationale };
}

/**
 * Order photos so measurement / flat-lay shots come FIRST (the model weights
 * earlier images slightly more, and these carry the sizing signal). Pure; a
 * stable partition that preserves original relative order within each group.
 */
export function prioritizeMeasurementPhotos<T extends SizePhoto>(photos: T[]): T[] {
  const measure = photos.filter((p) => isMeasurementPhoto(p.type));
  const rest = photos.filter((p) => !isMeasurementPhoto(p.type));
  return [...measure, ...rest];
}

/**
 * Run the focused size-estimate vision pass. Throws on API failure so the caller
 * can refund the AI action and return a 502.
 */
export async function estimateSize(input: {
  photos: SizePhoto[];
  brand?: string | null;
  category?: string | null;
}): Promise<SizeEstimate> {
  if (input.photos.length === 0) {
    throw new Error("estimateSize requires at least one photo");
  }
  enterAiFeature("size_estimate"); // US-894 spend attribution

  const model = getDefaultModel(); // vision-capable
  const client = getAnthropicClient();

  const ordered = prioritizeMeasurementPhotos(input.photos);
  const content: Anthropic.ContentBlockParam[] = [];
  ordered.forEach((photo, i) => {
    content.push({
      type: "text",
      text: `Photo ${i + 1}${photo.type ? ` (${photo.type})` : ""}:`,
    });
    content.push({ type: "image", source: { type: "url", url: photo.url } });
  });
  // Inject the relevant brand/category size chart as an authoritative reference
  // (US-1088 knowledge layer) so the model maps measurements → the brand's own
  // label instead of relying on memory. Empty when we have no matching chart.
  const chartText = formatSizingChartsForPrompt(
    findSizingCharts(input.brand, input.category),
  );
  if (chartText) {
    content.push({
      type: "text",
      text:
        "REFERENCE SIZE CHART(S) — approximate; map the measurements you read to " +
        "the closest size, and prefer a brand-specific chart over a generic one:\n" +
        chartText,
    });
  }
  content.push({
    type: "text",
    text: userInstructions(input.brand, input.category),
  });

  const response = await withRetry(
    () =>
      client.messages.create({
        model,
        max_tokens: 512,
        system: SYSTEM,
        tools: [ESTIMATE_SIZE_TOOL],
        tool_choice: { type: "tool", name: "estimate_size" },
        messages: [{ role: "user", content }],
      }),
    {
      onRetry: ({ attempt, delayMs }) =>
        console.warn(
          `[AI SizeEstimate] Anthropic call retry #${attempt} after ${delayMs}ms backoff`,
        ),
    },
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return a size estimate");
  }
  const n = normalizeSizeEstimate(toolUse.input);

  return {
    ...n,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

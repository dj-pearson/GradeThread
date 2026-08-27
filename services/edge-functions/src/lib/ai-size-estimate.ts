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
import { tagImageSource } from "./ai-tag-ocr.ts";
import { getAnthropicClient, getSizeEstimateModel } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { withRetry } from "./retry.ts";
import {
  findSizingCharts,
  formatSizingChartsForPrompt,
  type SizingChart,
} from "./sizing-charts.ts";
// US-1996: the pure size helpers live in ONE place — ai-size-estimate-core.ts —
// which exists so tests can exercise them WITHOUT dragging in the Anthropic
// client and env-gated config this module imports. That rationale is sound; what
// was broken is that this file RE-DECLARED byte-identical copies instead of
// importing them, while ai-size-estimate_test.ts imported the core file. So the
// copies that actually ran were untested and free to drift, and this module's old
// header even claimed it "re-exports everything" from core — it did not, which is
// exactly what made the gap invisible. Import and re-export, so the existing
// suite now covers the live path.
import {
  isMeasurementPhoto,
  normalizeSizeEstimate,
  prioritizeMeasurementPhotos,
  SIZE_ESTIMATE_LOW_CONFIDENCE,
  type SizePhoto,
} from "./ai-size-estimate-core.ts";

export {
  isMeasurementPhoto,
  normalizeSizeEstimate,
  prioritizeMeasurementPhotos,
  SIZE_ESTIMATE_LOW_CONFIDENCE,
};
export type { SizePhoto };

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

/**
 * Run the focused size-estimate vision pass. Throws on API failure so the caller
 * can refund the AI action and return a 502.
 */
export async function estimateSize(input: {
  photos: SizePhoto[];
  brand?: string | null;
  category?: string | null;
  /**
   * US-2214: already-resolved charts, DB-FIRST. Pass
   * `resolveBrandKnowledgePack(...).sizingCharts` and an operator's admin edit
   * actually reaches this call. Omit and it falls back to the in-code seed, as
   * it always did.
   *
   * WHY THIS PARAM EXISTS: until now this function read findSizingCharts()
   * directly, so the DB-first-with-code-fallback pattern the brand KB was built
   * on was NOT wired for the one call that consumes charts. brand_size_charts
   * reached resolveBrandKnowledgePack and stopped there, which meant fixing a
   * wrong chart in the admin UI changed nothing about size estimation.
   */
  charts?: SizingChart[];
  /**
   * Override the vision model (US-2924).
   *
   * Omitted, this runs on getSizeEstimateModel() — Haiku 4.5 by default, chosen
   * because the size pass was the most expensive user AI action measured on
   * production. AutoLister and the FlipDesk route both take that default: a
   * wrong size there is a wrong listing field, which the seller sees and edits.
   *
   * The GRADING PIPELINE passes getDefaultModel() explicitly, and must keep
   * doing so. Its result reaches tagGroundTruthBlock and therefore the grading
   * prompt as trusted ground truth, so changing the model underneath it moves
   * grades with no shadow compare, no golden-set eval and no prompt_version
   * suffix to attribute the era afterwards.
   */
  model?: string;
}): Promise<SizeEstimate> {
  if (input.photos.length === 0) {
    throw new Error("estimateSize requires at least one photo");
  }
  enterAiFeature("size_estimate"); // US-894 spend attribution

  const model = input.model?.trim() || getSizeEstimateModel(); // vision-capable
  const client = getAnthropicClient();

  const ordered = prioritizeMeasurementPhotos(input.photos);
  const content: Anthropic.ContentBlockParam[] = [];
  ordered.forEach((photo, i) => {
    content.push({
      type: "text",
      text: `Photo ${i + 1}${photo.type ? ` (${photo.type})` : ""}:`,
    });
    // US-2213: the same URL/data-URI adapter the tag read uses. FlipDesk passes
    // signed URLs; the grading pipeline passes the base64 it already holds, so
    // the size pass costs no extra download. URL callers are unaffected.
    content.push({ type: "image", source: tagImageSource(photo.url) });
  });
  // Inject the relevant brand/category size chart as an authoritative reference
  // (US-1088 knowledge layer) so the model maps measurements → the brand's own
  // label instead of relying on memory. Empty when we have no matching chart.
  const chartText = formatSizingChartsForPrompt(
    input.charts && input.charts.length > 0
      ? input.charts
      : findSizingCharts(input.brand, input.category),
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

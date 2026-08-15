// US-1573: automatic garment measurement extraction from a calibrated
// MeasureCard photo.
//
// The VLM proposes, classical CV decides: Claude Vision places each
// measurement's two endpoints as NORMALIZED image coordinates (VLMs are good
// at "where is the armpit", unreliable at pixel precision), then a
// deterministic gradient snap moves each endpoint to the nearest garment edge
// along the measurement's own axis. Distances are computed on the CARD PLANE
// via the US-1572 calibration homography — the numbers are real inches, not
// guesses. Everything downstream of the single model call is pure and
// unit-tested.
//
// Billing: ONE AI action per extraction (all measurements in one prompt) —
// the route reserves it via withAiAction; this lib never reserves (metering
// bundling contract, see ai-metering-coverage_test.ts).

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, getDefaultModel } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { withRetry } from "./retry.ts";
import { applyHomography, type GrayImage } from "./measure-detect.ts";
import type { MeasurementField, MeasurementGroup } from "./measurement-templates.ts";

export interface ExtractedMeasurement {
  key: string;
  label: string;
  /** Endpoints in ORIGINAL-image pixels (post-snap). */
  endpoints: [[number, number], [number, number]];
  /** Flat measurement on the card plane, rounded to 0.25in. */
  inches: number;
  /** Model's own 0..1 confidence for this landmark pair. */
  confidence: number;
  /** True when outside the size-prior band or low confidence — review me. */
  flagged: boolean;
  flagReason: string | null;
}

export interface MeasureExtractResult {
  measurements: ExtractedMeasurement[];
  model: string;
  tokensIn: number;
  tokensOut: number;
}

// ── Pure helpers ────────────────────────────────────────────────────

export function roundQuarterInch(v: number): number {
  return Math.round(v * 4) / 4;
}

/**
 * Generous plausibility bands (inches, flat) per group+key, optionally
 * narrowed by the size tag. Outside the band → flag for review (never block).
 */
export function plausibilityBand(
  group: MeasurementGroup,
  key: string,
  sizeLabel: string | null,
): [number, number] | null {
  const size = (sizeLabel ?? "").trim().toUpperCase();
  const bands: Record<string, [number, number]> = {
    "top.chest": [14, 36],
    "top.length": [18, 40],
    "top.shoulder": [12, 26],
    "top.sleeve": [5, 40],
    "outerwear.chest": [14, 38],
    "outerwear.length": [18, 48],
    "outerwear.shoulder": [12, 26],
    "outerwear.sleeve": [5, 40],
    "bottom.waist": [10, 32],
    "bottom.inseam": [4, 40],
    // US-2608: was [6, 20]. A 20in front rise is not a garment — adult rises run
    // roughly 8-13in and the extremes of high-waisted vintage and low-rise still
    // sit inside 7-16. The old ceiling was wide enough to wave through the exact
    // failure this band exists to catch: when the model puts the crotch partway
    // down the leg, the rise absorbs the error and the inseam loses it, and a
    // rise of 17-20in read as plausible.
    "bottom.rise": [7, 16],
    "bottom.hip": [12, 36],
    "bottom.leg_opening": [3, 16],
    "suit.waist": [10, 32],
    "suit.inseam": [4, 40],
    "suit.rise": [7, 16],
    "dress.bust": [12, 34],
    "dress.waist": [10, 32],
    "dress.hip": [12, 36],
    "dress.length": [20, 65],
    "generic.length": [1, 80],
    "generic.width": [1, 80],
    "shoes.insole": [6, 14],
  };
  const base = bands[`${group}.${key}`] ?? null;
  if (!base) return null;
  // Size narrowing for the highest-dispute field: tops/outerwear chest.
  if ((group === "top" || group === "outerwear") && key === "chest") {
    const bySize: Record<string, [number, number]> = {
      XS: [15, 21], S: [16, 22], M: [18, 24], L: [20, 26],
      XL: [22, 28], XXL: [24, 31], "2XL": [24, 31], "3XL": [26, 33],
    };
    if (bySize[size]) return bySize[size];
  }
  return base;
}

/**
 * Deterministic endpoint refinement: slide the proposed endpoint along the
 * measurement's own axis (unit direction `dir`) within ±window px and settle
 * on the strongest gray-level gradient — the garment edge. Returns the input
 * point unchanged when no gradient beats the noise floor (uniform region).
 */
export function snapEndpoint(
  img: GrayImage,
  point: [number, number],
  dir: [number, number],
  windowPx: number,
): [number, number] {
  const { width: w, height: h, gray } = img;
  const len = Math.hypot(dir[0], dir[1]);
  if (len < 1e-9) return point;
  const ux = dir[0] / len, uy = dir[1] / len;
  const sample = (x: number, y: number): number | null => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return null;
    return gray[yi * w + xi];
  };
  let bestT = 0, bestG = 0;
  const step = Math.max(1, Math.round(windowPx / 40));
  for (let t = -windowPx; t <= windowPx; t += step) {
    const cx = point[0] + ux * t, cy = point[1] + uy * t;
    const a = sample(cx - ux * 2, cy - uy * 2);
    const b = sample(cx + ux * 2, cy + uy * 2);
    if (a === null || b === null) continue;
    const g = Math.abs(b - a);
    if (g > bestG) { bestG = g; bestT = t; }
  }
  const NOISE_FLOOR = 18;
  if (bestG < NOISE_FLOOR) return point;
  return [point[0] + ux * bestT, point[1] + uy * bestT];
}

export interface RawProposal {
  key?: unknown;
  x1?: unknown;
  y1?: unknown;
  x2?: unknown;
  y2?: unknown;
  confidence?: unknown;
}

/** Coerce the model's tool output; drop malformed / out-of-range entries. */
export function normalizeProposals(
  raw: unknown,
  allowedKeys: ReadonlySet<string>,
): Array<{
  key: string;
  p1: [number, number];
  p2: [number, number];
  confidence: number;
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    key: string;
    p1: [number, number];
    p2: [number, number];
    confidence: number;
  }> = [];
  const seen = new Set<string>();
  for (const item of raw as RawProposal[]) {
    if (!item || typeof item !== "object") continue;
    const key = typeof item.key === "string" ? item.key : "";
    if (!allowedKeys.has(key) || seen.has(key)) continue;
    const nums = [item.x1, item.y1, item.x2, item.y2].map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) continue;
    let confidence = Number(item.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));
    seen.add(key);
    out.push({
      key,
      p1: [nums[0], nums[1]],
      p2: [nums[2], nums[3]],
      confidence,
    });
  }
  return out;
}

/**
 * US-2608: `rise` and `inseam` are not two independent measurements. They are
 * two rays from ONE landmark — the crotch — and the tool asks for them
 * separately, so nothing ever checked that the model put that landmark in the
 * same place twice.
 *
 * That is the failure mode this catches, and it is the one sellers actually
 * report: the crotch lands partway down the leg, the rise swallows the error
 * and the inseam loses it. The SUM stays about right, which is why neither
 * number looks obviously wrong on its own and why per-key bands can miss it.
 *
 * Orientation: the prompt asks for a flat, top-down shot, so the waistband is
 * above the crotch and the hem below it. That makes the crotch the LOWER end of
 * the rise (larger y) and the UPPER end of the inseam (smaller y). A garment
 * shot sideways breaks that assumption rather than the check, so the check
 * stands down unless both measurements are predominantly vertical.
 *
 * Disagreement flags BOTH — we know one of them is wrong and not which.
 */
export const CROTCH_AGREEMENT_IN = 1;

function crotchEndOf(
  m: ExtractedMeasurement,
  which: "lower" | "upper",
): [number, number] | null {
  const [a, b] = m.endpoints;
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  if (dy <= dx) return null; // not a vertical measurement — orientation unknown
  const aIsLower = a[1] > b[1];
  if (which === "lower") return aIsLower ? a : b;
  return aIsLower ? b : a;
}

export function reconcileCrotch(
  measurements: ExtractedMeasurement[],
  homography: number[],
): ExtractedMeasurement[] {
  const rise = measurements.find((m) => m.key === "rise");
  const inseam = measurements.find((m) => m.key === "inseam");
  if (!rise || !inseam) return measurements;
  const fromRise = crotchEndOf(rise, "lower");
  const fromInseam = crotchEndOf(inseam, "upper");
  if (!fromRise || !fromInseam) return measurements;

  // Compare on the CARD PLANE, so the tolerance is inches of garment rather
  // than pixels of whatever resolution the seller's phone shoots.
  const [ax, ay] = applyHomography(homography, fromRise[0], fromRise[1]);
  const [bx, by] = applyHomography(homography, fromInseam[0], fromInseam[1]);
  const gap = Math.hypot(ax - bx, ay - by);
  if (gap <= CROTCH_AGREEMENT_IN) return measurements;

  const reason = `crotch_disagreement_${roundQuarterInch(gap)}in`;
  return measurements.map((m) =>
    m.key === "rise" || m.key === "inseam"
      ? { ...m, flagged: true, flagReason: m.flagReason ?? reason }
      : m
  );
}

/**
 * Fill-only merge into the item's stores. A value the seller typed (present
 * with NO ai provenance) is never overwritten; an AI-measured value refreshes;
 * blanks fill. Returns the patched maps plus which keys were written.
 */
export function mergeMeasurementsFillOnly(
  current: Record<string, unknown> | null,
  aiSources: Record<string, unknown> | null,
  extracted: ExtractedMeasurement[],
): {
  measurements: Record<string, unknown>;
  aiFieldSources: Record<string, unknown>;
  written: string[];
} {
  const measurements = { ...(current ?? {}) };
  const aiFieldSources = { ...(aiSources ?? {}) };
  const written: string[] = [];
  for (const m of extracted) {
    // US-2608: a measurement we do not believe must not become a buyer-facing
    // fact. `flagged` means the value failed its plausibility band or the model
    // was unsure, and until now it was written anyway — onto the item, into the
    // eBay Size specifics, and burned into the measurements photo the buyer
    // sees. A wrong inseam published as a number is worse than a blank, because
    // a blank is honest and a number is a promise.
    //
    // The measurement is still RETURNED (and its line still stored), so the
    // editor draws it for the seller to drag onto the right landmark — which is
    // the one place a human can fix it.
    if (m.flagged) continue;
    const existing = measurements[m.key];
    const hasValue = existing != null && String(existing).trim() !== "";
    const aiOwned = `measurements.${m.key}` in aiFieldSources;
    if (hasValue && !aiOwned) continue; // seller's value — hands off
    measurements[m.key] = m.inches;
    aiFieldSources[`measurements.${m.key}`] = {
      source: "ai_measured",
      confidence: m.confidence,
      flagged: m.flagged,
      measuredAt: new Date().toISOString(),
    };
    written.push(m.key);
  }
  return { measurements, aiFieldSources, written };
}

// ── The model call ──────────────────────────────────────────────────

const LANDMARK_GUIDANCE: Record<string, string> = {
  chest: "left armpit seam to right armpit seam (pit to pit), straight across",
  bust: "left armpit seam to right armpit seam (pit to pit), straight across",
  length: "highest point of the shoulder (next to collar) straight down to the bottom hem",
  shoulder: "left shoulder seam to right shoulder seam, straight across the back",
  sleeve: "shoulder seam to the end of the cuff, along the sleeve",
  waist: "left edge of the waistband to the right edge, straight across",
  // US-2608: the crotch is the landmark this pass gets wrong, and it costs two
  // measurements at once — the rise absorbs the error and the inseam loses it.
  // Naming the geometry ("the POINT where the two inner leg seams MEET") beats
  // naming the part ("crotch seam"), because the seam is a long line and the
  // model was picking a point partway along it, down the inside of the leg.
  inseam:
    "start at the CROTCH POINT — the single point where the two inner leg seams meet, in the UPPER part of the garment just below the waistband, NOT partway down the leg — then straight down to the bottom of the leg hem",
  rise:
    "start at the SAME CROTCH POINT used for the inseam (where the two inner leg seams meet) and go straight up to the top edge of the front waistband; on most garments this is 8-13 inches",
  hip: "widest point of the hips, straight across",
  leg_opening: "one edge of the leg hem to the other, straight across",
  insole: "heel end of the insole to the toe end",
  width: "widest horizontal extent of the item",
};

function buildTool(fields: MeasurementField[]): Anthropic.Tool {
  return {
    name: "report_measurement_endpoints",
    description:
      "Report the pixel positions (normalized 0..1) of each measurement's two endpoints on the flat-laid garment.",
    input_schema: {
      type: "object",
      properties: {
        measurements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", enum: fields.map((f) => f.key) },
              x1: { type: "number", description: "endpoint 1 x, 0..1 of image width" },
              y1: { type: "number", description: "endpoint 1 y, 0..1 of image height" },
              x2: { type: "number", description: "endpoint 2 x, 0..1" },
              y2: { type: "number", description: "endpoint 2 y, 0..1" },
              confidence: {
                type: "number",
                description: "0..1 — how sure you are BOTH endpoints are correctly placed",
              },
            },
            required: ["key", "x1", "y1", "x2", "y2", "confidence"],
          },
        },
      },
      required: ["measurements"],
    },
  };
}

export interface ExtractInput {
  /** Publicly fetchable URL of the measurement photo (card + garment). */
  photoUrl: string;
  /** Grayscale of the SAME stored photo (any scale; pass its scale). */
  gray: GrayImage;
  /** resized = original * grayScale (1 when gray is full resolution). */
  grayScale: number;
  /** Original image px -> card-plane inches (US-1572 calibration). */
  homography: number[];
  /** Original image dimensions in px (endpoint denormalization basis). */
  imageWidth: number;
  imageHeight: number;
  group: MeasurementGroup;
  fields: MeasurementField[];
  sizeLabel: string | null;
}

/** One vision call -> snapped, calibrated, plausibility-checked measurements. */
export async function extractMeasurements(
  input: ExtractInput,
): Promise<MeasureExtractResult> {
  const fields = input.fields.filter((f) => f.unit === "length");
  if (fields.length === 0) {
    return { measurements: [], model: "none", tokensIn: 0, tokensOut: 0 };
  }
  enterAiFeature("measure_extract");
  const model = getDefaultModel();
  const client = getAnthropicClient();
  const tool = buildTool(fields);

  const fieldLines = fields
    .map((f) => {
      const hint = LANDMARK_GUIDANCE[f.key] ?? f.label;
      return `- ${f.key} ("${f.label}"): ${hint}`;
    })
    .join("\n");

  const response = await withRetry(() =>
    client.messages.create({
      model,
      max_tokens: 1500,
      tools: [tool],
      tool_choice: { type: "tool", name: "report_measurement_endpoints" },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: input.photoUrl } },
          {
            type: "text",
            text:
              `This is a ${input.group} garment laid FLAT with a calibration card beside it. ` +
              `Place the two endpoints for each of these flat measurements ON THE GARMENT ` +
              `(never on the card), as coordinates normalized to the full image (0..1):\n` +
              fieldLines +
              `\nSkip a measurement (omit it) if its landmarks aren't visible. ` +
              `Endpoints must sit exactly on the garment's edges/seams described.`,
          },
        ],
      }],
    })
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  const rawList = toolUse && toolUse.type === "tool_use"
    ? (toolUse.input as { measurements?: unknown }).measurements
    : [];
  const proposals = normalizeProposals(
    rawList,
    new Set(fields.map((f) => f.key)),
  );

  const results: ExtractedMeasurement[] = [];
  const windowPx = Math.max(8, Math.round(Math.max(input.imageWidth, input.imageHeight) * 0.02));
  for (const p of proposals) {
    const field = fields.find((f) => f.key === p.key)!;
    // Denormalize to ORIGINAL px.
    let e1: [number, number] = [p.p1[0] * input.imageWidth, p.p1[1] * input.imageHeight];
    let e2: [number, number] = [p.p2[0] * input.imageWidth, p.p2[1] * input.imageHeight];
    // Snap in the gray's own space, then map back to original px.
    const s = input.grayScale;
    const dir: [number, number] = [e2[0] - e1[0], e2[1] - e1[1]];
    const snap1 = snapEndpoint(
      input.gray,
      [e1[0] * s, e1[1] * s],
      dir,
      windowPx * s,
    );
    const snap2 = snapEndpoint(
      input.gray,
      [e2[0] * s, e2[1] * s],
      [-dir[0], -dir[1]],
      windowPx * s,
    );
    e1 = [snap1[0] / s, snap1[1] / s];
    e2 = [snap2[0] / s, snap2[1] / s];
    // Card-plane inches via the calibration homography.
    const [ax, ay] = applyHomography(input.homography, e1[0], e1[1]);
    const [bx, by] = applyHomography(input.homography, e2[0], e2[1]);
    const inches = roundQuarterInch(Math.hypot(ax - bx, ay - by));
    const band = plausibilityBand(input.group, p.key, input.sizeLabel);
    let flagged = false;
    let flagReason: string | null = null;
    if (p.confidence < 0.5) {
      flagged = true;
      flagReason = "low_confidence";
    } else if (band && (inches < band[0] || inches > band[1])) {
      flagged = true;
      flagReason = `outside_expected_${band[0]}-${band[1]}in`;
    }
    results.push({
      key: p.key,
      label: field.label,
      endpoints: [e1, e2],
      inches,
      confidence: p.confidence,
      flagged,
      flagReason,
    });
  }

  return {
    measurements: reconcileCrotch(results, input.homography),
    model: response.model ?? model,
    tokensIn: response.usage?.input_tokens ?? 0,
    tokensOut: response.usage?.output_tokens ?? 0,
  };
}

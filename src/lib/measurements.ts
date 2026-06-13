// US-827: where captured garment measurements flow downstream into the listing.
//
// This is the WEB mirror of services/edge-functions/src/lib/measurements.ts —
// the canonical edge copy. Keep the two in sync (pure functions, identical
// behavior). Measurements are persisted on inventory_items.measurements (jsonb)
// keyed by a canonical field key; stored LENGTH values are flat measurements in
// INCHES, shoe sizes are US numeric, watch dimensions are millimetres.
//
// Single source of truth for: (1) canonical measurement key → eBay measurement
// aspect names; (2) unit-aware formatting honoring the in/cm preference
// (US-648); (3) the clean, idempotent "Measurements" description block.

export type MeasurementKind = "length" | "shoe" | "mm";

export interface MeasurementSpec {
  kind: MeasurementKind;
  label: string;
  aspects: string[];
}

// Canonical measurement key -> spec. Keys mirror src/lib/measurement-templates.ts
// and the ai-extract suggestion keys.
export const MEASUREMENT_SPECS: Record<string, MeasurementSpec> = {
  chest: { kind: "length", label: "Chest (pit to pit)", aspects: ["Chest Size", "Chest", "Pit to Pit"] },
  bust: { kind: "length", label: "Bust", aspects: ["Bust", "Bust Size"] },
  waist: { kind: "length", label: "Waist (flat)", aspects: ["Waist Size", "Waist"] },
  hip: { kind: "length", label: "Hip", aspects: ["Hip Size", "Hip", "Hips"] },
  inseam: { kind: "length", label: "Inseam", aspects: ["Inseam", "Inseam Length"] },
  rise: { kind: "length", label: "Front rise", aspects: ["Rise", "Front Rise"] },
  leg_opening: { kind: "length", label: "Leg opening", aspects: ["Leg Opening", "Hem Width"] },
  sleeve: { kind: "length", label: "Sleeve", aspects: ["Sleeve Length", "Sleeve"] },
  shoulder: { kind: "length", label: "Shoulder", aspects: ["Shoulder Width", "Shoulder to Shoulder", "Shoulder"] },
  length: { kind: "length", label: "Length", aspects: ["Length", "Garment Length", "Total Length"] },
  width: { kind: "length", label: "Width", aspects: ["Width"] },
  insole: { kind: "length", label: "Insole length", aspects: ["Insole Length", "Insole"] },
  size_us: { kind: "shoe", label: "US size", aspects: ["US Shoe Size", "Shoe Size"] },
  case_diameter: { kind: "mm", label: "Case diameter", aspects: ["Case Diameter", "Case Size"] },
  lug_width: { kind: "mm", label: "Lug width", aspects: ["Lug Width"] },
  band_length: { kind: "mm", label: "Band length", aspects: ["Band Length", "Strap Length"] },
};

export type LengthUnit = "in" | "cm";

const IN_TO_CM = 2.54;

function trimNum(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** A stored measurement value coerced to a positive finite number, or null. */
export function coerceMeasurement(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Format one stored measurement for display. LENGTH values are stored in inches
 * and convert to cm when `unit === "cm"` (US-648); shoe sizes render "US 10";
 * millimetre watch dimensions render "42 mm" and never convert.
 */
export function formatMeasurementValue(
  key: string,
  value: unknown,
  unit: LengthUnit = "in",
): string | null {
  const n = coerceMeasurement(value);
  if (n == null) return null;
  const kind = MEASUREMENT_SPECS[key]?.kind ?? "length";
  if (kind === "shoe") return `US ${trimNum(n)}`;
  if (kind === "mm") return `${trimNum(n)} mm`;
  if (unit === "cm") return `${trimNum(n * IN_TO_CM)} cm`;
  return `${trimNum(n)} in`;
}

/** Human label for a measurement key (falls back to a de-underscored key). */
export function measurementLabel(key: string): string {
  return MEASUREMENT_SPECS[key]?.label ?? key.replace(/_/g, " ");
}

export const MEASUREMENTS_BLOCK_START = "<!--gradethread-measurements-->";
export const MEASUREMENTS_BLOCK_END = "<!--/gradethread-measurements-->";

const BLOCK_RE = new RegExp(
  `\\n*${MEASUREMENTS_BLOCK_START}[\\s\\S]*?${MEASUREMENTS_BLOCK_END}`,
  "g",
);

export type Measurements = Record<string, unknown> | null | undefined;

/** Render measurement lines (no markers) in canonical key order. */
export function buildMeasurementLines(
  measurements: Measurements,
  unit: LengthUnit = "in",
): string[] {
  if (!measurements || typeof measurements !== "object") return [];
  const lines: string[] = [];
  const ordered = [
    ...Object.keys(MEASUREMENT_SPECS).filter((k) => k in measurements),
    ...Object.keys(measurements).filter((k) => !(k in MEASUREMENT_SPECS)),
  ];
  for (const key of ordered) {
    const formatted = formatMeasurementValue(key, measurements[key], unit);
    if (formatted) lines.push(`- ${measurementLabel(key)}: ${formatted}`);
  }
  return lines;
}

/** The full marker-delimited measurements block, or "" when no measurements. */
export function buildMeasurementsBlock(
  measurements: Measurements,
  unit: LengthUnit = "in",
): string {
  const lines = buildMeasurementLines(measurements, unit);
  if (lines.length === 0) return "";
  return [
    MEASUREMENTS_BLOCK_START,
    "Measurements (garment laid flat):",
    ...lines,
    MEASUREMENTS_BLOCK_END,
  ].join("\n");
}

/**
 * Append (or refresh) the measurements block on a listing description.
 * IDEMPOTENT: any existing block is stripped first, so re-saving never
 * duplicates the section. When there are no measurements the block is removed.
 */
export function applyMeasurementsBlock(
  description: string,
  measurements: Measurements,
  unit: LengthUnit = "in",
): string {
  const base = (description ?? "").replace(BLOCK_RE, "").trimEnd();
  const block = buildMeasurementsBlock(measurements, unit);
  if (!block) return base;
  return base.length > 0 ? `${base}\n\n${block}` : block;
}

/**
 * Map stored measurements onto a category's eBay measurement aspects. Fills an
 * aspect only when one of the key's candidate names exists in the category spec
 * AND is free-text (empty allowedValues), and the aspect isn't already set.
 * Returns ONLY the newly-filled aspects.
 */
export function resolveMeasurementAspects(
  measurements: Measurements,
  categoryAspects: Record<string, string[]>,
  existing: Record<string, string[]> = {},
  unit: LengthUnit = "in",
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!measurements || typeof measurements !== "object") return out;

  const freeTextByLower = new Map<string, string>();
  for (const [name, allowed] of Object.entries(categoryAspects)) {
    if (!Array.isArray(allowed) || allowed.length === 0) {
      freeTextByLower.set(name.toLowerCase(), name);
    }
  }
  const existingLower = new Set(Object.keys(existing).map((k) => k.toLowerCase()));

  for (const [key, spec] of Object.entries(MEASUREMENT_SPECS)) {
    if (!(key in measurements)) continue;
    const formatted = formatMeasurementValue(key, measurements[key], unit);
    if (!formatted) continue;
    for (const candidate of spec.aspects) {
      const lower = candidate.toLowerCase();
      const canonical = freeTextByLower.get(lower);
      if (!canonical) continue;
      if (existingLower.has(lower) || canonical in out) continue;
      out[canonical] = [formatted];
      break;
    }
  }
  return out;
}

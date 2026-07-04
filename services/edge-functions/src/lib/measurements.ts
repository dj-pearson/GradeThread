// US-827: where captured garment measurements flow downstream into the listing.
//
// Measurements are persisted on inventory_items.measurements (jsonb) keyed by a
// canonical field key (chest, waist, inseam, sleeve, length, rise, hip, bust,
// leg_opening, shoulder, size_us, insole, case_diameter, lug_width, band_length,
// width). Stored LENGTH values are flat measurements in INCHES (garment laid
// flat); shoe sizes are US numeric; watch dimensions are millimetres.
//
// This module is the SINGLE source of truth (mirrored verbatim on the web at
// src/lib/measurements.ts) for three downstream concerns:
//   1. mapping a canonical measurement key -> the category's eBay measurement
//      aspect names (US-822 registry style: ordered candidates, matched against
//      the category's REAL aspect list, filled only when the aspect exists);
//   2. formatting a stored value for display, honoring the in/cm preference
//      (US-648) — only LENGTH measurements convert; shoe/mm are unit-fixed;
//   3. assembling a clean, IDEMPOTENT "Measurements" block for the listing
//      description (marker-delimited so a re-save replaces it, never duplicates).

// ─── Canonical keys ────────────────────────────────────────────────

/** Stored unit semantics per measurement key. */
export type MeasurementKind = "length" | "shoe" | "mm";

export interface MeasurementSpec {
  /** Stored-value semantics — drives unit conversion + formatting. */
  kind: MeasurementKind;
  /** Human label for the description block. */
  label: string;
  /**
   * Ordered eBay aspect-name candidates (incl. synonyms), matched
   * case-insensitively against the category's real aspect list. A measurement
   * is filled onto an aspect only when that aspect exists in the spec AND is
   * free-text (a SELECTION_ONLY style aspect like a "Sleeve Length" dropdown is
   * never filled with a numeric value).
   */
  aspects: string[];
}

// Canonical measurement key -> spec. Keys mirror the web measurement templates
// (src/lib/measurement-templates.ts) and the ai-extract suggestion keys.
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

// ─── Value coercion + formatting ───────────────────────────────────

const IN_TO_CM = 2.54;

/** Round to 2dp; String() already drops trailing zeros so "20.0" reads "20". */
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
 * millimetre watch dimensions render "42 mm" and never convert. Unknown keys
 * are treated as a length. Returns null for a non-positive/invalid value.
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
  // length
  if (unit === "cm") return `${trimNum(n * IN_TO_CM)} cm`;
  return `${trimNum(n)} in`;
}

/** Human label for a measurement key (falls back to a de-underscored key). */
export function measurementLabel(key: string): string {
  return MEASUREMENT_SPECS[key]?.label ?? key.replace(/_/g, " ");
}

// ─── Description block (idempotent) ────────────────────────────────

export const MEASUREMENTS_BLOCK_START = "<!--gradethread-measurements-->";
export const MEASUREMENTS_BLOCK_END = "<!--/gradethread-measurements-->";

// Matches a previously-inserted block (and any leading blank lines) so a
// re-save strips it before re-appending — that is what makes the block
// idempotent rather than accumulating on every regeneration.
const BLOCK_RE = new RegExp(
  `\\n*${MEASUREMENTS_BLOCK_START}[\\s\\S]*?${MEASUREMENTS_BLOCK_END}`,
  "g",
);

export type Measurements = Record<string, unknown> | null | undefined;

/**
 * Render the measurement lines (no markers) in canonical key order. Returns
 * `[]` when nothing is fillable, so callers can decide whether to add a block.
 */
export function buildMeasurementLines(
  measurements: Measurements,
  unit: LengthUnit = "in",
): string[] {
  if (!measurements || typeof measurements !== "object") return [];
  const lines: string[] = [];
  // Canonical (spec) order first, then any extra keys in insertion order.
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

// US-1578: the method note appended when the values came from a calibrated
// MeasureCard photo (US-1572..74). Text only — never a link/badge (eBay
// no-off-site-promotion rule, same family as the seller-credential pivot).
export const CALIBRATED_MEASURE_NOTE =
  "Measured flat with a calibrated photo process.";

export interface MeasurementsBlockOpts {
  /** Add the calibrated-method note line (US-1578). */
  calibrated?: boolean;
}

/**
 * True when any measurement value carries photo-measurement provenance —
 * an ai_field_sources entry under "measurements.<key>" stamped with
 * measuredAt (written by /measure/extract and the overlay editor's save).
 */
export function hasCalibratedMeasurements(
  aiFieldSources: Record<string, unknown> | null | undefined,
): boolean {
  if (!aiFieldSources || typeof aiFieldSources !== "object") return false;
  for (const [key, value] of Object.entries(aiFieldSources)) {
    if (!key.startsWith("measurements.")) continue;
    if (
      value && typeof value === "object" &&
      typeof (value as { measuredAt?: unknown }).measuredAt === "string"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The full marker-delimited measurements block, or "" when no measurements.
 */
export function buildMeasurementsBlock(
  measurements: Measurements,
  unit: LengthUnit = "in",
  opts: MeasurementsBlockOpts = {},
): string {
  const lines = buildMeasurementLines(measurements, unit);
  if (lines.length === 0) return "";
  return [
    MEASUREMENTS_BLOCK_START,
    "Measurements (garment laid flat):",
    ...lines,
    ...(opts.calibrated ? [CALIBRATED_MEASURE_NOTE] : []),
    MEASUREMENTS_BLOCK_END,
  ].join("\n");
}

/**
 * Plain-text measurements section for platforms that render no HTML (the
 * cross-listing variants) — same lines, no markers. "" when empty.
 */
export function buildPlainMeasurementsText(
  measurements: Measurements,
  unit: LengthUnit = "in",
  opts: MeasurementsBlockOpts = {},
): string {
  const lines = buildMeasurementLines(measurements, unit);
  if (lines.length === 0) return "";
  return [
    "Measurements (garment laid flat):",
    ...lines,
    ...(opts.calibrated ? [CALIBRATED_MEASURE_NOTE] : []),
  ].join("\n");
}

/**
 * Append (or refresh) the measurements block on a listing description.
 * IDEMPOTENT: any existing block is stripped first, so calling this repeatedly
 * — e.g. on every AutoLister regeneration or composer re-save — never
 * duplicates the section. When there are no measurements the block is removed.
 */
export function applyMeasurementsBlock(
  description: string,
  measurements: Measurements,
  unit: LengthUnit = "in",
  opts: MeasurementsBlockOpts = {},
): string {
  const base = (description ?? "").replace(BLOCK_RE, "").trimEnd();
  const block = buildMeasurementsBlock(measurements, unit, opts);
  if (!block) return base;
  return base.length > 0 ? `${base}\n\n${block}` : block;
}

// ─── Aspect mapping (US-822 registry style) ────────────────────────

/**
 * Map stored measurements onto a category's eBay measurement aspects.
 *
 * `categoryAspects` is the category's real aspect list as name -> allowedValues
 * (the shape `extractAllowedAspects` produces; `[]` = free-text). A measurement
 * fills an aspect only when (a) one of the key's candidate aspect names exists
 * in the category spec, (b) that aspect is free-text (empty allowedValues — a
 * numeric value must never be forced into a SELECTION_ONLY style dropdown), and
 * (c) the aspect isn't already set in `existing` (user/AI values win). Values
 * are unit-formatted. Returns ONLY the newly-filled aspects.
 */
export function resolveMeasurementAspects(
  measurements: Measurements,
  categoryAspects: Record<string, string[]>,
  existing: Record<string, string[]> = {},
  unit: LengthUnit = "in",
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!measurements || typeof measurements !== "object") return out;

  // Lower-cased index of the category's free-text aspect names -> canonical name.
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
      break; // first matching candidate wins
    }
  }
  return out;
}

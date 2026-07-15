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
 * Map an eBay aspect name onto a canonical measurement key via MEASUREMENT_SPECS
 * candidates (case-insensitive). Returns null when the aspect isn't a known
 * measurement field.
 */
export function measurementKeyForAspect(aspectName: string): string | null {
  const lower = aspectName.trim().toLowerCase();
  if (!lower) return null;
  for (const [key, spec] of Object.entries(MEASUREMENT_SPECS)) {
    if (spec.aspects.some((a) => a.toLowerCase() === lower)) return key;
  }
  return null;
}

/**
 * Parse an eBay aspect string back into the stored measurement number.
 * Lengths: "32", "32 in", "81 cm" → inches. Shoes: "US 10" / "10". mm: "42 mm".
 */
export function parseMeasurementAspectValue(
  key: string,
  raw: string,
): number | null {
  const text = raw.trim();
  if (!text) return null;
  const kind = MEASUREMENT_SPECS[key]?.kind ?? "length";

  if (kind === "shoe") {
    const m = text.match(/^(?:us\s*)?(\d+(?:\.\d+)?)$/i);
    return m ? coerceMeasurement(m[1]) : null;
  }
  if (kind === "mm") {
    const m = text.match(/^(\d+(?:\.\d+)?)\s*(?:mm)?$/i);
    return m ? coerceMeasurement(m[1]) : null;
  }

  const m = text.match(/^(\d+(?:\.\d+)?)\s*(in|inch|inches|cm|centimeters?)?$/i);
  if (!m) return null;
  const n = coerceMeasurement(m[1]);
  if (n == null) return null;
  const unitToken = (m[2] ?? "in").toLowerCase();
  if (unitToken.startsWith("cm") || unitToken.startsWith("centimeter")) {
    return coerceMeasurement(Math.round((n / IN_TO_CM) * 100) / 100);
  }
  return n;
}

/**
 * True when two measurement values are numerically equivalent (within 0.01),
 * so "32 in" ↔ 32 does not thrash a live sync loop.
 */
export function measurementsNumericallyEqual(
  a: unknown,
  b: unknown,
): boolean {
  const na = coerceMeasurement(a);
  const nb = coerceMeasurement(b);
  if (na == null || nb == null) return na == null && nb == null;
  return Math.abs(na - nb) < 0.01;
}

export type ForceMeasurementAspectsResult = {
  /** Aspects to set/overwrite (formatted values). */
  aspects: Record<string, string[]>;
  /** Aspect names that should be cleared (measurement blanked). */
  cleared: string[];
};

/**
 * Live last-write-wins projection of measurements onto free-text category
 * aspects. Unlike resolveMeasurementAspects (fill-only), this OVERWRITES
 * matching aspects and reports clears when a measurement key was blanked.
 *
 * `categoryAspects`: name → allowedValues (`[]` = free-text).
 * `sources`: optional provenance; a blanked measurement clears an aspect when
 * it is inventory_derived OR its current value still matches a prior format.
 */
export function forceMeasurementAspects(
  measurements: Measurements,
  categoryAspects: Record<string, string[]>,
  existing: Record<string, string[]> = {},
  unit: LengthUnit = "in",
  sources: Record<string, string | undefined> = {},
): ForceMeasurementAspectsResult {
  const aspects: Record<string, string[]> = {};
  const cleared: string[] = [];
  const meas = measurements && typeof measurements === "object" ? measurements : {};

  const freeTextByLower = new Map<string, string>();
  for (const [name, allowed] of Object.entries(categoryAspects)) {
    if (!Array.isArray(allowed) || allowed.length === 0) {
      freeTextByLower.set(name.toLowerCase(), name);
    }
  }

  // Resolve each measurement key to at most one free-text aspect in the category.
  const keyToAspect = new Map<string, string>();
  for (const [key, spec] of Object.entries(MEASUREMENT_SPECS)) {
    for (const candidate of spec.aspects) {
      const canonical = freeTextByLower.get(candidate.toLowerCase());
      if (canonical) {
        keyToAspect.set(key, canonical);
        break;
      }
    }
  }

  for (const [key, canonical] of keyToAspect) {
    const hasKey = key in meas;
    const formatted = hasKey ? formatMeasurementValue(key, meas[key], unit) : null;
    if (formatted) {
      const current = existing[canonical]?.[0]?.trim() ?? "";
      if (current !== formatted) {
        aspects[canonical] = [formatted];
      }
      continue;
    }

    // Blanked / missing measurement → clear aspect when it looks measurement-owned.
    const current = existing[canonical]?.[0]?.trim() ?? "";
    if (!current) continue;
    // Only clear aspects we previously projected from measurements. A manual
    // (or AI) Inseam stays put when Measurements simply never had that key.
    if (sources[canonical] === "inventory_derived") cleared.push(canonical);
  }

  return { aspects, cleared };
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

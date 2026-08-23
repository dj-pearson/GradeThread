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

import type { ShoeSizeScale } from "@/lib/shoe-size-scale";

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

// ── US-2630: flat across is HALF the way round ──────────────────────────────
//
// The MeasureCard measures a garment lying flat, so the tape crosses ONE layer.
// For anything that goes around the body the worn number is twice that: an 11in
// flat waist is a 22in waist, a 13in flat hip is a 26in hip. Stored values stay
// flat — that is what was measured, it is what the editor's live readout shows,
// and it is what a buyer reproduces with their own tape — and the doubling
// happens where the number is presented as the garment's size.
//
// This was reaching eBay wrong: `waist` fed the "Waist Size" aspect verbatim, so
// a 32in pair of jeans published as a 16, which is not a rounding difference —
// it is the wrong garment in every size filter a buyer uses.
//
// The list is exactly the measurements where the fabric is FOLDED, so flat x 2
// is the circumference. Head circumference is deliberately absent: a hat's
// opening laid flat gives a DIAMETER, and a circle's circumference is pi x d,
// not 2 x d. Shoulder, sleeve, length, rise and inseam are single spans and are
// never doubled.
export const CIRCUMFERENCE_KEYS = new Set<string>([
  "chest",
  "bust",
  "waist",
  "hip",
  "leg_opening",
]);

export function isCircumferenceMeasurement(key: string): boolean {
  return CIRCUMFERENCE_KEYS.has(key);
}

/**
 * The number a LISTING should carry for this key — the worn circumference for a
 * folded-flat measurement, the stored value for everything else.
 */
export function listingMeasurementValue(
  key: string,
  value: unknown,
): number | null {
  const n = coerceMeasurement(value);
  if (n == null) return null;
  return isCircumferenceMeasurement(key) ? n * 2 : n;
}

/** formatMeasurementValue, but for a value presented as the garment's size. */
export function formatListingMeasurement(
  key: string,
  value: unknown,
  unit: LengthUnit = "in",
): string | null {
  const n = listingMeasurementValue(key, value);
  return n == null ? null : formatMeasurementValue(key, n, unit);
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
    if (!formatted) continue;
    // US-2630: a folded-flat measurement is half the way round, so the line
    // shows the worn number a buyer shops by AND the flat number they can
    // reproduce with their own tape. Publishing only one of the two is what
    // makes a listing argue with itself.
    const worn = isCircumferenceMeasurement(key)
      ? formatListingMeasurement(key, measurements[key], unit)
      : null;
    lines.push(
      worn
        ? `- ${measurementLabel(key)}: ${worn} (${formatted} flat)`
        : `- ${measurementLabel(key)}: ${formatted}`,
    );
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
    const current = existing[canonical]?.[0]?.trim() ?? "";
    // An aspect NAME can be a measurement here and a categorical field in the
    // next category — a hoodie's free-text "Sleeve Length" holds "Long Sleeve",
    // a shirt's holds "34 in". Measurements only OWN the aspect while it is
    // empty or already holds a measurement-shaped value; a value that doesn't
    // parse as one is real listing data (item field, AI, or hand-typed), so it
    // is neither overwritten nor cleared.
    if (current && parseMeasurementAspectValue(key, current) == null) continue;

    const hasKey = key in meas;
    const formatted = hasKey ? formatListingMeasurement(key, meas[key], unit) : null;
    if (formatted) {
      if (current !== formatted) {
        aspects[canonical] = [formatted];
      }
      continue;
    }

    // Blanked / missing measurement → clear aspect when it looks measurement-owned.
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
  shoeSizeScale?: ShoeSizeScale | null,
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
    const formatted = formatListingMeasurement(key, measurements[key], unit);
    if (!formatted) continue;
    for (const candidate of usableCandidates(spec, shoeSizeScale)) {
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

/**
 * US-2796 AC3, mirroring the edge: never put a non-US number in a US-named aspect.
 *
 * WHY THE WEB NEEDS THIS AT ALL. The edge's own copy only fills aspects that are
 * still BLANK, so anything this prefills arrives at publish as an existing value
 * and is never corrected. A UK 9 the composer put into "US Shoe Size" reaches the
 * live listing even though the edge's publish path would have refused it.
 *
 * It DROPS the US-named candidate rather than converting the number: "US Shoe
 * Size" means the US size in THIS category's department, and eBay splits shoe
 * categories by department, so a women's 9 is already right and converting it to
 * a men's 7.5 would introduce the error. Only uk/eu/jp are unambiguously wrong,
 * and they fall through to the scale-neutral "Shoe Size".
 *
 * Both guards below are individually inert today and that is measured, not
 * assumed — no non-shoe aspect name holds "us" as a WORD, and no shoe candidate
 * holds it as a substring. Together they matter: "Bust" and "Bust Size" contain
 * "us", so a version with neither would strip a bust measurement off any listing
 * whose shoe scale happened to be UK.
 */
function usableCandidates(
  spec: MeasurementSpec,
  shoeSizeScale: ShoeSizeScale | null | undefined,
): string[] {
  if (spec.kind !== "shoe") return spec.aspects;
  if (!shoeSizeScale || shoeSizeScale === "us_men" || shoeSizeScale === "us_women") {
    return spec.aspects;
  }
  return spec.aspects.filter((a) => !/\bus\b/i.test(a));
}

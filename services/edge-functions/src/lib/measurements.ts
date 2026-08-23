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

// Type-only, and parcel-estimate.ts imports nothing from here, so there is no
// cycle in either direction. The scale is a PARAMETER rather than something this
// module resolves: measurements.ts is a leaf that formats numbers, and giving it
// a reason to read brands and sizing charts would make it one.
import type { ShoeSizeScale } from "./parcel-estimate.ts";

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

    if (!current) continue;
    // Only clear aspects we previously projected from measurements. A manual
    // (or AI) Inseam stays put when Measurements simply never had that key.
    if (sources[canonical] === "inventory_derived") cleared.push(canonical);
  }

  return { aspects, cleared };
}

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
  shoeSizeScale?: ShoeSizeScale | null,
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
    const formatted = formatListingMeasurement(key, measurements[key], unit);
    if (!formatted) continue;
    for (const candidate of usableCandidates(spec, shoeSizeScale)) {
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

/**
 * US-2796 AC3: never publish a non-US number into a US-named aspect.
 *
 * `size_us` holds whatever number is stamped on the shoe, and US-2796 added the
 * SCALE that number is on. The candidate list for that key is
 * ["US Shoe Size", "Shoe Size"], so a Dr. Martens UK 9 filled "US Shoe Size"
 * with 9 - and a UK 9 is about a US men's 9.5-10. The buyer reads a size that is
 * a full size off, on the one field a shoe listing is searched by.
 *
 * WHY THIS DROPS THE ASPECT RATHER THAN CONVERTING THE NUMBER. Converting looks
 * like the better fix and is a trap: "US Shoe Size" means "the US size in THIS
 * category's department", and eBay splits its shoe categories by department. A
 * women's 9 is already correct under a women's category, so converting it to a
 * men's 7.5 would introduce the very error this is preventing. Only the
 * non-US-scale cases are unambiguously wrong, and for those the honest move is
 * to leave the US-named aspect empty and let the scale-neutral "Shoe Size"
 * candidate take the number - which is what the fall-through does. If the
 * category has no neutral candidate, the aspect stays blank and eBay's own
 * required-aspect gap-fill surfaces it to the seller, which is a question rather
 * than a wrong answer.
 *
 * `us_men` and `us_women` are untouched, as is an ABSENT scale - so every
 * existing call, all of which pass nothing, behaves exactly as before. That is
 * AC4's compatibility promise reaching this function too.
 */
function usableCandidates(
  spec: MeasurementSpec,
  shoeSizeScale: ShoeSizeScale | null | undefined,
): string[] {
  // Keyed on spec.kind rather than on the key NAME, deliberately. `size_us` is
  // the only "shoe" spec today, but a second one added later would inherit this
  // rule for free instead of needing someone to remember the name here.
  //
  // ⚠ BOTH GUARDS BELOW ARE DEFENSIVE AND INDIVIDUALLY INERT TODAY, which is
  // worth stating rather than leaving them looking load-bearing. Sabotage
  // measured it: removing the kind check alone changes no result, because no
  // non-shoe aspect name in MEASUREMENT_SPECS contains "us" as a WORD. Dropping
  // the word boundary alone changes no result either, because none of the shoe
  // candidates contains "us" as a mere substring.
  //
  // Together they do matter, and that is the case the tests pin: "Bust" and
  // "Bust Size" contain "us", so a version with neither guard would strip a
  // bust measurement off any listing whose shoe scale happened to be UK. Each
  // is cheap, and the pair is the actual protection.
  if (spec.kind !== "shoe") return spec.aspects;
  if (!shoeSizeScale || shoeSizeScale === "us_men" || shoeSizeScale === "us_women") {
    return spec.aspects;
  }
  // uk / eu / jp: the stored number is not a US size, so a US-named aspect
  // cannot carry it. Matched on the WORD "us" so "Shoe Size" survives.
  return spec.aspects.filter((a) => !/\bus\b/i.test(a));
}

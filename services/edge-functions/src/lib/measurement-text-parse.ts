// US-3035: read garment measurements out of a seller's own listing text.
//
// Resellers routinely write "Pit to pit: 22"" into their descriptions, and
// FlipDesk already syncs those descriptions for its users' own connected
// accounts. Reading measurements out of a seller's own listings is
// unambiguously theirs to give.
//
// Harvesting the whole PUBLIC eBay corpus was considered and rejected: eBay's
// API license restricts storing and redisplaying listing data. Do not
// reintroduce it here because the parser would work on it.
//
// ── WHY THIS FILE IS PARANOID ──────────────────────────────────────────────
//
// A silent parser defect is indistinguishable from real data once it lands. A
// measurement that never arrives costs one sample out of a cohort; a wrong one
// moves a published median and there is nothing downstream that would catch it.
// The asymmetry is total, so every ambiguous case resolves to DROPPING the
// value.
//
// Four refusals, in the order they bite:
//
//   1. A LABEL AND A UNIT ARE BOTH REQUIRED. "chest 22" is refused, because a
//      listing that says "chest 22" as often means a size as a measurement.
//   2. RANGES ARE REFUSED. "chest 22-23 in" is the seller declining to commit
//      to a number, and picking one for them invents precision they withheld.
//   3. PER-FIELD SANITY BANDS. A 60-inch chest is a typo, not a coat. Values
//      outside their band are dropped, never clamped — clamping would turn a
//      typo into a plausible wrong number, which is the worst outcome here.
//   4. CENTIMETRES ARE CONVERTED ONLY WHEN THE UNIT IS WRITTEN. A bare number
//      is never assumed to be either unit.
//
// Pure — no network, no DB, no model.

import { MEASUREMENT_TEMPLATES, type MeasurementGroup } from "./measurement-templates.ts";

/**
 * Confidence stamped on every row parsed out of text.
 *
 * Deliberately below anything MeasureCard produces and above
 * MIN_INGEST_CONFIDENCE: a seller's own typed number is real evidence, but it
 * was measured by hand with an unknown tape against an unknown edge, where the
 * card path measures on a calibrated plane.
 */
export const LISTING_TEXT_CONFIDENCE = 0.6;

/**
 * Plausible inch ranges per measurement field, across every garment group.
 *
 * These are wide on purpose. The band is a typo filter, not a size filter — its
 * job is to reject 220 and 0.5, not to decide what a large jacket is. A band
 * tight enough to be interesting would start dropping real garments at the
 * extremes, and this index exists partly to serve the extremes.
 */
export const MEASUREMENT_SANITY_BANDS: Readonly<Record<string, readonly [number, number]>> = {
  chest: [10, 40],
  bust: [10, 40],
  waist: [8, 40],
  hip: [10, 45],
  length: [8, 70],
  shoulder: [8, 30],
  sleeve: [4, 45],
  inseam: [10, 44],
  rise: [5, 20],
  leg_opening: [4, 25],
  // The non-apparel groups. Field keys checked against
  // MEASUREMENT_TEMPLATES rather than guessed — a band under a key no template
  // uses is dead weight that reads like coverage.
  strap_drop: [2, 30],
  handle_drop: [2, 30],
  depth: [1, 20],
  width: [1, 60],
  height: [1, 60],
  circumference: [15, 30],
  crown_height: [2, 12],
  brim_length: [1, 8],
  band_length: [4, 14],
  case_diameter: [1, 3],
  lug_width: [1, 3],
  insole: [6, 16],
  hole_span: [1, 12],
};

/** Label spellings a reseller actually writes, mapped to a template field key. */
const FIELD_LABELS: Readonly<Record<string, readonly string[]>> = {
  chest: ["pit to pit", "pit-to-pit", "p2p", "armpit to armpit", "chest"],
  bust: ["bust"],
  waist: ["waist"],
  hip: ["hips", "hip"],
  inseam: ["inseam", "inside leg"],
  rise: ["front rise", "rise"],
  leg_opening: ["leg opening", "leg openings", "ankle opening", "cuff opening"],
  shoulder: ["shoulder to shoulder", "shoulder seam to shoulder seam", "shoulders", "shoulder"],
  sleeve: ["sleeve length", "shoulder to cuff", "sleeve"],
  length: [
    "hps to hem",
    "shoulder to hem",
    "total length",
    "back length",
    "overall length",
    "length",
  ],
};

export interface ParsedMeasurement {
  key: string;
  inches: number;
  /** The exact substring the value came from, for debugging a bad fixture. */
  matchedText: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A number a seller writes: 22, 22.5, 22 1/2, 1/2. Fractions are not an edge
// case in resale listings — a tape measure is marked in eighths and people copy
// what they read.
const NUM = String.raw`\d{1,3}(?:\.\d{1,2})?(?:\s+\d{1,2}\s*\/\s*\d{1,2})?|\d{1,2}\s*\/\s*\d{1,2}`;
const INCH_UNIT = String.raw`"|''|in\b|ins\b|inch\b|inches\b`;
const CM_UNIT = String.raw`cm\b|cms\b|centimet(?:er|re)s?\b`;

/** Parse "22", "22.5", "22 1/2" or "1/2" to a number. NaN when it will not. */
export function parseSellerNumber(raw: string): number {
  const s = raw.trim().replace(/\s*\/\s*/g, "/");
  const mixed = s.match(/^(\d{1,3}(?:\.\d{1,2})?)\s+(\d{1,2})\/(\d{1,2})$/);
  if (mixed) {
    const denom = Number(mixed[3]);
    if (!denom) return Number.NaN;
    return Number(mixed[1]) + Number(mixed[2]) / denom;
  }
  const frac = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (frac) {
    const denom = Number(frac[2]);
    if (!denom) return Number.NaN;
    return Number(frac[1]) / denom;
  }
  const plain = s.match(/^\d{1,3}(?:\.\d{1,2})?$/);
  return plain ? Number(s) : Number.NaN;
}

/**
 * Every measurement this text states unambiguously, for the fields that belong
 * to `group`.
 *
 * Later mentions of a field do not overwrite earlier ones: a description that
 * says the chest twice is a description that repeated itself, and there is no
 * principled way to pick. The first is kept and the second ignored.
 */
export function parseMeasurementsFromText(
  text: string | null | undefined,
  group: MeasurementGroup,
): ParsedMeasurement[] {
  if (!text) return [];

  const allowed = new Set(
    (MEASUREMENT_TEMPLATES[group] ?? []).filter((f) => f.unit === "length").map((f) => f.key),
  );
  if (allowed.size === 0) return [];

  // Normalize the separators sellers use so one pattern covers them all, but
  // keep line structure: a newline is a hard boundary between measurements.
  const haystack = text.replace(/ /g, " ").replace(/[–—]/g, "-");

  const found = new Map<string, ParsedMeasurement>();

  for (const [key, labels] of Object.entries(FIELD_LABELS)) {
    if (!allowed.has(key)) continue;

    for (const label of labels) {
      // The shape: label, optional parenthetical ("waist (flat)"), an optional
      // separator, a number, then a REQUIRED unit. The second number group is
      // there only so a range can be detected and refused.
      const re = new RegExp(
        String.raw`\b${escapeRegExp(label)}\b` +
          String.raw`\s*(?:\([^)]{0,20}\))?` +
          String.raw`\s*(?:[:=]|-|is|of)?\s*` +
          String.raw`(${NUM})` +
          String.raw`(\s*(?:-|to)\s*(?:${NUM}))?` +
          String.raw`\s*(${INCH_UNIT}|${CM_UNIT})`,
        "i",
      );
      const m = haystack.match(re);
      if (!m) continue;

      // Refusal 2: a range is the seller declining to commit to a number.
      if (m[2]) continue;

      const value = parseSellerNumber(m[1]!);
      if (!Number.isFinite(value) || value <= 0) continue;

      // Refusal 4: convert only when the unit says so.
      const unit = m[3]!.toLowerCase();
      const isCm = /^(cm|cms|centimet)/.test(unit);
      const inches = isCm ? value / 2.54 : value;

      // Refusal 3: outside its band is a typo, and it is dropped, not clamped.
      const band = MEASUREMENT_SANITY_BANDS[key];
      if (!band) continue;
      if (inches < band[0] || inches > band[1]) continue;

      if (found.has(key)) continue;
      found.set(key, {
        key,
        inches: Math.round(inches * 100) / 100,
        matchedText: m[0]!.trim(),
      });
      break;
    }
  }

  return [...found.values()];
}

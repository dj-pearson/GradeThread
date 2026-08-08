// US-1777: buyer body-profile domain — the body-measurement schema, guidance,
// and pure normalization shared by the profile manager (US-1777) and the fit
// engine/tool (US-1778/1780).
//
// Body measurements are BODY circumference/length (distinct from garment
// flat-lay measures), stored canonically in INCHES. Display in cm is a device
// preference (measurement-prefs) applied via formatMeasurementValue — never
// stored on the profile.

export interface BodyMeasurementField {
  key: string;
  label: string;
  /** How-to-measure guidance shown in the input UI. */
  guidance: string;
  /** Plausible inch range — values outside are rejected as typos. */
  min: number;
  max: number;
}

// Ordered for the input form. Keys are body-measurement keys the US-1778 fit
// engine understands (it converts these against garment flat-lay dimensions).
export const BODY_MEASUREMENT_FIELDS: BodyMeasurementField[] = [
  { key: "chest", label: "Chest / bust", guidance: "Around the fullest part of your chest, under the arms, with the tape level.", min: 24, max: 70 },
  { key: "waist", label: "Waist", guidance: "Around your natural waistline, roughly at the belly button, without sucking in.", min: 18, max: 65 },
  { key: "hips", label: "Hips", guidance: "Around the fullest part of your hips and seat, feet together.", min: 24, max: 75 },
  { key: "inseam", label: "Inseam", guidance: "From the crotch seam straight down to your ankle, along the inside of the leg.", min: 22, max: 40 },
  { key: "height", label: "Height", guidance: "Standing straight against a wall, from your heel to the top of your head.", min: 48, max: 84 },
  { key: "shoulder", label: "Shoulder width", guidance: "Across your upper back, from the tip of one shoulder to the other.", min: 12, max: 30 },
  { key: "sleeve", label: "Sleeve length", guidance: "From the tip of your shoulder down to your wrist bone, arm slightly bent.", min: 18, max: 42 },
  { key: "neck", label: "Neck", guidance: "Around the base of your neck where a collar sits, one finger of room.", min: 10, max: 24 },
];

const FIELD_BY_KEY = new Map(BODY_MEASUREMENT_FIELDS.map((f) => [f.key, f]));

export interface BodyProfile {
  id: string;
  name: string;
  /** Sparse map of body-measurement key → inches. */
  measurements: Record<string, number>;
  is_default: boolean;
}

export const MAX_PROFILE_NAME = 60;

/** A profile name is valid when it's a non-empty, reasonably short string. */
export function validateProfileName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_PROFILE_NAME);
}

/**
 * Coerce + clamp a raw measurements map to known keys with plausible inch
 * values. Drops unknown keys, non-numbers, and out-of-range typos so a bad
 * input never poisons the fit engine. Pure + exported for tests. `values` are
 * assumed already in INCHES (the UI converts from cm on the way in).
 */
export function normalizeBodyMeasurements(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) continue;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) continue;
    if (n < field.min || n > field.max) continue;
    out[key] = Math.round(n * 10) / 10; // one decimal inch
  }
  return out;
}

/** A profile is usable by the fit engine once it has at least this many measures. */
export const MIN_MEASUREMENTS_FOR_FIT = 2;

export function hasEnoughForFit(measurements: Record<string, number>): boolean {
  return Object.keys(measurements).length >= MIN_MEASUREMENTS_FOR_FIT;
}

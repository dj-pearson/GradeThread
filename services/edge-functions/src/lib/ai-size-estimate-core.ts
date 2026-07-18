// US-1088: PURE Size AI helpers — no ai-config / supabase imports, so tests (and
// any caller that only needs the types/decoders) don't drag in the Anthropic
// client or the env-gated supabase module.
//
// ⚠ THIS MODULE IS DEAD, AND THE SENTENCE THAT USED TO BE HERE WAS FALSE.
//
// It claimed "the network call lives in ai-size-estimate.ts, which re-exports
// everything here". ai-size-estimate.ts does NOT import this file — it
// RE-DECLARES its own SizePhoto, SIZE_ESTIMATE_LOW_CONFIDENCE, isMeasurementPhoto,
// normalizeSizeEstimate and prioritizeMeasurementPhotos. flipdesk-ai.ts imports
// that one. Nothing anywhere imports this one (verified 2026-07-18 by
// scripts/audit-unwired-exports.mjs).
//
// The two copies are byte-identical TODAY, which is exactly what makes this
// dangerous rather than merely untidy: the tests point HERE, so the helpers that
// actually run are effectively untested and free to drift, and the header
// asserted a link that would have made a reviewer stop looking.
//
// Fix is one of two, not both: make ai-size-estimate.ts import this module (as
// the old header claimed), or delete this file and repoint the test at the live
// one. Tracked in US-1996.

export interface SizePhoto {
  url: string;
  type?: string;
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

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Pure decoder for the estimate_size tool output. Normalizes "Unknown"/blank
 * gender to null and clamps the confidence into 0..1.
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
 * earlier images slightly more, and these carry the sizing signal). Stable
 * partition preserving original relative order within each group.
 */
export function prioritizeMeasurementPhotos<T extends SizePhoto>(photos: T[]): T[] {
  const measure = photos.filter((p) => isMeasurementPhoto(p.type));
  const rest = photos.filter((p) => !isMeasurementPhoto(p.type));
  return [...measure, ...rest];
}

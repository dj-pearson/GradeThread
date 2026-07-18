// US-1088: PURE Size AI helpers — no ai-config / supabase imports, so tests (and
// any caller that only needs the types/decoders) don't drag in the Anthropic
// client or the env-gated supabase module.
//
// This module is LIVE and is the single definition of these helpers:
// ai-size-estimate.ts imports and re-exports them, and flipdesk-ai.ts imports
// that. So ai-size-estimate_test.ts, which imports this file directly, is
// testing the code that actually runs.
//
// ⚠ HISTORY, kept deliberately (US-1996). This file used to be DEAD while
// claiming the opposite: its header said ai-size-estimate.ts "re-exports
// everything here", when in fact that module RE-DECLARED byte-identical copies
// of SizePhoto, SIZE_ESTIMATE_LOW_CONFIDENCE, isMeasurementPhoto,
// normalizeSizeEstimate and prioritizeMeasurementPhotos. The tests pointed
// here; the copies that ran were untested and free to drift — and the false
// header is what made that invisible, because it would have stopped a reviewer
// from looking further.
//
// The lesson worth keeping: a comment asserting a link is not the link. If you
// split a module again for the same (good) reason — keeping pure helpers
// importable without the Anthropic client and env-gated config — make the
// dependency real and let the type checker hold it, rather than describing it.

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

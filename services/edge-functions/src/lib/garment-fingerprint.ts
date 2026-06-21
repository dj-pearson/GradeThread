// Garment visual fingerprint (US-1097, Layer-3 foundation — the AI moat).
//
// A per-grade fingerprint derived from EXISTING grade signals so we can LATER
// probabilistically recognize the same physical garment across listings
// (US-1098/1099). It reuses the hardened, server-side perceptual hash
// (computePhashFromImage — the SAME 64-bit dHash space used for photo-reuse
// detection) and the structured defect map; the forward path reuses the phash
// already stored on submission_images, so no image is re-fetched.
//
// Privacy (US-276): nothing here takes a public URL; the stored payload holds
// ONLY hashes/aggregates (no image, no PII). This module is the small PURE core
// (wear score, defect summary, payload shape, similarity over the shared dHash);
// hashing of raw bytes lives in perceptual-hash.ts, distance in photo-reuse.ts.

import { hammingHex } from "./photo-reuse.ts";

/** Wear score is bounded [0,10] and INCREASES with wear (10 − condition). */
export const WEAR_SCORE_MAX = 10;
export function wearScore(overallScore: number): number {
  const w = WEAR_SCORE_MAX - overallScore;
  if (!Number.isFinite(w)) return 0;
  return Math.max(0, Math.min(WEAR_SCORE_MAX, Math.round(w * 10) / 10));
}

/** Normalized [0,1] perceptual similarity (1 = identical) over the 64-bit dHash. */
export function hashSimilarity(a: string, b: string): number {
  return 1 - hammingHex(a, b) / 64;
}

export interface DefectSummary {
  count: number;
  types: string[];
  /** Coarse location tokens (no PII) for area-of-wear comparison. */
  locations: string[];
}

/** Compact, PII-free defect summary from the grade's structured defects. */
export function summarizeDefects(
  defects: Array<{ defect_type?: string | null; location?: string | null }>,
): DefectSummary {
  const types = new Set<string>();
  const locations = new Set<string>();
  for (const d of defects) {
    if (d.defect_type) types.add(String(d.defect_type));
    if (d.location) locations.add(String(d.location).toLowerCase().slice(0, 40));
  }
  return {
    count: defects.length,
    types: [...types].sort(),
    locations: [...locations].sort(),
  };
}

export interface FingerprintPayload {
  v: 1;
  /** 64-bit dHash (16 hex) per structured photo type (front/back/label/detail…). */
  phashes: Record<string, string>;
  defects: DefectSummary;
  /** Garment measurements (inches) when available — instance-level signal. */
  measurements: Record<string, number> | null;
}

/** Assemble the stored fingerprint payload (pure; shape-stable for matching). */
export function buildFingerprintPayload(input: {
  phashes: Record<string, string>;
  defects: Array<{ defect_type?: string | null; location?: string | null }>;
  measurements?: Record<string, number> | null;
}): FingerprintPayload {
  return {
    v: 1,
    phashes: input.phashes,
    defects: summarizeDefects(input.defects),
    measurements: input.measurements ?? null,
  };
}

/**
 * Collapse a row of structured photos into a phash map keyed by image_type,
 * keeping only valid 16-hex dHashes. Used by the forward path (reuse the phash
 * already stored on submission_images) and the backfill.
 */
const HEX16 = /^[0-9a-f]{16}$/;
export function phashesByType(
  images: Array<{ image_type: string; phash: string | null }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const img of images) {
    if (img.phash && HEX16.test(img.phash) && !(img.image_type in out)) {
      out[img.image_type] = img.phash;
    }
  }
  return out;
}

/** PII-free payload for the 'fingerprinted' garment_event (US-1137). */
export interface FingerprintedEventPayload {
  v: 1;
  /** Number of distinct photo angles that contributed a perceptual hash. */
  photo_count: number;
  /** Number of defects captured in the grade (aggregate count only). */
  defect_count: number;
  /** Wear score [0,10] at the time the fingerprint was recorded. */
  wear_score: number;
}

/**
 * Build the PII-free payload for the public 'fingerprinted' garment_event
 * (US-1137). Holds ONLY aggregate counts + the wear score — never a hash, an
 * image, or any identity key — so it surfaces safely on the public passport
 * timeline (and survives sanitizePayload by construction). Pure.
 */
export function buildFingerprintedEventPayload(input: {
  phashes: Record<string, string>;
  defectCount: number;
  overallScore: number;
}): FingerprintedEventPayload {
  return {
    v: 1,
    photo_count: Object.keys(input.phashes).length,
    defect_count: input.defectCount,
    wear_score: wearScore(input.overallScore),
  };
}

/**
 * Best similarity between two fingerprints' shared photo types (max over the
 * angles both have). Returns { score, comparedTypes }. Pure.
 */
export function fingerprintSimilarity(
  a: Record<string, string>,
  b: Record<string, string>,
): { score: number; comparedTypes: string[] } {
  const shared = Object.keys(a).filter((t) => t in b);
  if (shared.length === 0) return { score: 0, comparedTypes: [] };
  let best = 0;
  for (const t of shared) {
    best = Math.max(best, hashSimilarity(a[t]!, b[t]!));
  }
  return { score: best, comparedTypes: shared };
}

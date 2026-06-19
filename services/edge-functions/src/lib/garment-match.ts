// Garment candidate-match service (US-1098, Layer-3).
//
// Given a new fingerprint (US-1097), propose PROBABLE "same physical garment"
// matches — honestly scored, NEVER asserted as certain and NEVER auto-merged.
// Two guards keep it honest:
//   1. SKU-class gate — only garments of the same brand/type/category compete.
//   2. Wear-monotonicity gate — condition shouldn't improve over time. A
//      candidate whose condition plausibly DEGRADED (more wear later) scores
//      higher; a "match" that IMPROVED is flagged suspicious + scored down.
//
// This module is the PURE ranking core (no DB) so it's fully unit-tested. The
// edge service wraps it with tenant-scoped candidate loading + thresholds.

import { fingerprintSimilarity } from "./garment-fingerprint.ts";

export interface MatchOpts {
  /** Visual-similarity floor — below this a garment isn't even a candidate. */
  minSimilarity: number;
  /** How much condition may "improve" (wear decrease) before it's suspicious. */
  wearTolerance: number;
}

export const DEFAULT_MATCH_OPTS: MatchOpts = {
  minSimilarity: 0.82,
  wearTolerance: 0.5,
};

export interface FingerprintRecord {
  garmentId: string;
  /** brand / garment_type / category descriptor (the SKU-class gate keys). */
  skuClass: Record<string, unknown>;
  phashes: Record<string, string>;
  wearScore: number;
}

export interface MatchResult {
  garmentId: string;
  /** 0..1 visual similarity (best over shared photo angles). */
  similarity: number;
  /** query.wear − candidate.wear. ≥0 = degraded/flat (expected over time). */
  wearDelta: number;
  /** False when condition improved beyond tolerance (physically implausible). */
  monotonic: boolean;
  /** True for an improved-condition "match" — surfaced as a fraud-ish caution. */
  suspicious: boolean;
  /** Always "probable" — a suggestion, never a deterministic assertion (AC3). */
  confidence: "probable";
  /** Ranking score in [0,1]: similarity adjusted by the monotonicity factor. */
  score: number;
  comparedTypes: string[];
}

function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

/**
 * Plausible same-SKU gate: garment_type + category must agree, and brand must
 * agree when BOTH sides declare one (a missing brand never blocks a match).
 */
export function sameSkuClass(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  if (s(a.garment_type) !== s(b.garment_type)) return false;
  if (s(a.category) !== s(b.category)) return false;
  const ba = s(a.brand);
  const bb = s(b.brand);
  if (ba && bb && ba !== bb) return false;
  return true;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Score one candidate against the query fingerprint. Returns null when it isn't
 * a plausible candidate (different SKU class, no shared photos, or below the
 * similarity floor). `query` is the NEWER sighting; `candidate` is the prior
 * garment we might be continuing.
 */
export function scoreCandidate(
  query: FingerprintRecord,
  candidate: FingerprintRecord,
  opts: MatchOpts = DEFAULT_MATCH_OPTS,
): MatchResult | null {
  if (query.garmentId === candidate.garmentId) return null;
  if (!sameSkuClass(query.skuClass, candidate.skuClass)) return null;

  const { score: similarity, comparedTypes } = fingerprintSimilarity(
    query.phashes,
    candidate.phashes,
  );
  if (comparedTypes.length === 0 || similarity < opts.minSimilarity) return null;

  const wearDelta = query.wearScore - candidate.wearScore;
  // Monotonic when condition did NOT improve beyond tolerance over time.
  const monotonic = wearDelta >= -opts.wearTolerance;
  const suspicious = !monotonic;

  // Monotonicity factor: a suspicious (improved) "match" is scored well down;
  // a consistently-degraded one gets a small boost (real items wear over time).
  const factor = suspicious
    ? 0.5
    : 1 + Math.min(Math.max(wearDelta, 0), 3) * 0.05; // up to +15%

  return {
    garmentId: candidate.garmentId,
    similarity,
    wearDelta,
    monotonic,
    suspicious,
    confidence: "probable",
    score: clamp01(similarity * factor),
    comparedTypes,
  };
}

/**
 * Rank all plausible candidates for `query`, best score first. Suspicious
 * (improved-condition) matches still appear — flagged — so a reviewer sees the
 * caution rather than the match silently vanishing. Never writes anything.
 */
export function rankCandidates(
  query: FingerprintRecord,
  candidates: FingerprintRecord[],
  opts: MatchOpts = DEFAULT_MATCH_OPTS,
): MatchResult[] {
  const out: MatchResult[] = [];
  for (const c of candidates) {
    const r = scoreCandidate(query, c, opts);
    if (r) out.push(r);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

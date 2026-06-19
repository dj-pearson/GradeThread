// Relist detection via listing-image hash match (US-1099, Layer-3).
//
// US-1098 matches a NEW grade fingerprint against the owner's OTHER grade
// fingerprints (angle-keyed, wear-gated). This module solves a different, very
// common reseller signal: a seller drafts a NEW listing using the SAME or
// near-identical PHOTOS as a garment we already graded (and minted a passport
// for). Detecting that lets us SUGGEST "link this listing to the existing
// passport?" — continuing the chain instead of starting a fresh history.
//
// Why a separate matcher (not rankCandidates):
//   • The query side is a set of LISTING images (item_photos), whose photo_type
//     labels (front/back/tag/detail/defect/flatlay/on_model) don't reliably line
//     up with a fingerprint's submission angles (front/back/label/detail). A
//     relister often re-uploads the same shot under a different slot, so we must
//     compare every listing hash against every candidate hash (cross-product
//     best), NOT only shared angle keys.
//   • There is no wear score for a raw listing, so the wear-monotonicity gate
//     doesn't apply here.
//
// It still REUSES the shared primitives so the honesty guarantees match:
//   • hashSimilarity (garment-fingerprint.ts) — the SAME 64-bit dHash space used
//     everywhere for photo-reuse / fingerprinting.
//   • sameSkuClass (garment-match.ts) — the SKU-class agreement guardrail.
//
// SUGGESTION ONLY: every result is confidence='probable' and this module never
// writes anything. Linking is always a human-confirmed action (US-1094 handoff).

import { hashSimilarity } from "./garment-fingerprint.ts";
import { sameSkuClass } from "./garment-match.ts";

const HEX16 = /^[0-9a-f]{16}$/;

export interface RelistMatchOpts {
  /** Per-image similarity floor — a listing/candidate hash pair below this is
   *  not considered a re-used photo. */
  minSimilarity: number;
  /** Min number of DISTINCT listing photos that must clear minSimilarity for a
   *  candidate to be flagged — the false-positive guardrail (a single lucky
   *  near-collision shouldn't assert a relist). */
  minMatchedPhotos: number;
}

// Conservative defaults. 0.90 ≈ ≤6 differing bits of the 64-bit dHash: tight
// enough that only genuinely re-used / lightly-reprocessed photos clear it, yet
// loose enough to survive recompression/resize. Requiring ≥1 matched photo plus
// SKU-class agreement keeps the bar honest; callers can raise minMatchedPhotos.
export const DEFAULT_RELIST_OPTS: RelistMatchOpts = {
  minSimilarity: 0.9,
  minMatchedPhotos: 1,
};

/** The listing being drafted (the query side). */
export interface RelistQuery {
  /** Perceptual hashes of the listing's photos (16-hex dHashes; junk dropped). */
  phashes: string[];
  /** brand / garment_type / category descriptor (the SKU-class gate keys). */
  skuClass: Record<string, unknown>;
}

/** A prior passport garment we might be relisting (the candidate side). */
export interface RelistCandidate {
  garmentId: string;
  /** Public passport handle — surfaced so the UI can deep-link the suggestion. */
  slug: string | null;
  /** Perceptual hashes from the garment's stored fingerprint(s). */
  phashes: string[];
  skuClass: Record<string, unknown>;
}

export interface RelistMatch {
  garmentId: string;
  slug: string | null;
  /** Best per-photo similarity across the cross-product [0,1]. */
  similarity: number;
  /** How many DISTINCT listing photos cleared minSimilarity. */
  matchedPhotos: number;
  /** Always 'probable' — a suggestion, never a deterministic assertion. */
  confidence: "probable";
  /** Ranking score: best similarity, lightly boosted by corroborating photos. */
  score: number;
}

/** Keep only well-formed, de-duplicated 16-hex hashes. */
export function normalizePhashes(values: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v === "string" && HEX16.test(v)) out.add(v);
  }
  return [...out];
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Score one candidate garment against the listing query. Returns null when it
 * isn't a plausible relist: different SKU class, no comparable hashes, below the
 * similarity floor, or fewer than `minMatchedPhotos` corroborating photos. Pure.
 */
export function scoreRelistCandidate(
  query: RelistQuery,
  candidate: RelistCandidate,
  opts: RelistMatchOpts = DEFAULT_RELIST_OPTS,
): RelistMatch | null {
  // SKU-class gate (AC4): a hat can't relist as a jacket. brand only blocks when
  // BOTH sides declare one (a missing brand never blocks).
  if (!sameSkuClass(query.skuClass, candidate.skuClass)) return null;

  if (query.phashes.length === 0 || candidate.phashes.length === 0) return null;

  let best = 0;
  let matchedPhotos = 0;
  for (const q of query.phashes) {
    // A listing photo "matches" if it's near ANY of the candidate's hashes.
    let bestForPhoto = 0;
    for (const c of candidate.phashes) {
      const sim = hashSimilarity(q, c);
      if (sim > bestForPhoto) bestForPhoto = sim;
    }
    if (bestForPhoto >= opts.minSimilarity) matchedPhotos++;
    if (bestForPhoto > best) best = bestForPhoto;
  }

  if (best < opts.minSimilarity) return null;
  if (matchedPhotos < opts.minMatchedPhotos) return null;

  // Ranking score: dominated by the best per-photo similarity, but lifted by the
  // FRACTION of listing photos that were reused, so a candidate corroborated by
  // several photos outranks a single near-collision. A blend (not a multiplier)
  // is used deliberately: an exact-hash match saturates `best` at 1.0, which
  // would make a capped multiplier a no-op and leave the corroboration tie-break
  // dead. Both terms are in [0,1], so `score` stays in [0,1].
  const corroboration = matchedPhotos / query.phashes.length; // (0,1]
  return {
    garmentId: candidate.garmentId,
    slug: candidate.slug,
    similarity: best,
    matchedPhotos,
    confidence: "probable",
    score: clamp01(best * 0.9 + corroboration * 0.1),
  };
}

/**
 * Rank all plausible relist candidates for a drafted listing, best score first.
 * Suggestions only — never writes, never auto-links (AC2). Pure.
 */
export function rankRelistCandidates(
  query: RelistQuery,
  candidates: RelistCandidate[],
  opts: RelistMatchOpts = DEFAULT_RELIST_OPTS,
): RelistMatch[] {
  const out: RelistMatch[] = [];
  for (const c of candidates) {
    const r = scoreRelistCandidate(query, c, opts);
    if (r) out.push(r);
  }
  // Deterministic ordering: best score first, then more corroborating photos,
  // then higher peak similarity, with garmentId as a final stable tie-break so
  // equal-strength matches never reorder run-to-run.
  out.sort((a, b) =>
    b.score - a.score ||
    b.matchedPhotos - a.matchedPhotos ||
    b.similarity - a.similarity ||
    a.garmentId.localeCompare(b.garmentId)
  );
  return out;
}

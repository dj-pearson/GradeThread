// US-532: auto-group a dumped folder of photos into per-item listing groups.
//
// This is the AutoLister wiring on top of the existing, well-tested clustering
// engine (lib/reconcile-cluster.ts) built for Photo Dump Reconciliation:
//   1. EXIF capture-time bursts  — clusterByTimeGap/autoAssign. Resellers shoot
//      one item, pause, shoot the next; the gap is a strong "new item" signal.
//   2. Visual second pass        — applyVisualSecondPass merges the time
//      clusters of near-identical photos (the same garment shot out of order),
//      using the dHash (perceptual hash) every upload already computes.
// The output is mapped to AutoLister's group shape. Pure + side-effect-free so
// it's unit-tested without a DB or canvas.

import {
  applyVisualSecondPass,
  autoAssign,
  type ClusterablePhoto,
  DEFAULT_GAP_SECONDS,
  groupAssignments,
  type SimilarPair,
} from "@/lib/reconcile-cluster";

export interface GroupablePhoto extends ClusterablePhoto {
  /** 16 hex chars (64-bit dHash), or "" when hashing was unavailable. */
  phash: string;
}

export interface AutoGroup {
  photoIds: string[];
  coverId: string;
}

/**
 * Hamming distance between two 16-hex-char (64-bit) dHashes. Returns the max
 * (64) for a missing/malformed hash so an unknown pair is never treated as
 * similar.
 */
export function hammingHex(a: string, b: string): number {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  let x: bigint;
  try {
    x = BigInt("0x" + a) ^ BigInt("0x" + b);
  } catch {
    return 64;
  }
  let dist = 0;
  while (x > 0n) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}

// dHash distance at/below which two photos are treated as the same shot, so
// out-of-order photos of one garment merge. Conservative to avoid merging
// genuinely different items (which share, at most, a rough silhouette).
export const VISUAL_MERGE_MAX_DISTANCE = 10;

/**
 * Build "similar" pairs from dHash proximity. O(n^2) over the staged set, which
 * is bounded by the 100-photo batch cap — fine in practice.
 */
export function visualPairs(
  photos: GroupablePhoto[],
  maxDistance: number = VISUAL_MERGE_MAX_DISTANCE,
): SimilarPair[] {
  const pairs: SimilarPair[] = [];
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const a = photos[i]!;
      const b = photos[j]!;
      if (a.phash && b.phash && hammingHex(a.phash, b.phash) <= maxDistance) {
        pairs.push({ a: a.id, b: b.id });
      }
    }
  }
  return pairs;
}

export interface AutoGroupOptions {
  /** Capture-time gap (seconds) that starts a new item. */
  gapSeconds?: number;
  /** Run the dHash visual second pass (default true). */
  visual?: boolean;
  /** dHash distance threshold for the visual pass. */
  maxDistance?: number;
}

/**
 * Auto-group loose photos into per-item groups by capture-time bursts plus a
 * dHash visual second pass. Groups come back in capture order; each group's
 * cover is its earliest photo. Photos with no capture time become their own
 * singleton groups (nothing is silently dropped — the user can merge them).
 */
export function autoGroupPhotos(
  photos: GroupablePhoto[],
  opts: AutoGroupOptions = {},
): AutoGroup[] {
  if (photos.length === 0) return [];
  const gap = opts.gapSeconds ?? DEFAULT_GAP_SECONDS;

  let map = autoAssign(photos, gap);
  if (opts.visual !== false) {
    map = applyVisualSecondPass(map, visualPairs(photos, opts.maxDistance));
  }

  const { clusters, needsSorting } = groupAssignments(photos, map);
  const groups: AutoGroup[] = clusters.map((c) => ({
    photoIds: c.photos.map((p) => p.id),
    coverId: c.photos[0]!.id,
  }));
  for (const p of needsSorting) {
    groups.push({ photoIds: [p.id], coverId: p.id });
  }
  return groups;
}

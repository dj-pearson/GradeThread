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
  type AssignmentMap,
  type ClusterablePhoto,
  DEFAULT_GAP_SECONDS,
  groupAssignments,
  type SimilarPair,
} from "@/lib/reconcile-cluster";

export interface GroupablePhoto extends ClusterablePhoto {
  /** 16 hex chars (64-bit dHash), or "" when hashing was unavailable. */
  phash: string;
  /**
   * US-1540: the source file's original name (US-1539 provenance), e.g.
   * "IMG_0551.jpg". Optional — absent/unparseable names simply don't
   * participate in filename-sequence grouping (the pre-US-1540 behavior).
   */
  sourceName?: string | null;
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

// ---------------------------------------------------------------------------
// US-1540: filename-sequence signal.
//
// WhatsApp/AirDrop exports, screenshots and some Android cameras strip EXIF
// capture time, so every such photo used to become a singleton group. But
// people shoot items back-to-back, and cameras name files sequentially —
// IMG_0551..IMG_0554 are almost always one item. Contiguous same-prefix
// sequence runs therefore seed candidate groups for the TIMELESS photos; the
// existing dHash visual pass then confirms/merges them exactly like time
// clusters. Photos WITH capture time keep the time-gap behavior — for them the
// sequence is only an ordering tiebreaker.
// ---------------------------------------------------------------------------

export interface FilenameSequence {
  /** Lowercased name up to the trailing number, e.g. "img_" or "img-20240101-wa". */
  prefix: string;
  /** The trailing number, e.g. 551 for IMG_0551. */
  seq: number;
}

/**
 * Parse (prefix, sequence) from a camera filename. Takes the LAST run of
 * digits in the basename as the sequence, which covers IMG_NNNN, DSCNNNNN,
 * DSC_NNNN, IMG-NNNN, WhatsApp's IMG-YYYYMMDD-WANNNN, and Pixel's
 * PXL_YYYYMMDD_HHMMSSmmm generically. Case-insensitive; strips the extension
 * and copy suffixes like " (1)" / "- Copy" first (so a duplicate's copy number
 * is never mistaken for the sequence). Returns null when there is no trailing
 * number to read.
 */
export function parseFilenameSequence(
  name: string | null | undefined,
): FilenameSequence | null {
  if (!name) return null;
  const base = name
    .trim()
    // extension ("IMG_0551.JPG" → "IMG_0551"); tolerate double extensions.
    .replace(/\.[a-z0-9]+$/i, "")
    // copy suffixes: "IMG_0551 (1)", "IMG_0551 - Copy", "IMG_0551 copy 2".
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s*-?\s*copy(\s*\d+)?\s*$/i, "");
  const m = /^(.*?)(\d+)$/.exec(base);
  if (!m) return null;
  const seq = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(seq)) return null;
  return { prefix: m[1]!.toLowerCase(), seq };
}

/**
 * Partition photos into contiguous filename-sequence runs: sorted by
 * (prefix, seq), a run continues while the prefix matches and the sequence
 * advances by exactly 1 (or repeats — duplicate filenames stay together);
 * a gap or prefix change starts a new run. Photos without a parseable
 * sequence are omitted (the caller leaves them as singletons). Pure.
 */
export function sequenceRuns<T extends { id: string; sourceName?: string | null }>(
  photos: T[],
): T[][] {
  const parsed = photos
    .map((photo, index) => ({ photo, index, seq: parseFilenameSequence(photo.sourceName) }))
    .filter((e): e is typeof e & { seq: FilenameSequence } => e.seq !== null);
  parsed.sort((a, b) => {
    if (a.seq.prefix !== b.seq.prefix) return a.seq.prefix < b.seq.prefix ? -1 : 1;
    if (a.seq.seq !== b.seq.seq) return a.seq.seq - b.seq.seq;
    return a.index - b.index;
  });

  const runs: T[][] = [];
  let current: T[] = [];
  let prev: FilenameSequence | null = null;
  for (const entry of parsed) {
    const contiguous =
      prev !== null &&
      entry.seq.prefix === prev.prefix &&
      (entry.seq.seq === prev.seq || entry.seq.seq === prev.seq + 1);
    if (!contiguous && current.length > 0) {
      runs.push(current);
      current = [];
    }
    current.push(entry.photo);
    prev = entry.seq;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Seed clusters for the TIMELESS photos (assignment `clusterId === null`) from
 * filename-sequence runs. Timed photos are untouched (time-gap stays primary —
 * US-1540 AC3), and an UNPARSEABLE timeless photo keeps today's singleton
 * behavior. Every run is seeded — including runs of one — because the visual
 * second pass skips unassigned photos entirely: a seeded singleton can still
 * be dHash-merged into its item, while an unmerged one renders exactly like
 * the old needs-sorting singleton. Non-manual assignments throughout.
 */
function seedSequenceClusters(
  prev: AssignmentMap,
  photos: GroupablePhoto[],
): AssignmentMap {
  const timeless = photos.filter((p) => prev[p.id]?.clusterId === null);
  if (timeless.length < 2) return prev;
  let changed = false;
  const next: AssignmentMap = { ...prev };
  for (const run of sequenceRuns(timeless)) {
    const clusterId = `seq-${run[0]!.id}`;
    for (const p of run) {
      next[p.id] = { clusterId, manual: false };
      changed = true;
    }
  }
  return changed ? next : prev;
}

/**
 * US-1540 AC4: deterministic provenance ordering — capture time first (unknown
 * last), then filename sequence (prefix, then number; unparseable last). Ties
 * return 0 so a STABLE sort preserves the caller's (upload) order as the final
 * key. Pure; shared by the ungrouped grid and the within-group ordering.
 */
export function compareByProvenance(
  a: { capturedAt: Date | null; sourceName?: string | null },
  b: { capturedAt: Date | null; sourceName?: string | null },
): number {
  const timeOf = (p: { capturedAt: Date | null }) =>
    p.capturedAt instanceof Date && !Number.isNaN(p.capturedAt.getTime())
      ? p.capturedAt.getTime()
      : Number.POSITIVE_INFINITY;
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta !== tb) return ta - tb;

  const sa = parseFilenameSequence(a.sourceName);
  const sb = parseFilenameSequence(b.sourceName);
  if (sa && sb) {
    if (sa.prefix !== sb.prefix) return sa.prefix < sb.prefix ? -1 : 1;
    if (sa.seq !== sb.seq) return sa.seq - sb.seq;
    return 0;
  }
  if (sa) return -1;
  if (sb) return 1;
  return 0;
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
 * Auto-group loose photos into per-item groups by capture-time bursts, a
 * filename-sequence pass for photos WITHOUT capture time (US-1540), plus a
 * dHash visual second pass. Groups come back in capture order; each group's
 * cover is its first photo under the deterministic provenance ordering
 * (time → filename sequence → input order). A timeless photo with no usable
 * filename sequence still becomes its own singleton group (nothing is
 * silently dropped — the user can merge it).
 */
export function autoGroupPhotos(
  photos: GroupablePhoto[],
  opts: AutoGroupOptions = {},
): AutoGroup[] {
  if (photos.length === 0) return [];
  const gap = opts.gapSeconds ?? DEFAULT_GAP_SECONDS;

  let map = autoAssign(photos, gap);
  // US-1540: timeless photos used to ALL become singletons; contiguous
  // filename-sequence runs now seed candidate groups for them first, so the
  // visual pass below can confirm/merge those like any time cluster.
  map = seedSequenceClusters(map, photos);
  if (opts.visual !== false) {
    map = applyVisualSecondPass(map, visualPairs(photos, opts.maxDistance));
  }

  const { clusters, needsSorting } = groupAssignments(photos, map);
  // Deterministic within-group order: capture time, then filename sequence,
  // then input order (the sort is stable, so ties keep input order).
  const groups: AutoGroup[] = clusters.map((c) => {
    const ordered = [...c.photos].sort(compareByProvenance);
    return {
      photoIds: ordered.map((p) => p.id),
      coverId: ordered[0]!.id,
    };
  });
  // Deterministic group order too. groupAssignments sorts clusters by earliest
  // capture time, but two all-timeless sequence clusters (new in US-1540 —
  // previously every cluster had a timed photo) both read Infinity there, and
  // an Infinity−Infinity comparator is NaN ⇒ unspecified order. Re-sorting by
  // the lead photo's provenance keeps timed clusters exactly as before (stable
  // sort, same primary key) and orders sequence clusters by filename.
  const byId = new Map(photos.map((p) => [p.id, p]));
  groups.sort((a, b) =>
    compareByProvenance(byId.get(a.photoIds[0]!)!, byId.get(b.photoIds[0]!)!),
  );
  for (const p of needsSorting) {
    groups.push({ photoIds: [p.id], coverId: p.id });
  }
  return groups;
}

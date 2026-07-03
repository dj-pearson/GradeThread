// US-532: auto-group a dumped folder of photos into per-item listing groups.
//
// This is the AutoLister wiring on top of the existing, well-tested clustering
// engine (lib/reconcile-cluster.ts) built for Photo Dump Reconciliation:
//   1. EXIF capture-time bursts  — clusterByTimeGap/autoAssign. Resellers shoot
//      one item, pause, shoot the next; the gap is a strong "new item" signal.
//   2. Visual second pass        — applyBoundedVisualMerge (US-1550) merges
//      the clusters of near-identical photos (the same garment shot out of
//      order) using the dHash every upload already computes, bounded by group
//      size and shooting-order locality so it can never chain a whole
//      same-background dump into one giant group.
// The output is mapped to AutoLister's group shape. Pure + side-effect-free so
// it's unit-tested without a DB or canvas.

import {
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

const PHASH_RE = /^[0-9a-f]{16}$/i;

/** A 64-bit dHash split into two u32 halves for fast XOR/popcount. */
interface ParsedHash {
  hi: number;
  lo: number;
}

function parsePhash(hash: string | null | undefined): ParsedHash | null {
  if (!hash || !PHASH_RE.test(hash)) return null;
  return {
    hi: Number.parseInt(hash.slice(0, 8), 16),
    lo: Number.parseInt(hash.slice(8), 16),
  };
}

// Classic 32-bit popcount (SWAR). All intermediates stay exact in JS numbers.
function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/**
 * Hamming distance between two 16-hex-char (64-bit) dHashes. Returns the max
 * (64) for a missing/malformed hash so an unknown pair is never treated as
 * similar. US-1541: integer popcount over two u32 halves — the old per-bit
 * BigInt loop cost ~64 BigInt ops per pair, which at a 600-photo O(n²) pass
 * (~180k pairs) was a seconds-long main-thread freeze.
 */
export function hammingHex(a: string, b: string): number {
  const pa = parsePhash(a);
  const pb = parsePhash(b);
  if (!pa || !pb) return 64;
  return popcount32((pa.hi ^ pb.hi) >>> 0) + popcount32((pa.lo ^ pb.lo) >>> 0);
}

// dHash distance at/below which two photos are treated as the same shot, so
// out-of-order photos of one garment merge. Conservative to avoid merging
// genuinely different items (which share, at most, a rough silhouette).
export const VISUAL_MERGE_MAX_DISTANCE = 10;

/**
 * Ceiling on how many photos auto-grouping will pile into one item through the
 * WEAK signals (filename runs, dHash merges). Nobody shoots more than about a
 * dozen photos of one garment; anything the heuristics grow past this is far
 * more likely a detection failure (US-1550: same-background clothing shots sit
 * within dHash range of each other, so unbounded transitive merging chained a
 * 600-photo dump into ONE group). Time-gap clusters are exempt — real EXIF
 * bursts are a strong signal and may legitimately be long.
 */
export const MAX_AUTO_GROUP_PHOTOS = 12;

/**
 * How far apart (in shooting order) two clusters may sit and still be merged
 * by the visual pass, measured in cluster ordinals. People shoot items
 * back-to-back: a same-garment reshoot lands a couple of clusters away, while
 * a "similar" pair spanning half the dump is a same-background false positive.
 */
export const VISUAL_MERGE_ORDINAL_WINDOW = 3;

/** A similar pair plus its dHash distance, so merges can be applied best-first. */
export interface DistancedPair extends SimilarPair {
  distance: number;
}

/**
 * Build "similar" pairs from dHash proximity. O(n²) over the staged set —
 * US-1541: each hash parses ONCE up front and the pairwise inner loop is pure
 * integer XOR+popcount (~ns per pair), so even a 600-photo session (~180k
 * pairs) completes in single-digit milliseconds without slicing.
 */
export function visualPairs(
  photos: GroupablePhoto[],
  maxDistance: number = VISUAL_MERGE_MAX_DISTANCE,
): DistancedPair[] {
  const parsed = photos.map((p) => parsePhash(p.phash));
  const pairs: DistancedPair[] = [];
  for (let i = 0; i < photos.length; i++) {
    const pa = parsed[i];
    if (!pa) continue;
    for (let j = i + 1; j < photos.length; j++) {
      const pb = parsed[j];
      if (!pb) continue;
      const dist =
        popcount32((pa.hi ^ pb.hi) >>> 0) + popcount32((pa.lo ^ pb.lo) >>> 0);
      if (dist <= maxDistance) {
        pairs.push({ a: photos[i]!.id, b: photos[j]!.id, distance: dist });
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
    // US-1550: a contiguous run only signals "one item" while it's plausibly
    // one item's shoot. A no-EXIF dump has ONE contiguous run spanning the
    // whole folder (600 photos ⇒ one giant group). Past the cap, seed each
    // photo as its own cluster instead: the run still contributes shooting
    // ORDER (the visual pass merges neighbors, bounded by size + window
    // below), just not a single boundary-free mega-group.
    const oneItem = run.length <= MAX_AUTO_GROUP_PHOTOS;
    for (const p of run) {
      const clusterId = oneItem ? `seq-${run[0]!.id}` : `seq-${p.id}`;
      next[p.id] = { clusterId, manual: false };
      changed = true;
    }
  }
  return changed ? next : prev;
}

/**
 * US-1550: the bounded visual second pass. The reconcile page's
 * applyVisualSecondPass unions clusters transitively with no limit — fine for
 * its opt-in embed-based pairs, but dHash on clothing photos is dominated by
 * the (shared) background, so on a big dump nearly every cluster chains into
 * one mega-group. This variant applies the closest pairs first and refuses a
 * merge that would (a) grow a group past MAX_AUTO_GROUP_PHOTOS or (b) join two
 * clusters more than VISUAL_MERGE_ORDINAL_WINDOW apart in shooting order.
 * Manual assignments and unclustered photos are untouched, as before.
 */
function applyBoundedVisualMerge(
  prev: AssignmentMap,
  pairs: DistancedPair[],
  photos: GroupablePhoto[],
): AssignmentMap {
  // Cluster membership — non-manual, clustered photos only (same eligibility
  // as applyVisualSecondPass).
  const members = new Map<string, GroupablePhoto[]>();
  for (const p of photos) {
    const a = prev[p.id];
    if (!a || a.manual || a.clusterId === null) continue;
    const arr = members.get(a.clusterId);
    if (arr) arr.push(p);
    else members.set(a.clusterId, [p]);
  }
  if (members.size < 2 || pairs.length === 0) return prev;

  // Shooting-order ordinal per cluster: position when clusters are sorted by
  // their earliest photo's provenance (time → filename sequence).
  const earliest = new Map<string, GroupablePhoto>();
  for (const [id, ps] of members) {
    earliest.set(
      id,
      ps.reduce((min, p) => (compareByProvenance(p, min) < 0 ? p : min)),
    );
  }
  const ordered = [...members.keys()].sort((x, y) =>
    compareByProvenance(earliest.get(x)!, earliest.get(y)!),
  );

  // Union-find over cluster ids, tracking size + the ordinal range covered.
  const parent = new Map<string, string>();
  const size = new Map<string, number>();
  const minOrd = new Map<string, number>();
  const maxOrd = new Map<string, number>();
  ordered.forEach((id, ord) => {
    parent.set(id, id);
    size.set(id, members.get(id)!.length);
    minOrd.set(id, ord);
    maxOrd.set(id, ord);
  });
  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  // Closest pairs first, so when the size cap bites it's the weakest
  // (most-likely-false) merges that lose out.
  const byDistance = [...pairs].sort((a, b) => a.distance - b.distance);
  let merged = false;
  for (const { a, b } of byDistance) {
    const aa = prev[a];
    const bb = prev[b];
    if (!aa || !bb || aa.manual || bb.manual) continue;
    if (aa.clusterId === null || bb.clusterId === null) continue;
    if (!parent.has(aa.clusterId) || !parent.has(bb.clusterId)) continue;
    const ra = find(aa.clusterId);
    const rb = find(bb.clusterId);
    if (ra === rb) continue;
    if (size.get(ra)! + size.get(rb)! > MAX_AUTO_GROUP_PHOTOS) continue;
    // Gap between the two components' ordinal ranges (0 when they overlap).
    const gap =
      Math.max(minOrd.get(ra)!, minOrd.get(rb)!) -
      Math.min(maxOrd.get(ra)!, maxOrd.get(rb)!);
    if (gap > VISUAL_MERGE_ORDINAL_WINDOW) continue;
    parent.set(rb, ra);
    size.set(ra, size.get(ra)! + size.get(rb)!);
    minOrd.set(ra, Math.min(minOrd.get(ra)!, minOrd.get(rb)!));
    maxOrd.set(ra, Math.max(maxOrd.get(ra)!, maxOrd.get(rb)!));
    merged = true;
  }
  if (!merged) return prev;

  const next: AssignmentMap = {};
  for (const [id, a] of Object.entries(prev)) {
    if (!a.manual && a.clusterId !== null && parent.has(a.clusterId)) {
      next[id] = { clusterId: find(a.clusterId), manual: false };
    } else {
      next[id] = a;
    }
  }
  return next;
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
    // US-1550: size- and shooting-order-bounded (the unbounded union used to
    // chain a whole same-background dump into one giant group).
    map = applyBoundedVisualMerge(map, visualPairs(photos, opts.maxDistance), photos);
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

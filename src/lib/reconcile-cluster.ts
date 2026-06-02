// Capture-time gap clustering for the Photo Dump Reconciliation feature
// (US-282 / RC-004).
//
// Resellers drop a whole haul of phone photos at once. Most people shoot one
// item, pause, then shoot the next — so the gaps between capture times are a
// strong signal for "where does one item end and the next begin". This is the
// pure, side-effect-free clustering core; the page (reconcile.tsx) feeds it the
// ingested photos and re-runs it live whenever the threshold slider moves.

/** Minimal shape the clusterer needs from a photo. */
export interface ClusterablePhoto {
  id: string;
  /** Original capture time (from EXIF, see lib/exif.ts), or null if unknown. */
  capturedAt: Date | null;
}

export interface ClusterResult<T extends ClusterablePhoto> {
  /**
   * Time-gap clusters, each in capture-time order, and the clusters themselves
   * ordered earliest-first. A gap >= the threshold between consecutive photos
   * starts a new cluster.
   */
  clusters: T[][];
  /**
   * Photos with no capture time. These are kept apart in a "Needs sorting"
   * bucket rather than being silently folded into a time cluster.
   */
  needsSorting: T[];
}

/** Default gap that starts a new cluster, in seconds. */
export const DEFAULT_GAP_SECONDS = 30;

/**
 * Groups photos into proposed item clusters by capture-time gaps.
 *
 * @param photos     the dump, in any order.
 * @param gapSeconds a gap of this many seconds OR MORE between two
 *                   consecutive (time-sorted) photos starts a new cluster.
 *                   Defaults to {@link DEFAULT_GAP_SECONDS}.
 */
export function clusterByTimeGap<T extends ClusterablePhoto>(
  photos: T[],
  gapSeconds: number = DEFAULT_GAP_SECONDS,
): ClusterResult<T> {
  const needsSorting: T[] = [];
  const timed: T[] = [];
  for (const p of photos) {
    if (p.capturedAt instanceof Date && !Number.isNaN(p.capturedAt.getTime())) {
      timed.push(p);
    } else {
      needsSorting.push(p);
    }
  }

  // Stable sort by capture time (ascending). Ties keep input order.
  timed.sort((a, b) => a.capturedAt!.getTime() - b.capturedAt!.getTime());

  const clusters: T[][] = [];
  // A non-positive threshold would split every photo into its own cluster
  // (0 >= 0), which is never useful; floor at 1ms so identical timestamps still
  // group together while any real gap still starts a new cluster.
  const gapMs = Math.max(gapSeconds * 1000, 1);

  let current: T[] | null = null;
  let prevTime = 0;
  for (const p of timed) {
    const t = p.capturedAt!.getTime();
    if (current === null || t - prevTime >= gapMs) {
      current = [p];
      clusters.push(current);
    } else {
      current.push(p);
    }
    prevTime = t;
  }

  return { clusters, needsSorting };
}

// ---------------------------------------------------------------------------
// Manual cluster editing (US-284 / RC-006)
//
// Auto time-gap clustering is only a first guess. The reseller needs to fix it
// by hand: move photos into a new or existing cluster, merge two clusters, or
// split a subset out. Those manual edits must (a) survive a threshold change so
// the slider's live re-clustering doesn't undo them, and (b) be flagged so the
// optional visual-similarity pass (US-283) leaves them alone.
//
// The model below is a pure, side-effect-free assignment map keyed by photo id;
// the page holds one of these in state and the reconcile session persists it.
// ---------------------------------------------------------------------------

/** Where a single photo currently lives. clusterId === null ⇒ Needs sorting. */
export interface PhotoAssignment {
  clusterId: string | null;
  /** True once a user explicitly placed this photo; protected from re-cluster. */
  manual: boolean;
}

/** photo id → its assignment. */
export type AssignmentMap = Record<string, PhotoAssignment>;

/** A rendered group: a cluster id and the photos in it, in capture order. */
export interface AssignedGroup<T extends ClusterablePhoto> {
  clusterId: string;
  photos: T[];
}

export interface GroupedAssignments<T extends ClusterablePhoto> {
  clusters: AssignedGroup<T>[];
  needsSorting: T[];
}

/** Deterministic-friendly id factory (override in tests). */
export type IdFactory = () => string;
const defaultIdFactory: IdFactory = () => crypto.randomUUID();

/** Stable cluster id derived from the earliest photo in an auto cluster. */
function autoClusterId(photos: ClusterablePhoto[]): string {
  return `auto-${photos[0]!.id}`;
}

/**
 * Builds a fresh assignment map purely from time-gap clustering — every entry
 * is non-manual. Photos with no capture time map to clusterId null.
 */
export function autoAssign<T extends ClusterablePhoto>(
  photos: T[],
  gapSeconds: number = DEFAULT_GAP_SECONDS,
): AssignmentMap {
  const { clusters, needsSorting } = clusterByTimeGap(photos, gapSeconds);
  const map: AssignmentMap = {};
  for (const cluster of clusters) {
    const id = autoClusterId(cluster);
    for (const p of cluster) map[p.id] = { clusterId: id, manual: false };
  }
  for (const p of needsSorting) map[p.id] = { clusterId: null, manual: false };
  return map;
}

/**
 * Re-runs auto-clustering at a new threshold while PRESERVING manual edits:
 * photos flagged manual keep their assignment; everything else is re-clustered
 * among itself. New photos not yet in the map are auto-assigned too.
 */
export function reapplyThreshold<T extends ClusterablePhoto>(
  prev: AssignmentMap,
  photos: T[],
  gapSeconds: number,
): AssignmentMap {
  const manualIds = new Set(
    Object.entries(prev)
      .filter(([, a]) => a.manual)
      .map(([id]) => id),
  );
  const autoPhotos = photos.filter((p) => !manualIds.has(p.id));
  const next: AssignmentMap = autoAssign(autoPhotos, gapSeconds);
  // Re-attach the preserved manual assignments.
  for (const id of manualIds) {
    if (prev[id]) next[id] = prev[id];
  }
  return next;
}

function withManual(prev: AssignmentMap, ids: string[], clusterId: string | null): AssignmentMap {
  const next: AssignmentMap = { ...prev };
  for (const id of ids) next[id] = { clusterId, manual: true };
  return next;
}

/** Move the given photos into a brand-new cluster (also covers "split out"). */
export function moveToNewCluster(
  prev: AssignmentMap,
  ids: string[],
  newId: IdFactory = defaultIdFactory,
): AssignmentMap {
  if (ids.length === 0) return prev;
  return withManual(prev, ids, `manual-${newId()}`);
}

/** Move the given photos into an existing cluster (or Needs sorting if null). */
export function moveToCluster(
  prev: AssignmentMap,
  ids: string[],
  clusterId: string | null,
): AssignmentMap {
  if (ids.length === 0) return prev;
  return withManual(prev, ids, clusterId);
}

/** Merge cluster `from` into cluster `into`: every photo of `from` joins `into`. */
export function mergeClusters(
  prev: AssignmentMap,
  into: string,
  from: string,
): AssignmentMap {
  const ids = Object.entries(prev)
    .filter(([, a]) => a.clusterId === from)
    .map(([id]) => id);
  return withManual(prev, ids, into);
}

/** Split a subset of photos out of their cluster into a new one. */
export function splitCluster(
  prev: AssignmentMap,
  ids: string[],
  newId: IdFactory = defaultIdFactory,
): AssignmentMap {
  return moveToNewCluster(prev, ids, newId);
}

/**
 * Projects photos + an assignment map into render-ready groups. Clusters are
 * ordered by their earliest capture time (untimed clusters last); photos within
 * a cluster are in capture order, with untimed ones appended.
 */
export function groupAssignments<T extends ClusterablePhoto>(
  photos: T[],
  map: AssignmentMap,
): GroupedAssignments<T> {
  const byCluster = new Map<string, T[]>();
  const needsSorting: T[] = [];
  for (const p of photos) {
    const a = map[p.id];
    const clusterId = a?.clusterId ?? null;
    if (clusterId === null) {
      needsSorting.push(p);
      continue;
    }
    const arr = byCluster.get(clusterId);
    if (arr) arr.push(p);
    else byCluster.set(clusterId, [p]);
  }

  const timeOf = (p: T) =>
    p.capturedAt instanceof Date && !Number.isNaN(p.capturedAt.getTime())
      ? p.capturedAt.getTime()
      : Number.POSITIVE_INFINITY;

  const clusters: AssignedGroup<T>[] = [...byCluster.entries()].map(([clusterId, ps]) => {
    const sorted = [...ps].sort((a, b) => timeOf(a) - timeOf(b));
    return { clusterId, photos: sorted };
  });
  // Earliest-first; untimed-only clusters (Infinity) sink to the bottom.
  clusters.sort((a, b) => timeOf(a.photos[0]!) - timeOf(b.photos[0]!));

  return { clusters, needsSorting };
}

// ---------------------------------------------------------------------------
// Visual-similarity second pass (US-283 / RC-005)
//
// Time-gap clustering misses photos of the same garment shot out of order. An
// optional, opt-in pass asks the edge embed endpoint for pairwise visual
// similarity, then MERGES the time clusters those photos sit in — but only for
// photos the user hasn't manually placed, so it can never undo a manual edit.
// ---------------------------------------------------------------------------

/** A similar pair as returned (already thresholded) by the embed endpoint. */
export interface SimilarPair {
  a: string;
  b: string;
}

/** Minimal disjoint-set for unioning cluster ids. */
function findRoot(parent: Map<string, string>, x: string): string {
  let root = x;
  while (parent.get(root) !== undefined && parent.get(root) !== root) {
    root = parent.get(root)!;
  }
  // Path-compress.
  let cur = x;
  while (parent.get(cur) !== undefined && parent.get(cur) !== cur) {
    const next = parent.get(cur)!;
    parent.set(cur, root);
    cur = next;
  }
  return root;
}

/**
 * Applies a visual-similarity second pass: for each similar pair where NEITHER
 * photo was manually placed, the two photos' clusters are merged. Manual
 * assignments are left exactly as-is. Returns a new AssignmentMap.
 */
export function applyVisualSecondPass(
  prev: AssignmentMap,
  pairs: SimilarPair[],
): AssignmentMap {
  // Union the clusters of non-manual, currently-clustered photos.
  const parent = new Map<string, string>();
  const union = (x: string, y: string) => {
    const rx = findRoot(parent, x);
    const ry = findRoot(parent, y);
    if (rx !== ry) parent.set(ry, rx);
  };

  for (const { a, b } of pairs) {
    const aa = prev[a];
    const bb = prev[b];
    if (!aa || !bb) continue;
    if (aa.manual || bb.manual) continue; // never override a manual edit
    if (aa.clusterId === null || bb.clusterId === null) continue; // skip unsorted
    if (aa.clusterId === bb.clusterId) continue;
    if (!parent.has(aa.clusterId)) parent.set(aa.clusterId, aa.clusterId);
    if (!parent.has(bb.clusterId)) parent.set(bb.clusterId, bb.clusterId);
    union(aa.clusterId, bb.clusterId);
  }

  if (parent.size === 0) return prev;

  const next: AssignmentMap = {};
  for (const [id, a] of Object.entries(prev)) {
    if (!a.manual && a.clusterId !== null && parent.has(a.clusterId)) {
      next[id] = { clusterId: findRoot(parent, a.clusterId), manual: false };
    } else {
      next[id] = a;
    }
  }
  return next;
}

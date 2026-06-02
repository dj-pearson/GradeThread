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

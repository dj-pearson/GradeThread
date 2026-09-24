import type { AssignmentMap } from "@/lib/reconcile-cluster";

/** The slice of a commit result the board needs to prune itself. */
export interface BoardCommitOutcome {
  clusterId: string;
  ok: boolean;
  itemId?: string;
  savedPhotoIds?: string[];
}

export interface PrunedBoard<P extends { id: string }> {
  /** Photos still on the board: failed clusters, unsaved leftovers, unsorted. */
  photos: P[];
  assignments: AssignmentMap;
  /** Photos taken off the board, so the caller can revoke their previews. */
  dropped: P[];
  /** Cluster id -> the item an earlier partial try created, so a retry
   *  attaches the leftovers to it instead of making a second draft. */
  resume: Record<string, string>;
}

/**
 * After a commit, take off the board everything that is now in an item and
 * leave the rest editable and committable.
 *
 * A cluster that fully succeeded goes entirely. A cluster that partly
 * succeeded loses only the photos that saved, keeps the rest in the same
 * group, and remembers its item so the next Commit adds to it. A cluster that
 * failed before any upload stays as it was. Unsorted photos are untouched.
 *
 * The board used to lock after any success, and the only retry was a reload
 * that recommitted the clusters that had already gone through.
 */
export function pruneCommitted<P extends { id: string }>(
  photos: P[],
  assignments: AssignmentMap,
  results: BoardCommitOutcome[],
  /** Ids of the photos that were IN the commit. When given, a photo added to
   *  a group while the commit ran stays on the board even if that group went
   *  through: it was never uploaded, so it is in no item. */
  committedIds?: ReadonlySet<string>,
): PrunedBoard<P> {
  const saved = new Set(results.flatMap((r) => r.savedPhotoIds ?? []));
  const done = new Set(results.filter((r) => r.ok).map((r) => r.clusterId));
  const resume: Record<string, string> = {};
  for (const r of results) {
    if (!r.ok && r.itemId) resume[r.clusterId] = r.itemId;
  }

  const kept: P[] = [];
  const dropped: P[] = [];
  const nextAssignments: AssignmentMap = {};
  for (const p of photos) {
    const a = assignments[p.id];
    const clusterId = a?.clusterId ?? null;
    const inCommit = committedIds ? committedIds.has(p.id) : true;
    if (saved.has(p.id) || (inCommit && clusterId !== null && done.has(clusterId))) {
      dropped.push(p);
      continue;
    }
    kept.push(p);
    if (a) {
      // A leftover of a partial cluster is pinned as a manual edit, so a gap
      // change cannot regroup it away from the item it belongs to.
      nextAssignments[p.id] =
        clusterId !== null && resume[clusterId] ? { ...a, manual: true } : a;
    }
  }
  return { photos: kept, assignments: nextAssignments, dropped, resume };
}

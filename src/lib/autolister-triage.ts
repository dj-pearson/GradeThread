// US-1907: pure triage-bucket computation for the AutoLister group workbench.
// A 45-group session is hard to scan; the triage strip summarises session
// health and lets the seller jump to the groups that need work. These helpers
// classify groups into needs-attention buckets — no React, fully unit-tested.

// A plain union, not an `as const` array: nothing iterates these, so the array
// only ever existed to derive this type and was emitted into the bundle for it.
export type TriageCondition =
  | "singleton"
  | "oversized"
  | "missing_cover_or_tag"
  | "has_suggestion";

export interface TriageGroup {
  id: string;
  photoIds: string[];
  /** The group's cover photo id (front). */
  coverId: string | null;
  /** photoId → role (e.g. "front" | "back" | "tag" | "detail"). */
  roles: Record<string, string>;
}

export interface TriageSuggestion {
  type: "merge" | "split" | "move";
  /** merge: [a, b] · split: [group] · move: [from, to]. */
  group_ids: string[];
}

export interface TriageSummary {
  totalGroups: number;
  totalPhotos: number;
  ungroupedCount: number;
  /** group ids per condition, in group order (stable for rendering). */
  buckets: Record<TriageCondition, string[]>;
}

/** The role that marks a garment's tag/label shot — a listing wants one. */
const TAG_ROLE = "tag";

/**
 * Classify each group into the needs-attention buckets:
 *  - singleton: exactly one photo (likely an un-merged stray)
 *  - oversized: more than `maxGroupPhotos` photos (likely two items merged)
 *  - missing_cover_or_tag: no valid cover photo, or no tag/label shot
 *  - has_suggestion: referenced by an unresolved AI grouping suggestion
 * Plus the session totals. Pure.
 */
export function computeTriage(
  groups: readonly TriageGroup[],
  suggestions: readonly TriageSuggestion[],
  ungroupedCount: number,
  maxGroupPhotos: number,
): TriageSummary {
  const singleton: string[] = [];
  const oversized: string[] = [];
  const missing_cover_or_tag: string[] = [];
  let totalPhotos = 0;

  for (const g of groups) {
    totalPhotos += g.photoIds.length;
    if (g.photoIds.length === 1) singleton.push(g.id);
    if (g.photoIds.length > maxGroupPhotos) oversized.push(g.id);
    const hasCover = !!g.coverId && g.photoIds.includes(g.coverId);
    const hasTag = g.photoIds.some((pid) => g.roles[pid] === TAG_ROLE);
    if (!hasCover || !hasTag) missing_cover_or_tag.push(g.id);
  }

  // A suggestion points at its source group (move) or every group it spans
  // (merge/split). Only count groups that still exist, and dedupe.
  const groupIds = new Set(groups.map((g) => g.id));
  const flagged = new Set<string>();
  for (const s of suggestions) {
    const ids = s.type === "move" ? s.group_ids.slice(0, 1) : s.group_ids;
    for (const id of ids) if (groupIds.has(id)) flagged.add(id);
  }
  const has_suggestion = groups.map((g) => g.id).filter((id) => flagged.has(id));

  return {
    totalGroups: groups.length,
    totalPhotos,
    ungroupedCount,
    buckets: { singleton, oversized, missing_cover_or_tag, has_suggestion },
  };
}

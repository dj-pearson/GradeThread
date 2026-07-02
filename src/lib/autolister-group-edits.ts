// US-1543: pure group-editing transforms for the AutoLister drag-and-drop
// workbench. The page's drag handlers and "Move to group…" menus all funnel
// through these two functions, so the mutation semantics (cover repair, empty-
// group dissolution, role pruning, no-op detection for undo) are unit-tested
// without any DnD machinery.

export interface EditableGroup {
  id: string;
  photoIds: string[];
  coverId: string;
  /**
   * True once the seller hand-placed photos (drag-reorder or positional drop):
   * generate() then writes the photoIds order as sort_order (cover still
   * first) instead of the role-derived order. Roles are preserved either way.
   */
  manualOrder?: boolean;
  roles?: Record<string, string>;
}

/**
 * Move `photoIds` into `targetGroupId` (or back to Ungrouped when null),
 * removing them from whichever groups currently hold them. Inserting before
 * `beforePhotoId` (a photo already in the target) is a hand-placement and
 * marks the target `manualOrder`; a plain drop appends without changing the
 * ordering mode. Groups emptied by the move dissolve; a moved-away cover is
 * repaired to the group's next photo; moved-out photos' role entries are
 * pruned (they join the target as default-role photos).
 *
 * Returns the SAME array reference when the move is a no-op (nothing removed
 * anywhere and nothing new joins the target), so callers can skip the undo
 * snapshot + toast.
 */
export function movePhotosToGroup<T extends EditableGroup>(
  groups: T[],
  photoIds: string[],
  targetGroupId: string | null,
  beforePhotoId: string | null = null,
): T[] {
  const moving = new Set(photoIds);
  if (moving.size === 0) return groups;

  let removedAny = false;
  const afterRemoval = groups.map((g) => {
    // Photos already in the target stay put — they are not "removed".
    if (g.id === targetGroupId) return g;
    const photoIdsLeft = g.photoIds.filter((id) => !moving.has(id));
    if (photoIdsLeft.length === g.photoIds.length) return g;
    removedAny = true;
    const roles = g.roles
      ? Object.fromEntries(
        Object.entries(g.roles).filter(([id]) => !moving.has(id)),
      )
      : undefined;
    return {
      ...g,
      photoIds: photoIdsLeft,
      coverId: moving.has(g.coverId) ? (photoIdsLeft[0] ?? "") : g.coverId,
      roles,
    };
  });

  let changedTarget = false;
  const next = afterRemoval
    .map((g) => {
      if (g.id !== targetGroupId) return g;
      const incoming = photoIds.filter((id) => !g.photoIds.includes(id));
      const positional = beforePhotoId != null && g.photoIds.includes(beforePhotoId);
      if (incoming.length === 0 && !positional) return g;

      let photoIdsNext: string[];
      if (positional) {
        // Hand placement: every moving photo (already-members included) lands
        // together right before the anchor.
        const rest = g.photoIds.filter((id) => !moving.has(id));
        const at = rest.indexOf(beforePhotoId);
        photoIdsNext = [
          ...rest.slice(0, at),
          ...photoIds.filter((id, i) => photoIds.indexOf(id) === i),
          ...rest.slice(at),
        ];
      } else {
        photoIdsNext = [...g.photoIds, ...incoming];
      }
      // A positional drop of already-member photos can land them where they
      // already were — that's still a no-op.
      const orderChanged =
        photoIdsNext.length !== g.photoIds.length ||
        photoIdsNext.some((id, i) => id !== g.photoIds[i]);
      if (!orderChanged) return g;
      changedTarget = true;
      return {
        ...g,
        photoIds: photoIdsNext,
        manualOrder: positional ? true : g.manualOrder,
      };
    })
    .filter((g) => g.photoIds.length > 0);

  if (!removedAny && !changedTarget) return groups;
  return next;
}

/**
 * Reorder within one group: move `activeId` to `overId`'s position. Marks the
 * group `manualOrder` so generate() persists this order as sort_order. Returns
 * the SAME array reference on a no-op (unknown ids / same position).
 */
export function reorderWithinGroup<T extends EditableGroup>(
  groups: T[],
  groupId: string,
  activeId: string,
  overId: string,
): T[] {
  const group = groups.find((g) => g.id === groupId);
  if (!group) return groups;
  const from = group.photoIds.indexOf(activeId);
  const to = group.photoIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return groups;
  const photoIds = [...group.photoIds];
  photoIds.splice(from, 1);
  photoIds.splice(to, 0, activeId);
  return groups.map((g) =>
    g.id === groupId ? { ...g, photoIds, manualOrder: true } : g
  );
}

// The pipeline board's decisions, pulled out of pipeline.tsx so they can be
// tested without rendering a drag-and-drop board.
//
//   planBatchAdvance   which selected cards move one stage, which go to the
//                      bulk-grade dialog, and which are refused (and why).
//   moveCardOptimistically
//                      the drag write: optimistic cache update, save, and on
//                      failure a rollback of ONLY the dragged card (US-1633).

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { FLIPDESK_PIPELINE, ITEM_STATUS_LABELS } from "@/lib/constants";
import { validateStatusChange } from "@/lib/pipeline-rules";
import type { ItemStatus } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";

// US-1428: 'acquired' is a real early status with no column of its own, so an
// item set to Acquired would silently vanish from the board. Surface it in the
// Sourced column and treat it as sourced when advancing.
export function pipelineColumnFor(s: ItemStatus): ItemStatus {
  return s === "acquired" ? "sourced" : s;
}

// The pipeline stage immediately after `s`, or null if `s` is last/off-pipeline.
export function nextPipelineStatus(s: ItemStatus): ItemStatus | null {
  const idx = FLIPDESK_PIPELINE.findIndex((p) => p.status === pipelineColumnFor(s));
  if (idx < 0 || idx >= FLIPDESK_PIPELINE.length - 1) return null;
  return FLIPDESK_PIPELINE[idx + 1]?.status ?? null;
}

export interface BatchMove {
  item: ItemListRow;
  next: ItemStatus;
}

export interface BatchRefusal {
  title: string;
  ok: false;
  detail: string;
}

export interface BatchAdvancePlan {
  /** Cards that pass validation and should be written one stage on. */
  toMove: BatchMove[];
  /** Cards whose next stage is grading: handed to the bulk-grade dialog. */
  gradingBound: ItemListRow[];
  /** Cards that cannot advance, with the reason shown in the results dialog. */
  refused: BatchRefusal[];
}

export function planBatchAdvance(selected: ItemListRow[]): BatchAdvancePlan {
  // US-1458: the stage after Photographed is grading, which is owned by the
  // grade-submission flow (validateStatusChange always rejects a plain move
  // into it). Peel those items off and route them into the bulk-grade dialog
  // rather than reporting a guaranteed failure for every one.
  const gradingBound = selected.filter(
    (it) => nextPipelineStatus(it.status) === "grading" && it.grade_value == null,
  );
  const toMove: BatchMove[] = [];
  const refused: BatchRefusal[] = [];
  for (const it of selected) {
    if (gradingBound.includes(it)) continue;
    const next = nextPipelineStatus(it.status);
    if (!next) {
      refused.push({
        title: it.item_title,
        ok: false,
        detail: `No next stage after ${ITEM_STATUS_LABELS[it.status]}`,
      });
      continue;
    }
    const reason = validateStatusChange(it, next);
    if (reason) {
      refused.push({ title: it.item_title, ok: false, detail: reason });
      continue;
    }
    toMove.push({ item: it, next });
  }
  return { toMove, gradingBound, refused };
}

/**
 * Write the new status into the board's cache, then save it. If the save
 * fails, put back ONLY the dragged card's status (US-1633): restoring a
 * snapshot of the whole array would also revert a concurrent drag or edit of a
 * different card that landed while this save was in flight.
 *
 * Resolves to null on success, or the error the save reported.
 */
export async function moveCardOptimistically(opts: {
  qc: QueryClient;
  listKey: QueryKey;
  itemId: string;
  from: ItemStatus;
  to: ItemStatus;
  save: () => PromiseLike<{ error: unknown }>;
}): Promise<unknown | null> {
  const { qc, listKey, itemId, from, to, save } = opts;
  // US-1633: cancel any in-flight ["items_full"] refetch first, or it could
  // land after the optimistic write and clobber it.
  await qc.cancelQueries({ queryKey: ["items_full"] });
  const setStatus = (status: ItemStatus) =>
    qc.setQueryData<ItemListRow[]>(listKey, (old) =>
      (old ?? []).map((i) => (i.id === itemId ? { ...i, status } : i)),
    );
  setStatus(to);
  try {
    const { error } = await save();
    if (error) throw error;
    return null;
  } catch (err) {
    setStatus(from);
    return err;
  }
}

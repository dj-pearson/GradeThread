// The pipeline board's decisions, pulled out of pipeline.tsx so they can be
// tested without rendering a drag-and-drop board.
//
//   planBatchAdvance   which selected cards move one stage, which go to the
//                      bulk-grade dialog, and which are refused (and why).
//   moveCardOptimistically
//                      the drag write: optimistic cache update, save, and on
//                      failure a rollback of ONLY the dragged card (US-1633).

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
  nextPipelineStatus,
  pipelineColumnFor,
  planBatchAdvance as planBoardWrites,
  type BatchAdvancePlan as BoardWritePlan,
} from "@/lib/pipeline-board";
import type { ItemStatus } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";

// The stage rules live in src/lib/pipeline-board.ts; re-exported so the page
// and its tests read them from one place.
export { nextPipelineStatus, pipelineColumnFor };

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
  /**
   * The same cards grouped by target stage: one UPDATE per group rather than
   * one per card (pipeline-board.ts planBatchAdvance).
   */
  groups: BoardWritePlan["groups"];
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
  const rest = selected.filter((it) => !gradingBound.includes(it));
  const board = planBoardWrites(rest);
  const toMove: BatchMove[] = board.groups.flatMap((g) =>
    g.items.map((item) => ({ item, next: g.status })),
  );
  const refused: BatchRefusal[] = board.refused.map((r) => ({
    title: r.title,
    ok: false,
    detail: r.detail,
  }));
  return { toMove, groups: board.groups, gradingBound, refused };
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

/** INV-8: what a stage write that changed zero rows means. */
export const CHANGED_SINCE_LOADED = "Changed since you loaded the board.";

/** The slice of the supabase client the drag write needs. */
export interface StageWriteClient {
  from: (table: "inventory_items") => {
    update: (patch: never) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => {
          select: (cols: string) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
        };
      };
    };
  };
}

/**
 * INV-8: the drag write. It carries the status the board SHOWED, so a stale
 * board (the item sold or moved in another tab) changes zero rows instead of
 * dragging a sold item backwards, and zero rows comes back as an error the
 * caller can name.
 */
export async function writeStageMove(
  client: StageWriteClient,
  itemId: string,
  from: ItemStatus,
  to: ItemStatus,
): Promise<{ error: unknown }> {
  const { data, error } = await client
    .from("inventory_items")
    .update({ status: to } as never)
    .eq("id", itemId)
    .eq("status", from)
    .select("id");
  if (error) return { error };
  if ((data ?? []).length === 0) return { error: new Error(CHANGED_SINCE_LOADED) };
  return { error: null };
}

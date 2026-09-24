// The pipeline board's decisions (pipeline-plan.ts), tested without rendering
// the drag-and-drop board.
//
// moveCardOptimistically carries the US-1633 claim: a failed drag rolls back
// ONLY the dragged card. Restoring a snapshot of the whole list would also
// revert a second card that changed while the save was in flight, and nothing
// on screen would say so.

import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ItemListRow } from "@/lib/item-list-columns";
import {
  moveCardOptimistically,
  writeStageMove,
  CHANGED_SINCE_LOADED,
  nextPipelineStatus,
  planBatchAdvance,
} from "@/pages/flipdesk/pipeline-plan";

function card(over: Partial<ItemListRow> & { id: string }): ItemListRow {
  return {
    item_title: `Item ${over.id}`,
    status: "sourced",
    grade_value: null,
    measurements: null,
    target_price: null,
    list_price: null,
    sale_price: null,
    ...over,
  } as unknown as ItemListRow;
}

describe("nextPipelineStatus", () => {
  it("treats acquired as sourced (US-1428)", () => {
    expect(nextPipelineStatus("acquired")).toBe("cataloged");
    expect(nextPipelineStatus("sourced")).toBe("cataloged");
  });

  it("has no stage after the last one, or for an off-board status", () => {
    expect(nextPipelineStatus("returned")).toBeNull();
    expect(nextPipelineStatus("archived")).toBeNull();
  });
});

describe("planBatchAdvance", () => {
  it("splits a selection into moves, grading-bound cards and refusals", () => {
    const sourced = card({ id: "a", status: "sourced" });
    const ungraded = card({ id: "b", status: "photographed" });
    const unmeasured = card({ id: "c", status: "cataloged" });
    const last = card({ id: "d", status: "returned" });

    const plan = planBatchAdvance([sourced, ungraded, unmeasured, last]);

    expect(plan.toMove).toEqual([{ item: sourced, next: "cataloged" }]);
    // US-1458: an ungraded Photographed card goes to the bulk-grade dialog,
    // not into a guaranteed validation failure.
    expect(plan.gradingBound).toEqual([ungraded]);
    expect(plan.refused.map((r) => [r.title, r.detail])).toEqual([
      ["Item c", "Item needs measurements before it can move to Measured."],
      ["Item d", "No next stage after Returned"],
    ]);
  });

  it("does not route an already-graded Photographed card to grading", () => {
    // It has a grade, so the grade dialog would charge for a second one. It
    // is refused with the reason instead.
    const graded = card({ id: "g", status: "photographed", grade_value: 8.5 });
    const plan = planBatchAdvance([graded]);
    expect(plan.gradingBound).toEqual([]);
    expect(plan.toMove).toEqual([]);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.detail).toMatch(/Submit the item for grading/);
  });

  it("groups the moves by target stage so each stage is one write", () => {
    const a = card({ id: "a", status: "sourced" });
    const b = card({ id: "b", status: "acquired" });
    const c = card({ id: "c", status: "cataloged", measurements: { chest: 22 } } as never);
    const plan = planBatchAdvance([a, b, c]);
    expect(plan.groups.map((g) => [g.status, g.items.map((i) => i.id)])).toEqual([
      ["cataloged", ["a", "b"]],
      ["measured", ["c"]],
    ]);
    expect(plan.toMove.map((m) => [m.item.id, m.next])).toEqual([
      ["a", "cataloged"],
      ["b", "cataloged"],
      ["c", "measured"],
    ]);
  });

  it("refuses a card with no front+back photos a move into Photographed", () => {
    const measured = card({ id: "p", status: "measured", has_required_photos: false } as never);
    const plan = planBatchAdvance([measured]);
    expect(plan.toMove).toEqual([]);
    expect(plan.refused[0]?.detail).toMatch(/front and back photo/);
  });

  it("moves a measured card once it has measurements", () => {
    const measured = card({ id: "m", status: "cataloged", measurements: { chest: 22 } } as never);
    expect(planBatchAdvance([measured]).toMove).toEqual([
      { item: measured, next: "measured" },
    ]);
  });
});

describe("moveCardOptimistically (US-1633)", () => {
  const KEY = ["items_full", "list", "owner-1"] as const;

  function client(rows: ItemListRow[]) {
    const qc = new QueryClient();
    qc.setQueryData(KEY, rows);
    return qc;
  }
  const statusOf = (qc: QueryClient, id: string) =>
    qc.getQueryData<ItemListRow[]>(KEY)?.find((r) => r.id === id)?.status;

  it("a failed save rolls back only the dragged card and keeps a concurrent change", async () => {
    const qc = client([
      card({ id: "dragged", status: "sourced" }),
      card({ id: "other", status: "sourced" }),
    ]);

    const err = await moveCardOptimistically({
      qc,
      listKey: KEY,
      itemId: "dragged",
      from: "sourced",
      to: "cataloged",
      save: async () => {
        // The optimistic write is already on the board...
        expect(statusOf(qc, "dragged")).toBe("cataloged");
        // ...and while this save is in flight, a second drag lands on a
        // different card.
        qc.setQueryData<ItemListRow[]>(KEY, (old) =>
          (old ?? []).map((r) => (r.id === "other" ? { ...r, status: "cataloged" } : r)),
        );
        return { error: new Error("permission denied") };
      },
    });

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("permission denied");
    expect(statusOf(qc, "dragged")).toBe("sourced");
    expect(statusOf(qc, "other"), "the other card's move must survive the rollback").toBe(
      "cataloged",
    );
  });

  it("a thrown save is treated the same as a returned error", async () => {
    const qc = client([card({ id: "x", status: "measured" })]);
    const err = await moveCardOptimistically({
      qc,
      listKey: KEY,
      itemId: "x",
      from: "measured",
      to: "photographed",
      save: () => Promise.reject(new Error("network")),
    });
    expect((err as Error).message).toBe("network");
    expect(statusOf(qc, "x")).toBe("measured");
  });

  it("a successful save keeps the new status and cancels an in-flight refetch first", async () => {
    const qc = client([card({ id: "x", status: "sourced" })]);
    const cancel = vi.spyOn(qc, "cancelQueries");
    const err = await moveCardOptimistically({
      qc,
      listKey: KEY,
      itemId: "x",
      from: "sourced",
      to: "cataloged",
      save: async () => ({ error: null }),
    });
    expect(err).toBeNull();
    expect(statusOf(qc, "x")).toBe("cataloged");
    expect(cancel).toHaveBeenCalledWith({ queryKey: ["items_full"] });
  });
});

describe("writeStageMove (INV-8)", () => {
  function client(rows: unknown[] | null, error: unknown = null) {
    const calls: { eq: [string, string][]; patch?: unknown } = { eq: [] };
    const c = {
      from: () => ({
        update: (patch: never) => {
          calls.patch = patch;
          const chain = {
            eq: (col: string, val: string) => {
              calls.eq.push([col, val]);
              return chain;
            },
            select: () => Promise.resolve({ data: rows, error }),
          };
          return chain;
        },
      }),
    };
    return { c: c as unknown as Parameters<typeof writeStageMove>[0], calls };
  }

  it("carries the status the board showed as a precondition", async () => {
    const { c, calls } = client([{ id: "i1" }]);
    const res = await writeStageMove(c, "i1", "listed" as never, "sold" as never);
    expect(res.error).toBeNull();
    expect(calls.eq).toEqual([["id", "i1"], ["status", "listed"]]);
    expect(calls.patch).toEqual({ status: "sold" });
  });

  it("reports zero changed rows as 'Changed since you loaded the board'", async () => {
    const { c } = client([]);
    const res = await writeStageMove(c, "i1", "sold" as never, "listed" as never);
    expect((res.error as Error).message).toBe(CHANGED_SINCE_LOADED);
  });
});

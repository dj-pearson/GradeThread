import { describe, expect, it } from "vitest";
import {
  type EditableGroup,
  movePhotosToGroup,
  reorderWithinGroup,
} from "./autolister-group-edits";

function g(
  id: string,
  photoIds: string[],
  extra: Partial<EditableGroup> = {},
): EditableGroup {
  return { id, photoIds, coverId: photoIds[0] ?? "", ...extra };
}

describe("movePhotosToGroup (US-1543)", () => {
  it("moves a photo between groups (appended at the end)", () => {
    const groups = [g("a", ["p1", "p2"]), g("b", ["p3"])];
    const next = movePhotosToGroup(groups, ["p2"], "b");
    expect(next.find((x) => x.id === "a")!.photoIds).toEqual(["p1"]);
    expect(next.find((x) => x.id === "b")!.photoIds).toEqual(["p3", "p2"]);
    // A plain append does not flip the ordering mode.
    expect(next.find((x) => x.id === "b")!.manualOrder).toBeUndefined();
  });

  it("moves an ungrouped photo into a group (no source group to touch)", () => {
    const groups = [g("a", ["p1"])];
    const next = movePhotosToGroup(groups, ["loose"], "a");
    expect(next[0]!.photoIds).toEqual(["p1", "loose"]);
  });

  it("moves photos back to Ungrouped (target null) and dissolves emptied groups", () => {
    const groups = [g("a", ["p1"]), g("b", ["p2", "p3"])];
    const next = movePhotosToGroup(groups, ["p1"], null);
    expect(next.map((x) => x.id)).toEqual(["b"]);
  });

  it("repairs the cover and prunes roles when the cover moves away", () => {
    const groups = [
      g("a", ["p1", "p2"], { coverId: "p1", roles: { p1: "front", p2: "back" } }),
      g("b", ["p3"]),
    ];
    const next = movePhotosToGroup(groups, ["p1"], "b");
    const a = next.find((x) => x.id === "a")!;
    expect(a.coverId).toBe("p2");
    expect(a.roles).toEqual({ p2: "back" }); // moved-out role pruned
  });

  it("multi-select drag: moves the whole selection together", () => {
    const groups = [g("a", ["p1", "p2", "p3"]), g("b", ["p4"])];
    const next = movePhotosToGroup(groups, ["p1", "p3"], "b");
    expect(next.find((x) => x.id === "a")!.photoIds).toEqual(["p2"]);
    expect(next.find((x) => x.id === "b")!.photoIds).toEqual(["p4", "p1", "p3"]);
  });

  it("positional drop (beforePhotoId) inserts there and marks manualOrder", () => {
    const groups = [g("a", ["p1"]), g("b", ["p2", "p3"])];
    const next = movePhotosToGroup(groups, ["p1"], "b", "p3");
    const b = next.find((x) => x.id === "b")!;
    expect(b.photoIds).toEqual(["p2", "p1", "p3"]);
    expect(b.manualOrder).toBe(true);
  });

  it("no-op moves return the SAME reference (no undo snapshot / toast)", () => {
    const groups = [g("a", ["p1", "p2"])];
    // Already in the target, appended (non-positional) → nothing changes.
    expect(movePhotosToGroup(groups, ["p1"], "a")).toBe(groups);
    // Unknown photo → nothing changes.
    expect(movePhotosToGroup(groups, ["ghost"], null)).toBe(groups);
    // Empty selection.
    expect(movePhotosToGroup(groups, [], "a")).toBe(groups);
  });

  it("a photo dropped into the group it's already in via a position is a reorder", () => {
    const groups = [g("a", ["p1", "p2", "p3"])];
    const next = movePhotosToGroup(groups, ["p3"], "a", "p1");
    expect(next[0]!.photoIds).toEqual(["p3", "p1", "p2"]);
    expect(next[0]!.manualOrder).toBe(true);
  });
});

describe("reorderWithinGroup (US-1543)", () => {
  it("moves a photo to the target position and marks manualOrder", () => {
    const groups = [g("a", ["p1", "p2", "p3"])];
    const next = reorderWithinGroup(groups, "a", "p3", "p1");
    expect(next[0]!.photoIds).toEqual(["p3", "p1", "p2"]);
    expect(next[0]!.manualOrder).toBe(true);
  });

  it("no-ops (same position, unknown ids, unknown group) return the same reference", () => {
    const groups = [g("a", ["p1", "p2"])];
    expect(reorderWithinGroup(groups, "a", "p1", "p1")).toBe(groups);
    expect(reorderWithinGroup(groups, "a", "ghost", "p1")).toBe(groups);
    expect(reorderWithinGroup(groups, "nope", "p1", "p2")).toBe(groups);
  });

  it("only the reordered group is touched", () => {
    const groups = [g("a", ["p1", "p2"]), g("b", ["p3", "p4"])];
    const next = reorderWithinGroup(groups, "a", "p2", "p1");
    expect(next.find((x) => x.id === "b")).toBe(groups[1]);
  });
});

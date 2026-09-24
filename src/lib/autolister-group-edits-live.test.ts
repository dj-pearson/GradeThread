// AL-09: async AI passes fold their answers into the LIVE groups, and a delete
// prunes the undo snapshot.
import { describe, expect, it } from "vitest";
import { mergeAutoTagResult, pruneDeletedPhotos, restoreDeletedPhotos } from "./autolister-group-edits";

type G = {
  id: string;
  name?: string;
  photoIds: string[];
  coverId: string;
  roles?: Record<string, string>;
  photoRoles?: Record<string, string>;
};

const AI = new Set(["front", "back", "tag", "detail", "defect"]);

describe("mergeAutoTagResult (AL-09)", () => {
  it("a photo moved out while auto-tag ran never becomes the cover", () => {
    // Request left with [a, b, c]; the seller moved `b` out before it answered.
    const live: G = { id: "g", photoIds: ["a", "c"], coverId: "a" };
    const merged = mergeAutoTagResult(live, { coverId: "b", roles: { a: "back", b: "front", c: "tag" } }, AI)!;
    expect(merged.coverId).toBe("a");
    expect(merged.roles).toEqual({ a: "back", c: "tag" });
  });

  it("a role the seller set by hand mid-flight survives the AI's answer", () => {
    const live: G = {
      id: "g",
      photoIds: ["a", "b"],
      coverId: "a",
      roles: { b: "internal" },
    };
    const merged = mergeAutoTagResult(live, { roles: { a: "front", b: "detail" } }, AI)!;
    expect(merged.roles).toEqual({ a: "front", b: "internal" });
  });

  it("keeps a qualified role and its qualifier", () => {
    const live: G = {
      id: "g",
      photoIds: ["a", "b"],
      coverId: "a",
      roles: { b: "tag" },
      photoRoles: { b: "size" },
    };
    const merged = mergeAutoTagResult(live, { roles: { b: "detail" } }, AI)!;
    expect(merged.roles?.b).toBe("tag");
    expect(merged.photoRoles).toEqual({ b: "size" });
  });

  it("a group deleted while the request ran is left alone", () => {
    expect(mergeAutoTagResult<G>(undefined, { coverId: "a" }, AI)).toBeNull();
  });

  it("the name the seller typed while a pass ran is not reverted", () => {
    const live: G = { id: "g", name: "Renamed", photoIds: ["a"], coverId: "a" };
    expect(mergeAutoTagResult(live, { coverId: "a" }, AI)!.name).toBe("Renamed");
  });
});

describe("pruneDeletedPhotos (AL-09)", () => {
  it("removes deleted photos, repairs the cover and drops emptied groups", () => {
    const groups: G[] = [
      { id: "g1", photoIds: ["a", "b"], coverId: "a", roles: { a: "front", b: "back" } },
      { id: "g2", photoIds: ["c"], coverId: "c" },
    ];
    const out = pruneDeletedPhotos(groups, new Set(["a", "c"]));
    expect(out).toEqual([{ id: "g1", photoIds: ["b"], coverId: "b", roles: { b: "back" }, photoRoles: undefined }]);
  });

  it("an undo snapshot pruned the same way shows no ghost photos", () => {
    const snapshot: G[] = [{ id: "g1", photoIds: ["a", "gone"], coverId: "gone" }];
    const out = pruneDeletedPhotos(snapshot, new Set(["gone"]));
    expect(out[0]!.photoIds).toEqual(["a"]);
    expect(out[0]!.coverId).toBe("a");
  });

  it("returns the same array when nothing was deleted", () => {
    const groups: G[] = [{ id: "g1", photoIds: ["a"], coverId: "a" }];
    expect(pruneDeletedPhotos(groups, new Set(["z"]))).toBe(groups);
  });
});


describe("restoreDeletedPhotos (AL-13)", () => {
  const before: G[] = [
    { id: "g1", photoIds: ["a", "b", "c"], coverId: "a", roles: { a: "front", b: "back" } },
    { id: "g2", photoIds: ["d"], coverId: "d" },
  ];
  const deleted = new Set(["a", "d"]);

  it("Undo puts every photo back where it was, cover included, and revives a dissolved group", () => {
    const live = pruneDeletedPhotos(before, deleted);
    const out = restoreDeletedPhotos(live, before, deleted);
    const g1 = out.find((g) => g.id === "g1")!;
    expect([...g1.photoIds].sort()).toEqual(["a", "b", "c"]);
    expect(g1.coverId).toBe("a");
    expect(g1.roles?.a).toBe("front");
    expect(out.find((g) => g.id === "g2")?.photoIds).toEqual(["d"]);
  });

  it("keeps an edit made after the delete", () => {
    const live = pruneDeletedPhotos(before, deleted).map((g) =>
      g.id === "g1" ? { ...g, name: "Renamed" } : g,
    );
    const out = restoreDeletedPhotos(live, before, deleted);
    expect(out.find((g) => g.id === "g1")?.name).toBe("Renamed");
  });
});

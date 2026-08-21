// The AutoLister's pre-generate checkpoint (US-1546 AC2), and the front-photo
// rule US-2769 AC3 added to it.
//
// generate() spends money per group, so a group that ships without a front is a
// paid call that identifies a garment from a fabric close-up. The check is
// cheap; not having it cost a real listing.

import { describe, expect, it } from "vitest";
import {
  buildGroupWarnings,
  groupPhotoType,
  type WarnableGroup,
} from "@/pages/flipdesk/autolister/group-warnings";

const group = (over: Partial<WarnableGroup> = {}): WarnableGroup => ({
  id: "g1",
  name: "Blue polo",
  photoIds: ["p1", "p2", "p3"],
  coverId: "p1",
  ...over,
});

const keys = (ws: { key: string }[]) => ws.map((w) => w.key);

describe("groupPhotoType", () => {
  it("makes the cover a front when nothing was retyped", () => {
    expect(groupPhotoType(group(), "p1")).toBe("front");
  });

  it("makes everything else a detail when nothing was retyped", () => {
    expect(groupPhotoType(group(), "p2")).toBe("detail");
  });

  it("lets an explicit tag win, cover or not", () => {
    const g = group({ roles: { p1: "tag", p2: "back" } });
    expect(groupPhotoType(g, "p1")).toBe("tag");
    expect(groupPhotoType(g, "p2")).toBe("back");
  });
});

describe("US-2769 AC3: a group with no front is flagged before generate()", () => {
  it("says nothing about a group whose cover is still the front", () => {
    // The common case, and the one that must stay quiet: a seller who dropped
    // photos in and touched nothing has a front by default.
    expect(keys(buildGroupWarnings([group()], {}, []))).toEqual([]);
  });

  it("flags a group whose cover was retyped away from front", () => {
    const g = group({ roles: { p1: "tag" } });
    const ws = buildGroupWarnings([g], {}, []);
    expect(keys(ws)).toEqual(["front-g1"]);
    expect(ws[0]!.label).toContain("no front photo");
    // The label names the group, because the checkpoint lists many at once.
    expect(ws[0]!.label).toContain("Blue polo");
  });

  it("stays quiet when some OTHER photo carries the front", () => {
    // Retyping the cover is legitimate as long as the front lands somewhere —
    // a rule keyed to the cover alone would nag at a correct group.
    const g = group({ roles: { p1: "tag", p3: "front" } });
    expect(keys(buildGroupWarnings([g], {}, []))).toEqual([]);
  });

  it("does not ask for a back, which almost no bulk dump tags", () => {
    // REQUIRED_PHOTO_TYPES is front + back, and warning on both would fire on
    // essentially every group and bury the warnings that mean something.
    const g = group({ roles: { p1: "front" } });
    expect(keys(buildGroupWarnings([g], {}, []))).toEqual([]);
  });
});

describe("the checkpoint's older rules still hold", () => {
  it("flags a single-photo group", () => {
    const g = group({ photoIds: ["p1"] });
    expect(keys(buildGroupWarnings([g], {}, []))).toEqual(["single-g1"]);
  });

  it("flags an oversized group as possibly two items", () => {
    const photoIds = Array.from({ length: 13 }, (_, i) => `p${i + 1}`);
    const ws = buildGroupWarnings([group({ photoIds })], {}, []);
    expect(keys(ws)).toEqual(["big-g1"]);
    expect(ws[0]!.label).toContain("13 photos");
  });

  it("flags a weak cover score", () => {
    expect(keys(buildGroupWarnings([group()], { p1: 42 }, []))).toEqual([
      "cover-g1",
    ]);
  });

  it("leaves a good cover score alone", () => {
    expect(keys(buildGroupWarnings([group()], { p1: 88 }, []))).toEqual([]);
  });

  it("carries an open AI suggestion", () => {
    const ws = buildGroupWarnings([group()], {}, [
      { id: "s1", type: "split", group_ids: ["g1"] },
    ]);
    expect(keys(ws)).toEqual(["ai-s1"]);
  });

  it("drops a suggestion whose group is gone", () => {
    const ws = buildGroupWarnings([group()], {}, [
      { id: "s1", type: "merge", group_ids: ["deleted"] },
    ]);
    expect(keys(ws)).toEqual([]);
  });
});

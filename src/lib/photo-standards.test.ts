import { describe, it, expect } from "vitest";
import {
  photoStandardsPreflight,
  firstPhotoNudge,
  PHOTO_MIN_LONGEST_PX,
  PHOTO_ZOOM_LONGEST_PX,
  type PhotoStandardsPhoto,
  type HeroNudgePhoto,
} from "./photo-standards";

// US-1896: the web mirror MUST stay in lockstep with the edge
// photoStandardsPreflight (deno-tested in publish-preflight_test.ts). These
// tests cover the blocker, the warning, and the nudge trigger.

const big = (sort: number, type: string): PhotoStandardsPhoto => ({
  photo_type: type,
  width: 2400,
  height: 3200,
  sort_order: sort,
});

describe("photoStandardsPreflight (web mirror)", () => {
  it("empty set → nothing", () => {
    const r = photoStandardsPreflight([]);
    expect(r).toEqual({ blockers: [], warnings: [], nudge: null });
  });

  it("an all-good set is clean", () => {
    const r = photoStandardsPreflight([big(0, "front"), big(1, "detail")]);
    expect(r.blockers).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
    expect(r.nudge).toBeNull();
  });

  it("a sub-500px photo is a fixable BLOCKER", () => {
    const r = photoStandardsPreflight([
      big(0, "front"),
      { photo_type: "detail", width: 480, height: 300, sort_order: 1 },
    ]);
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0]).toContain(`${PHOTO_MIN_LONGEST_PX}px`);
  });

  it("longest SIDE (not both) decides the 500px floor", () => {
    // 480 wide but 900 tall → longest side 900 ≥ 500 → NOT a blocker.
    const r = photoStandardsPreflight([
      { photo_type: "front", width: 480, height: 900, sort_order: 0 },
    ]);
    expect(r.blockers).toHaveLength(0);
  });

  it("hero under 1600px longest side is a zoom WARNING, not a blocker", () => {
    const r = photoStandardsPreflight([
      { photo_type: "front", width: 1200, height: 900, sort_order: 0 },
    ]);
    expect(r.blockers).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(`${PHOTO_ZOOM_LONGEST_PX}px`);
  });

  it("unknown dimensions fail OPEN", () => {
    const r = photoStandardsPreflight([
      { photo_type: "tag", width: null, height: null, sort_order: 0 },
    ]);
    expect(r.blockers).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
    // type-based nudge still fires (tag hero) even with unknown dims
    expect(r.nudge).not.toBeNull();
  });

  it("a tag/detail/defect hero triggers the reorder NUDGE", () => {
    const r = photoStandardsPreflight([big(0, "tag"), big(1, "front")]);
    expect(r.nudge).toContain("tag shot");
  });

  it("front/back/flatlay/on_model heroes never nudge", () => {
    for (const t of ["front", "back", "flatlay", "on_model"]) {
      expect(photoStandardsPreflight([big(0, t)]).nudge).toBeNull();
    }
  });
});

describe("firstPhotoNudge (composer live nudge + reorder)", () => {
  const p = (id: string, type: string, sort: number): HeroNudgePhoto => ({
    id,
    photo_type: type,
    sort_order: sort,
  });

  it("no nudge when the hero is already a full view", () => {
    expect(firstPhotoNudge([p("a", "front", 0), p("b", "tag", 1)])).toBeNull();
  });

  it("empty → null", () => {
    expect(firstPhotoNudge([])).toBeNull();
  });

  it("tag hero with a front elsewhere → nudge + suggests the front", () => {
    const n = firstPhotoNudge([p("tag1", "tag", 0), p("front1", "front", 1)]);
    expect(n).not.toBeNull();
    expect(n!.suggestedHeroId).toBe("front1");
    expect(n!.message).toContain("tag shot");
  });

  it("tag hero with NO full-view photo → nudge but no reorder target", () => {
    const n = firstPhotoNudge([p("tag1", "tag", 0), p("d", "detail", 1)]);
    expect(n).not.toBeNull();
    expect(n!.suggestedHeroId).toBeNull();
  });

  it("picks the LOWEST sort_order good-hero candidate", () => {
    const n = firstPhotoNudge([
      p("detail1", "detail", 0),
      p("back1", "back", 2),
      p("front1", "front", 1),
    ]);
    expect(n!.suggestedHeroId).toBe("front1");
  });

  it("hero is decided by sort_order, not array position", () => {
    const n = firstPhotoNudge([
      p("front1", "front", 5),
      p("tag1", "tag", 0),
    ]);
    expect(n).not.toBeNull();
    expect(n!.suggestedHeroId).toBe("front1");
  });
});

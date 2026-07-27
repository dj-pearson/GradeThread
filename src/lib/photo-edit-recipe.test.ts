import { describe, it, expect } from "vitest";
import {
  RECIPE_VERSION,
  buildEditRecipe,
  originalPathFor,
  parseEditRecipe,
  recipeIsNoOp,
} from "./photo-edit-recipe";
import { NEUTRAL_ADJUSTMENTS } from "./image-adjustments";

const BASE = {
  rotation: 90,
  fine: 2,
  crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  aspect: 1,
  adjustments: { ...NEUTRAL_ADJUSTMENTS, brightness: 10 },
  bgRemoved: false,
  editedAt: "2026-07-27T00:00:00.000Z",
};

describe("buildEditRecipe / parseEditRecipe round-trip", () => {
  it("survives a full round-trip through JSON", () => {
    const built = buildEditRecipe(BASE);
    const parsed = parseEditRecipe(JSON.parse(JSON.stringify(built)));
    expect(parsed).toEqual(built);
  });

  it("clamps out-of-range adjustments on build", () => {
    const built = buildEditRecipe({
      ...BASE,
      adjustments: { ...NEUTRAL_ADJUSTMENTS, brightness: 9999 },
    });
    expect(built.adjustments.brightness).toBe(100);
  });
});

describe("parseEditRecipe", () => {
  it("returns null for anything that isn't a recipe object", () => {
    expect(parseEditRecipe(null)).toBeNull();
    expect(parseEditRecipe(undefined)).toBeNull();
    expect(parseEditRecipe("{}")).toBeNull();
    expect(parseEditRecipe(42)).toBeNull();
    expect(parseEditRecipe([])).toBeNull();
    expect(parseEditRecipe({})).toBeNull();
  });

  it("rejects an unknown schema version outright", () => {
    // Guessing at a future shape could silently mis-seed a crop; the caller's
    // fallback (edit the current image) is always correct.
    expect(parseEditRecipe({ ...buildEditRecipe(BASE), v: 2 })).toBeNull();
    expect(parseEditRecipe({ ...buildEditRecipe(BASE), v: "1" })).toBeNull();
  });

  it("normalises rotation to a 0/90/180/270 step", () => {
    expect(parseEditRecipe({ ...buildEditRecipe(BASE), rotation: 450 })?.rotation).toBe(90);
    expect(parseEditRecipe({ ...buildEditRecipe(BASE), rotation: -90 })?.rotation).toBe(270);
    expect(parseEditRecipe({ ...buildEditRecipe(BASE), rotation: 47 })?.rotation).toBe(90);
  });

  it("clamps the straighten angle to the editor's range", () => {
    expect(parseEditRecipe({ ...buildEditRecipe(BASE), fine: 90 })?.fine).toBe(15);
    expect(parseEditRecipe({ ...buildEditRecipe(BASE), fine: -90 })?.fine).toBe(-15);
  });

  it("drops a crop that falls outside the frame or has no area", () => {
    const mk = (crop: unknown) =>
      parseEditRecipe({ ...buildEditRecipe(BASE), crop })?.crop;
    expect(mk({ x: -0.2, y: 0, w: 0.5, h: 0.5 })).toBeNull();
    expect(mk({ x: 0.8, y: 0, w: 0.5, h: 0.5 })).toBeNull(); // runs past the edge
    expect(mk({ x: 0, y: 0, w: 0, h: 0.5 })).toBeNull(); // zero area
    expect(mk({ x: 0, y: 0, w: "half", h: 0.5 })).toBeNull();
    expect(mk(null)).toBeNull();
    expect(mk({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("falls back to neutral for malformed adjustments rather than failing", () => {
    const parsed = parseEditRecipe({
      ...buildEditRecipe(BASE),
      adjustments: { brightness: "bright", contrast: NaN },
    });
    expect(parsed?.adjustments).toEqual(NEUTRAL_ADJUSTMENTS);
  });

  it("treats a missing adjustments block as neutral", () => {
    const parsed = parseEditRecipe({
      ...buildEditRecipe(BASE),
      adjustments: undefined,
    });
    expect(parsed?.adjustments).toEqual(NEUTRAL_ADJUSTMENTS);
  });

  it("only accepts a strictly-true bgRemoved", () => {
    const mk = (v: unknown) =>
      parseEditRecipe({ ...buildEditRecipe(BASE), bgRemoved: v })?.bgRemoved;
    expect(mk(true)).toBe(true);
    expect(mk("true")).toBe(false);
    expect(mk(1)).toBe(false);
  });

  it("rejects a non-positive aspect", () => {
    const mk = (v: unknown) =>
      parseEditRecipe({ ...buildEditRecipe(BASE), aspect: v })?.aspect;
    expect(mk(0)).toBeNull();
    expect(mk(-1)).toBeNull();
    expect(mk(1.5)).toBe(1.5);
  });

  it("keeps the version constant it was built with", () => {
    expect(buildEditRecipe(BASE).v).toBe(RECIPE_VERSION);
  });
});

describe("recipeIsNoOp", () => {
  it("treats null and an untouched recipe as no-ops", () => {
    expect(recipeIsNoOp(null)).toBe(true);
    expect(
      recipeIsNoOp(
        buildEditRecipe({
          rotation: 0,
          fine: 0,
          crop: null,
          aspect: null,
          adjustments: NEUTRAL_ADJUSTMENTS,
          bgRemoved: false,
          editedAt: "",
        }),
      ),
    ).toBe(true);
  });

  it("detects each kind of real change", () => {
    const base = {
      rotation: 0,
      fine: 0,
      crop: null,
      aspect: null,
      adjustments: NEUTRAL_ADJUSTMENTS,
      bgRemoved: false,
      editedAt: "",
    };
    expect(recipeIsNoOp(buildEditRecipe({ ...base, rotation: 90 }))).toBe(false);
    expect(recipeIsNoOp(buildEditRecipe({ ...base, fine: 3 }))).toBe(false);
    expect(
      recipeIsNoOp(
        buildEditRecipe({ ...base, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }),
      ),
    ).toBe(false);
    expect(recipeIsNoOp(buildEditRecipe({ ...base, bgRemoved: true }))).toBe(false);
    expect(
      recipeIsNoOp(
        buildEditRecipe({
          ...base,
          adjustments: { ...NEUTRAL_ADJUSTMENTS, warmth: -5 },
        }),
      ),
    ).toBe(false);
  });
});

describe("originalPathFor", () => {
  it("inserts an originals/ folder before the filename", () => {
    expect(originalPathFor("user-1/item-2/front_123.jpg")).toBe(
      "user-1/item-2/originals/front_123.jpg",
    );
  });

  it("keeps the user id as the FIRST segment", () => {
    // Storage RLS on item-photos is (storage.foldername(name))[1] = auth.uid(),
    // so anything that shifts segment 1 makes the write unauthorised.
    const out = originalPathFor("abc-user/item/photo.jpg");
    expect(out.split("/")[0]).toBe("abc-user");
  });

  it("handles a bare filename with no folder", () => {
    expect(originalPathFor("photo.jpg")).toBe("originals/photo.jpg");
  });

  it("is not idempotent by accident — callers must guard on the stored path", () => {
    // Documents the contract persistPhotoEdit relies on: it only derives this
    // path when original_storage_path is unset, never from an already-derived one.
    expect(originalPathFor("u/i/originals/p.jpg")).toBe(
      "u/i/originals/originals/p.jpg",
    );
  });
});

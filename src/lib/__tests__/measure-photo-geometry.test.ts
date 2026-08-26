import { describe, it, expect } from "vitest";
import {
  cardUprightQuarter,
  distanceToSegment,
  hitLineBody,
  invert3,
  lineWithinBounds,
  matMul3,
  quarterInverseAffine,
  quarterTurnBetween,
  recenterLine,
  rotateCalibrationQuarter,
  rotateHomographyQuarter,
  rotatePointQuarter,
  rotatedDims,
  translateLine,
  type Point,
  type Quarter,
} from "@/lib/measure-photo-geometry";
import { buildEditRecipe } from "@/lib/photo-edit-recipe";
import { NEUTRAL_ADJUSTMENTS } from "@/lib/image-adjustments";

const W = 4000;
const H = 3000;

function recipe(over: Partial<Parameters<typeof buildEditRecipe>[0]>) {
  return buildEditRecipe({
    rotation: 0,
    fine: 0,
    crop: null,
    aspect: null,
    adjustments: NEUTRAL_ADJUSTMENTS,
    bgRemoved: false,
    editedAt: "2026-08-25T00:00:00.000Z",
    ...over,
  });
}

/**
 * The canvas transform the editor actually performs, written out longhand.
 * rotatePointQuarter has to agree with THIS, not with a convention -- a sign
 * error mirrors a measurement instead of failing.
 */
function canvasRotate(p: Point, degrees: number, sw: number, sh: number): Point {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const swapped = degrees % 180 !== 0;
  const cw = swapped ? sh : sw;
  const ch = swapped ? sw : sh;
  const x = p[0] - sw / 2;
  const y = p[1] - sh / 2;
  return [x * cos - y * sin + cw / 2, x * sin + y * cos + ch / 2];
}

describe("quarter turns", () => {
  it("agrees with the editor's own canvas transform at every turn", () => {
    const samples: Point[] = [[0, 0], [W, 0], [W, H], [0, H], [137, 2411], [W / 2, H / 2]];
    for (const turns of [0, 1, 2, 3] as Quarter[]) {
      for (const p of samples) {
        const mine = rotatePointQuarter(p, turns, W, H);
        const canvas = canvasRotate(p, turns * 90, W, H);
        expect(mine[0]).toBeCloseTo(canvas[0], 6);
        expect(mine[1]).toBeCloseTo(canvas[1], 6);
      }
    }
  });

  it("swaps the dimensions on an odd turn only", () => {
    expect(rotatedDims(W, H, 0)).toEqual([W, H]);
    expect(rotatedDims(W, H, 1)).toEqual([H, W]);
    expect(rotatedDims(W, H, 2)).toEqual([W, H]);
    expect(rotatedDims(W, H, 3)).toEqual([H, W]);
  });

  it("four turns is the identity", () => {
    let p: Point = [812, 1990];
    let w = W;
    let h = H;
    for (let i = 0; i < 4; i++) {
      p = rotatePointQuarter(p, 1, w, h);
      [w, h] = rotatedDims(w, h, 1);
    }
    expect(p).toEqual([812, 1990]);
    expect([w, h]).toEqual([W, H]);
  });

  it("puts every rotated point inside the rotated frame", () => {
    for (const turns of [1, 2, 3] as Quarter[]) {
      const [rw, rh] = rotatedDims(W, H, turns);
      for (const p of [[0, 0], [W, 0], [W, H], [0, H]] as Point[]) {
        const q = rotatePointQuarter(p, turns, W, H);
        expect(q[0]).toBeGreaterThanOrEqual(0);
        expect(q[1]).toBeGreaterThanOrEqual(0);
        expect(q[0]).toBeLessThanOrEqual(rw);
        expect(q[1]).toBeLessThanOrEqual(rh);
      }
    }
  });
});

describe("the homography survives a rotation exactly", () => {
  // 100 px per inch, card origin at image (50, 60), no rotation: image px ->
  // card inches.
  const H0 = [1 / 100, 0, -0.5, 0, 1 / 100, -0.6, 0, 0, 1];

  function inches(h: number[], a: Point, b: Point): number {
    const map = (p: Point): Point => {
      const w = h[6]! * p[0] + h[7]! * p[1] + h[8]!;
      return [
        (h[0]! * p[0] + h[1]! * p[1] + h[2]!) / w,
        (h[3]! * p[0] + h[4]! * p[1] + h[5]!) / w,
      ];
    };
    const [ax, ay] = map(a);
    const [bx, by] = map(b);
    return Math.hypot(ax - bx, ay - by);
  }

  it("reads the same inches after every turn -- the point of the whole exercise", () => {
    const a: Point = [400, 900];
    const b: Point = [2400, 900];
    const before = inches(H0, a, b);
    expect(before).toBeCloseTo(20, 9);
    for (const turns of [1, 2, 3] as Quarter[]) {
      const rotated = rotateHomographyQuarter(H0, turns, W, H);
      const after = inches(
        rotated,
        rotatePointQuarter(a, turns, W, H),
        rotatePointQuarter(b, turns, W, H),
      );
      expect(after).toBeCloseTo(before, 9);
    }
  });

  it("the inverse affine really is the inverse of the point map", () => {
    for (const turns of [1, 2, 3] as Quarter[]) {
      const A = quarterInverseAffine(turns, W, H);
      const p: Point = [731, 2088];
      const q = rotatePointQuarter(p, turns, W, H);
      const back: Point = [
        A[0]! * q[0] + A[1]! * q[1] + A[2]!,
        A[3]! * q[0] + A[4]! * q[1] + A[5]!,
      ];
      expect(back[0]).toBeCloseTo(p[0], 6);
      expect(back[1]).toBeCloseTo(p[1], 6);
    }
  });

  it("carries the lines across with the homography", () => {
    const calib = {
      v: 1 as const,
      ppi: 100,
      homography: H0,
      lines: {
        chest: {
          e1: [400, 900] as Point,
          e2: [2400, 900] as Point,
          inches: 20,
          label: "Chest (in)",
        },
      },
    };
    const rotated = rotateCalibrationQuarter(calib, 1, W, H);
    expect(rotated.ppi).toBe(100);
    expect(rotated.lines.chest.label).toBe("Chest (in)");
    expect(rotated.lines.chest.e1).toEqual(rotatePointQuarter([400, 900], 1, W, H));
    // AND it now sits inside the rotated frame, which is the failure the
    // seller sees: an endpoint past the right edge with no way to grab it.
    const [rw, rh] = rotatedDims(W, H, 1);
    expect(
      lineWithinBounds(rotated.lines.chest.e1, rotated.lines.chest.e2, rw, rh),
    ).toBe(true);
  });

  it("a zero turn changes nothing", () => {
    expect(rotateHomographyQuarter(H0, 0, W, H)).toEqual(H0);
  });
});

describe("reading a pair of recipes", () => {
  it("no recipe on either side is no turn", () => {
    expect(quarterTurnBetween(null, null)).toBe(0);
  });

  it("a first rotate off an unedited photo is the turn itself", () => {
    expect(quarterTurnBetween(null, recipe({ rotation: 90 }))).toBe(1);
    expect(quarterTurnBetween(null, recipe({ rotation: 270 }))).toBe(3);
  });

  it("recipes are absolute, so the turn is the difference", () => {
    expect(
      quarterTurnBetween(recipe({ rotation: 90 }), recipe({ rotation: 180 })),
    ).toBe(1);
    expect(
      quarterTurnBetween(recipe({ rotation: 270 }), recipe({ rotation: 0 })),
    ).toBe(1);
    expect(
      quarterTurnBetween(recipe({ rotation: 90 }), recipe({ rotation: 90 })),
    ).toBe(0);
  });

  it("tone and background removal move no pixels", () => {
    const toned = recipe({
      rotation: 90,
      adjustments: { ...NEUTRAL_ADJUSTMENTS, brightness: 20 },
      bgRemoved: true,
    });
    expect(quarterTurnBetween(recipe({ rotation: 90 }), toned)).toBe(0);
  });

  it("refuses a crop or a straighten instead of guessing", () => {
    const cropped = recipe({ crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } });
    const straightened = recipe({ fine: 3 });
    expect(quarterTurnBetween(null, cropped)).toBeNull();
    expect(quarterTurnBetween(null, straightened)).toBeNull();
    expect(quarterTurnBetween(cropped, recipe({ rotation: 90 }))).toBeNull();
    expect(quarterTurnBetween(straightened, null)).toBeNull();
  });
});

describe("moving a line as one object", () => {
  const w = 1000;
  const h = 800;

  it("keeps the length and angle exactly", () => {
    const e1: Point = [100, 100];
    const e2: Point = [400, 300];
    const moved = translateLine(e1, e2, 50, -20, w, h);
    expect(moved.e1).toEqual([150, 80]);
    expect(moved.e2).toEqual([450, 280]);
    const lenBefore = Math.hypot(e2[0] - e1[0], e2[1] - e1[1]);
    const lenAfter = Math.hypot(
      moved.e2[0] - moved.e1[0],
      moved.e2[1] - moved.e1[1],
    );
    expect(lenAfter).toBeCloseTo(lenBefore, 9);
  });

  it("stops at the wall without shortening the line", () => {
    const e1: Point = [900, 400];
    const e2: Point = [980, 400];
    const moved = translateLine(e1, e2, 500, 0, w, h);
    expect(moved.e2[0]).toBe(1000);
    expect(moved.e1[0]).toBe(920);
    expect(moved.e2[0] - moved.e1[0]).toBe(80);
  });

  it("does not freeze a line longer than the frame", () => {
    const e1: Point = [-200, 400];
    const e2: Point = [1400, 400];
    const moved = translateLine(e1, e2, 30, 10, w, h);
    expect(moved.e1[0]).toBe(-170);
    expect(moved.e2[0]).toBe(1430);
  });
});

describe("getting an off-screen line back", () => {
  const w = 1000;
  const h = 800;

  it("slides a fully off-screen line into view, unchanged in length", () => {
    const e1: Point = [2600, 1500];
    const e2: Point = [2900, 1500];
    expect(lineWithinBounds(e1, e2, w, h)).toBe(false);
    const back = recenterLine(e1, e2, w, h);
    expect(lineWithinBounds(back.e1, back.e2, w, h)).toBe(true);
    expect(back.e2[0] - back.e1[0]).toBe(300);
  });

  it("shrinks only when the line cannot fit, and about its own midpoint", () => {
    const e1: Point = [-500, 400];
    const e2: Point = [2500, 400];
    const back = recenterLine(e1, e2, w, h);
    expect(lineWithinBounds(back.e1, back.e2, w, h)).toBe(true);
    expect((back.e1[0] + back.e2[0]) / 2).toBeCloseTo(500, 6);
  });

  it("leaves a line that is already inside exactly alone", () => {
    const e1: Point = [100, 100];
    const e2: Point = [400, 300];
    expect(recenterLine(e1, e2, w, h)).toEqual({ e1, e2 });
  });
});

describe("grabbing the body of a line", () => {
  const lines = [{ e1: [100, 100] as Point, e2: [500, 100] as Point }];

  it("hits the middle", () => {
    expect(hitLineBody(lines, [300, 103], 1)).toBe(0);
  });

  it("misses well away from it", () => {
    expect(hitLineBody(lines, [300, 160], 1)).toBeNull();
  });

  it("leaves the ends to the endpoints, so resize stays the easier gesture", () => {
    expect(hitLineBody(lines, [104, 100], 1)).toBeNull();
    expect(hitLineBody(lines, [496, 100], 1)).toBeNull();
  });

  it("respects the display scale", () => {
    // Same line at half size: the body now runs from 50 to 250 on screen.
    expect(hitLineBody(lines, [150, 51], 0.5)).toBe(0);
    expect(hitLineBody(lines, [300, 100], 0.5)).toBeNull();
  });

  it("measures distance to the segment, not to the infinite line", () => {
    const far = distanceToSegment([900, 100], [100, 100], [500, 100]);
    expect(far.distance).toBe(400);
    expect(far.t).toBe(1);
  });
});

describe("which way is up, according to the card", () => {
  /** image px = R(deg) * ppi * cardInches + t, inverted into a px -> inches H. */
  function homographyForCardAt(degrees: number, ppi = 100): number[] {
    const rad = (degrees * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // card -> px
    const fwd = [
      ppi * cos, -ppi * sin, 500,
      ppi * sin, ppi * cos, 400,
      0, 0, 1,
    ];
    const inv = invert3(fwd);
    if (!inv) throw new Error("singular");
    return inv;
  }

  it("says no turn when the card is already the right way up", () => {
    expect(cardUprightQuarter(homographyForCardAt(0))).toBe(0);
  });

  it("names the turn that puts the card's own left-to-right back on screen", () => {
    // Card rotated 90 clockwise in the photo: its x-axis points DOWN, so the
    // photo needs three clockwise turns to bring it back to pointing right.
    expect(cardUprightQuarter(homographyForCardAt(90))).toBe(3);
    expect(cardUprightQuarter(homographyForCardAt(180))).toBe(2);
    expect(cardUprightQuarter(homographyForCardAt(270))).toBe(1);
  });

  it("applying that turn really does leave the card upright", () => {
    for (const deg of [90, 180, 270]) {
      const h0 = homographyForCardAt(deg);
      const turns = cardUprightQuarter(h0);
      const rotated = rotateHomographyQuarter(h0, turns, W, H);
      expect(cardUprightQuarter(rotated)).toBe(0);
    }
  });

  it("tolerates a card a few degrees off square", () => {
    expect(cardUprightQuarter(homographyForCardAt(4))).toBe(0);
    expect(cardUprightQuarter(homographyForCardAt(-6))).toBe(0);
    expect(cardUprightQuarter(homographyForCardAt(86))).toBe(3);
  });

  it("offers no rotation rather than a wrong one for a broken homography", () => {
    expect(cardUprightQuarter([])).toBe(0);
    expect(cardUprightQuarter([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(0);
    expect(cardUprightQuarter([1, 2, 3, 2, 4, 6, 3, 6, 9])).toBe(0);
  });
});

describe("matrix helpers", () => {
  it("multiplies row-major", () => {
    const id = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const m = [1, 2, 3, 4, 5, 6, 7, 8, 10];
    expect(matMul3(m, id)).toEqual(m);
    expect(matMul3(id, m)).toEqual(m);
  });

  it("inverts, and refuses a singular matrix", () => {
    const m = [1, 2, 3, 4, 5, 6, 7, 8, 10];
    const inv = invert3(m);
    expect(inv).not.toBeNull();
    const back = matMul3(m, inv!);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((want, i) => {
      expect(back[i]!).toBeCloseTo(want, 9);
    });
    expect(invert3([1, 2, 3, 2, 4, 6, 3, 6, 9])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  MEASUREMENT_HOWTO,
  MENS_TO_WOMENS_SHOE_OFFSET,
  MENS_TO_WOMENS_TOP,
  MENS_TOP_SIZES,
  SHOE_SIZES,
  WOMENS_SIZES,
  convertLength,
  findShoeSize,
  findWomensSize,
  flatToWorn,
  mensChestInchesToEu,
  mensToWomensShoe,
  womensToMensShoe,
} from "@/lib/size-conversion";
import { MEASUREMENT_SPECS, isCircumferenceMeasurement } from "@/lib/measurements";

describe("length conversion", () => {
  it("uses the exact inch", () => {
    expect(convertLength(1, "in", "cm")).toBe(2.54);
    expect(convertLength(10, "in", "cm")).toBe(25.4);
    expect(convertLength(2.54, "cm", "in")).toBe(1);
  });

  it("is identity within a unit", () => {
    expect(convertLength(21, "in", "in")).toBe(21);
    expect(convertLength(53.34, "cm", "cm")).toBe(53.34);
  });

  it("round-trips without drifting", () => {
    for (const v of [1, 7.5, 21, 33.25, 46]) {
      expect(convertLength(convertLength(v, "in", "cm"), "cm", "in")).toBeCloseTo(v, 1);
    }
  });

  it("returns NaN rather than a wrong number on bad input", () => {
    expect(convertLength(Number.NaN, "in", "cm")).toBeNaN();
    expect(convertLength(Number.POSITIVE_INFINITY, "in", "cm")).toBeNaN();
  });
});

describe("flat to worn", () => {
  it("doubles a circumference measurement", () => {
    // The 21 inch pit to pit that fits a 42 inch chest — the misreading the
    // whole page exists to fix.
    expect(flatToWorn("chest", 21)).toBe(42);
    expect(flatToWorn("waist", 16)).toBe(32);
    expect(flatToWorn("hip", 19.5)).toBe(39);
  });

  it("leaves a straight length alone", () => {
    expect(flatToWorn("length", 28)).toBe(28);
    expect(flatToWorn("inseam", 32)).toBe(32);
    expect(flatToWorn("sleeve", 24.5)).toBe(24.5);
  });

  it("agrees with the shared circumference set rather than its own list", () => {
    for (const m of MEASUREMENT_HOWTO) {
      const doubled = flatToWorn(m.key, 10) === 20;
      expect(doubled, `${m.key}`).toBe(isCircumferenceMeasurement(m.key));
    }
  });
});

describe("measurement how-to", () => {
  it("only covers keys MeasureCard actually collects", () => {
    for (const m of MEASUREMENT_HOWTO) {
      expect(MEASUREMENT_SPECS[m.key], `${m.key} is not a real measurement key`).toBeDefined();
    }
  });

  it("takes its labels from the shared spec so the two cannot disagree", () => {
    for (const m of MEASUREMENT_HOWTO) {
      expect(m.label).toBe(MEASUREMENT_SPECS[m.key]?.label);
    }
  });

  it("gives every measurement a how and a pitfall", () => {
    for (const m of MEASUREMENT_HOWTO) {
      expect(m.how.length, m.key).toBeGreaterThan(20);
      expect(m.pitfall.length, m.key).toBeGreaterThan(20);
    }
  });

  it("covers every circumference key, since those are the ones misread", () => {
    const covered = new Set(MEASUREMENT_HOWTO.map((m) => m.key));
    for (const key of ["chest", "waist", "hip", "leg_opening"]) {
      expect(covered.has(key), `${key} has no how-to`).toBe(true);
    }
  });
});

describe("size tables", () => {
  it("keeps the women's table monotonic across every system", () => {
    const nums = (k: "us" | "uk" | "eu" | "jp") => WOMENS_SIZES.map((s) => Number(s[k]));
    for (const k of ["us", "uk", "eu", "jp"] as const) {
      const v = nums(k);
      for (let i = 1; i < v.length; i++) {
        expect(Number(v[i]), `${k} row ${i}`).toBeGreaterThan(Number(v[i - 1]));
      }
    }
  });

  it("holds the UK offset of 4 that runs through women's sizing", () => {
    for (const s of WOMENS_SIZES) {
      expect(Number(s.uk) - Number(s.us)).toBe(4);
    }
  });

  it("holds the EU offset of 32 that runs through women's sizing", () => {
    for (const s of WOMENS_SIZES) {
      expect(Number(s.eu) - Number(s.us)).toBe(32);
    }
  });

  it("keeps the shoe table monotonic and 1.5 apart across the US scales", () => {
    for (const s of SHOE_SIZES) {
      expect(Number(s.usWomen) - Number(s.usMen)).toBe(MENS_TO_WOMENS_SHOE_OFFSET);
    }
    const eu = SHOE_SIZES.map((s) => Number(s.eu));
    for (let i = 1; i < eu.length; i++) {
      expect(Number(eu[i])).toBeGreaterThan(Number(eu[i - 1]));
    }
  });

  it("has no duplicate rows in any table", () => {
    expect(new Set(WOMENS_SIZES.map((s) => s.us)).size).toBe(WOMENS_SIZES.length);
    expect(new Set(SHOE_SIZES.map((s) => s.usMen)).size).toBe(SHOE_SIZES.length);
    expect(new Set(MENS_TOP_SIZES.map((s) => s.alpha)).size).toBe(MENS_TOP_SIZES.length);
    expect(new Set(MENS_TO_WOMENS_TOP.map((s) => s.mens)).size).toBe(MENS_TO_WOMENS_TOP.length);
  });
});

describe("shoe conversion", () => {
  it("puts a men's 8 and a women's 9.5 on the same shoe", () => {
    expect(mensToWomensShoe(8)).toBe(9.5);
    expect(womensToMensShoe(9.5)).toBe(8);
  });

  it("round-trips", () => {
    for (const v of [5, 8, 10.5, 13]) {
      expect(womensToMensShoe(mensToWomensShoe(v))).toBe(v);
    }
  });

  it("matches what the published table says, row for row", () => {
    for (const s of SHOE_SIZES) {
      expect(mensToWomensShoe(Number(s.usMen))).toBe(Number(s.usWomen));
    }
  });
});

describe("men's EU derivation", () => {
  it("derives EU jacket sizing from the chest in centimetres, halved", () => {
    // 39 inch chest -> 99.06 cm -> EU 50, which is what the table says for M.
    expect(mensChestInchesToEu(39)).toBe(50);
    expect(mensChestInchesToEu(36)).toBe(46);
    expect(mensChestInchesToEu(42)).toBe(53);
  });

  it("lands within a size of the published table for every row", () => {
    for (const row of MENS_TOP_SIZES) {
      const mid =
        row.chestIn.split("-").map(Number).reduce((a, b) => a + b, 0) /
        row.chestIn.split("-").length;
      expect(Math.abs(mensChestInchesToEu(mid) - Number(row.eu)), row.alpha).toBeLessThanOrEqual(2);
    }
  });
});

describe("lookup", () => {
  it("finds a women's row by any system", () => {
    expect(findWomensSize("us", "8")?.eu).toBe("40");
    expect(findWomensSize("uk", "12")?.us).toBe("8");
    expect(findWomensSize("eu", "40")?.uk).toBe("12");
    expect(findWomensSize("jp", "13")?.us).toBe("8");
  });

  it("finds a shoe row by any system", () => {
    expect(findShoeSize("usMen", "8")?.eu).toBe("41");
    expect(findShoeSize("uk", "7.5")?.usWomen).toBe("9.5");
  });

  it("is forgiving about whitespace and case", () => {
    expect(findWomensSize("alpha", " m ")?.us).toBe("8");
  });

  it("returns undefined rather than a wrong row", () => {
    expect(findWomensSize("us", "99")).toBeUndefined();
    expect(findShoeSize("usMen", "not a size")).toBeUndefined();
  });
});

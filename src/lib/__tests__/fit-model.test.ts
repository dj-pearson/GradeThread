// US-1778: deterministic fit engine.
import { describe, expect, it } from "vitest";
import { predictFit, fitVerdictLabel } from "@/lib/fit-model";

describe("predictFit — top chest (flat×2 circumference)", () => {
  const body = { chest: 34, shoulder: 18, sleeve: 24 };

  it("doubles the flat chest and grades ease into a true fit", () => {
    // garment chest 19 flat → 38 circumference, body 34 → ease 4 → true
    const r = predictFit("top", { chest: 19, shoulder: 18, sleeve: 24 }, body);
    expect(r.status).toBe("ok");
    const chest = r.dimensions.find((d) => d.dimension === "chest")!;
    expect(chest.garmentValue).toBe(38);
    expect(chest.ease).toBe(4);
    expect(chest.verdict).toBe("true");
  });

  it("negative ease is too_small; large ease is too_big", () => {
    expect(predictFit("top", { chest: 16 }, { chest: 34 }).verdict).toBe("too_small"); // 32 vs 34
    expect(predictFit("top", { chest: 18 }, { chest: 34 }).verdict).toBe("slim"); // 36 vs 34, ease 2
    expect(predictFit("top", { chest: 23 }, { chest: 34 }).verdict).toBe("too_big"); // 46 vs 34, ease 12
  });
});

describe("predictFit — bottoms (tight waist bands + inseam length)", () => {
  it("waist true within a close band", () => {
    const r = predictFit("bottom", { waist: 16, inseam: 32 }, { waist: 31, inseam: 31 });
    const waist = r.dimensions.find((d) => d.dimension === "waist")!;
    expect(waist.garmentValue).toBe(32); // 16 flat × 2
    expect(waist.ease).toBe(1);
    expect(waist.verdict).toBe("true");
  });

  it("inseam compares as a length (no doubling): short vs long", () => {
    const short = predictFit("bottom", { waist: 16, inseam: 29 }, { waist: 31, inseam: 32 });
    expect(short.dimensions.find((d) => d.dimension === "inseam")!.verdict).toBe("too_small"); // delta -3
    const long = predictFit("bottom", { waist: 16, inseam: 35 }, { waist: 31, inseam: 30 });
    expect(long.dimensions.find((d) => d.dimension === "inseam")!.verdict).toBe("too_big"); // delta +5
  });
});

describe("predictFit — overall follows the limiting (worst) dimension", () => {
  it("a good chest but a too-small sleeve → overall too_small, limiting=sleeve", () => {
    const r = predictFit(
      "top",
      { chest: 19, shoulder: 18, sleeve: 20 }, // sleeve way short
      { chest: 34, shoulder: 18, sleeve: 25 },
    );
    expect(r.verdict).toBe("too_small");
    expect(r.limitingDimension).toBe("sleeve");
    expect(r.sizeRecommendation).toMatch(/size up/i);
  });

  it("confidence grows with dimensions compared, capped at 0.9", () => {
    const one = predictFit("top", { chest: 19 }, { chest: 34 });
    expect(one.dimensions.length).toBe(1);
    expect(one.confidence).toBe(0.6);
    const three = predictFit(
      "top",
      { chest: 19, shoulder: 18, sleeve: 24 },
      { chest: 34, shoulder: 18, sleeve: 24 },
    );
    expect(three.dimensions.length).toBe(3);
    expect(three.confidence).toBe(0.9);
  });
});

describe("predictFit — insufficient path (US-1778 AC3)", () => {
  it("no shared dimensions → insufficient", () => {
    const r = predictFit("top", { length: 28 }, { waist: 30 }); // no comparable keys
    expect(r.status).toBe("insufficient");
    expect(r.verdict).toBeNull();
    expect(r.dimensions).toEqual([]);
    expect(r.reason).toBeTruthy();
  });

  it("non-apparel groups are insufficient with a clear reason", () => {
    const r = predictFit("shoes", { size_us: 10 }, { chest: 40 });
    expect(r.status).toBe("insufficient");
    expect(r.reason).toMatch(/isn't available/i);
  });

  it("dress uses bust as chest", () => {
    const r = predictFit("dress", { bust: 18, waist: 15, hip: 19 }, { chest: 34, waist: 28, hips: 36 });
    expect(r.dimensions.find((d) => d.dimension === "chest")!.garmentValue).toBe(36); // bust 18 × 2
  });
});

describe("fitVerdictLabel", () => {
  it("labels every verdict", () => {
    expect(fitVerdictLabel("too_small")).toBe("Too small");
    expect(fitVerdictLabel("true")).toBe("True to size");
    expect(fitVerdictLabel("too_big")).toBe("Too big");
  });
});

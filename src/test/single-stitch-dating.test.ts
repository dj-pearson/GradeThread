import { describe, expect, it } from "vitest";
import {
  SINGLE_STITCH_TYPICAL_LATEST,
  TAGLESS_EARLIEST,
  dateVintageTee,
  isPlausiblePrintedYear,
  type DatingInput,
} from "@/lib/single-stitch-dating";
import { getCalculatorBySlug } from "@/lib/seo/calculators";
import { KEYWORD_TARGETS } from "@/lib/seo/keyword-targets";

const BLANK: DatingInput = {
  singleStitch: "unsure",
  printedYear: null,
  madeInUsa: "unsure",
  blendedFabric: "unsure",
  taglessLabel: "unsure",
};

describe("isPlausiblePrintedYear", () => {
  it("accepts a year a t-shirt could carry", () => {
    expect(isPlausiblePrintedYear(1991)).toBe(true);
    expect(isPlausiblePrintedYear(2024)).toBe(true);
  });

  it("rejects the shapes a text input actually produces", () => {
    expect(isPlausiblePrintedYear(91)).toBe(false);
    expect(isPlausiblePrintedYear(19911)).toBe(false);
    expect(isPlausiblePrintedYear(1991.5)).toBe(false);
    expect(isPlausiblePrintedYear(Number.NaN)).toBe(false);
  });
});

describe("dateVintageTee", () => {
  it("says nothing when it knows nothing", () => {
    const r = dateVintageTee(BLANK);
    expect(r.confidence).toBe("insufficient");
    expect(r.earliest).toBeNull();
    expect(r.latest).toBeNull();
  });

  it("treats a printed year as a hard floor, not a date", () => {
    const r = dateVintageTee({ ...BLANK, printedYear: 1991 });
    expect(r.earliest).toBe(1991);
    // A ceiling would be wrong: old copyright lines get reprinted.
    expect(r.latest).toBeNull();
    expect(r.signals.some((s) => s.kind === "floor")).toBe(true);
  });

  it("treats single stitch as a soft ceiling, not a floor", () => {
    const r = dateVintageTee({ ...BLANK, singleStitch: "yes" });
    expect(r.latest).toBe(SINGLE_STITCH_TYPICAL_LATEST);
    expect(r.earliest).toBeNull();
    expect(r.signals.every((s) => s.kind !== "floor")).toBe(true);
  });

  it("narrows when a floor and a hint agree", () => {
    const r = dateVintageTee({ ...BLANK, printedYear: 1988, singleStitch: "yes" });
    expect(r.confidence).toBe("narrow");
    expect(r.earliest).toBe(1988);
    expect(r.latest).toBe(SINGLE_STITCH_TYPICAL_LATEST);
  });

  it("calls out a tagless blank with a single stitch hem", () => {
    // The finding the whole page exists for: these two cannot both be honest.
    const r = dateVintageTee({ ...BLANK, singleStitch: "yes", taglessLabel: "yes" });
    expect(r.confidence).toBe("conflicting");
    expect(r.signals.some((s) => s.kind === "conflict")).toBe(true);
  });

  it("calls out artwork newer than the construction", () => {
    const r = dateVintageTee({ ...BLANK, singleStitch: "yes", printedYear: 2015 });
    expect(r.confidence).toBe("conflicting");
  });

  it("prints no range alongside a conflict", () => {
    // A number next to "these disagree" is the half people remember.
    const r = dateVintageTee({ ...BLANK, singleStitch: "yes", taglessLabel: "yes" });
    expect(r.latest).toBeNull();
  });

  it("takes a tagless label as a floor on its own", () => {
    const r = dateVintageTee({ ...BLANK, taglessLabel: "yes" });
    expect(r.earliest).toBe(TAGLESS_EARLIEST);
    expect(r.confidence).toBe("indicative");
  });

  it("keeps the later floor when two floors disagree", () => {
    const r = dateVintageTee({ ...BLANK, printedYear: 1985, taglessLabel: "yes" });
    expect(r.earliest).toBe(TAGLESS_EARLIEST);
  });

  it("ignores an implausible printed year rather than dating from it", () => {
    const r = dateVintageTee({ ...BLANK, printedYear: 91 });
    expect(r.earliest).toBeNull();
    expect(r.confidence).toBe("insufficient");
  });

  it("does not treat unsure as no", () => {
    const unsure = dateVintageTee({ ...BLANK, singleStitch: "unsure" });
    const no = dateVintageTee({ ...BLANK, singleStitch: "no" });
    expect(unsure.signals).toHaveLength(0);
    expect(no.signals.length).toBeGreaterThan(0);
  });

  it("gives every signal a reason, not just a label", () => {
    const r = dateVintageTee({
      singleStitch: "yes",
      printedYear: 1989,
      madeInUsa: "yes",
      blendedFabric: "yes",
      taglessLabel: "no",
    });
    expect(r.signals.length).toBeGreaterThanOrEqual(4);
    for (const s of r.signals) expect(s.detail.length).toBeGreaterThan(40);
  });

  it("is deterministic", () => {
    const input = { ...BLANK, singleStitch: "yes" as const, printedYear: 1990 };
    expect(dateVintageTee(input)).toEqual(dateVintageTee(input));
  });
});

describe("the page is registered", () => {
  it("is live with content and a handoff", () => {
    const calc = getCalculatorBySlug("single-stitch-dating");
    expect(calc).toBeDefined();
    expect(calc!.status).toBe("live");
    expect(calc!.intro).toBeTruthy();
    expect(calc!.faqs?.length).toBeGreaterThanOrEqual(4);
    expect(calc!.handoff).toBeDefined();
  });

  it("owns the head keyword", () => {
    const target = KEYWORD_TARGETS.find((t) => t.path === "/tools/single-stitch-dating");
    expect(target?.primary).toBe("single stitch shirt");
    const calc = getCalculatorBySlug("single-stitch-dating")!;
    expect(`${calc.title} ${calc.description}`.toLowerCase()).toContain("single stitch shirt");
  });

  it("never states a single year as the cutoff", () => {
    // The story's whole point. Copy that says "pre-1994" full stop is the
    // thing every competing page does and the thing that is not true.
    const calc = getCalculatorBySlug("single-stitch-dating")!;
    const copy = [calc.title, calc.description, calc.intro, calc.h1, calc.cardBlurb]
      .concat((calc.faqs ?? []).flatMap((f) => [f.q, f.a]))
      .join(" ");
    expect(copy).toMatch(/not on its own|does not do is prove|more confident than the evidence/i);
  });
});

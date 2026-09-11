// US-3339: a grade range on the certificate and seller report, only from a
// measured regrade spread for the category.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { gradeRangeFor } from "@/lib/grade-range";
import { GradeRangeNoteView } from "@/components/grading/grade-range-note";

const RANGES = { jeans: { half_width: 0.3, samples: 14 } };

describe("gradeRangeFor", () => {
  it("puts the measured half-width either side of the score", () => {
    expect(gradeRangeFor(7.6, "jeans", RANGES)).toEqual({ low: 7.3, high: 7.9, text: "likely 7.3 to 7.9", samples: 14 });
  });

  it("never runs past the scale", () => {
    expect(gradeRangeFor(9.9, "jeans", RANGES)?.high).toBe(10);
    expect(gradeRangeFor(1.1, "jeans", RANGES)?.low).toBe(1);
  });

  it("no measured spread for the category, or no data at all: no range", () => {
    expect(gradeRangeFor(7.6, "sweater", RANGES)).toBeNull();
    expect(gradeRangeFor(7.6, "jeans", null)).toBeNull();
    expect(gradeRangeFor(7.6, "jeans", { jeans: { half_width: 0, samples: 40 } })).toBeNull();
    expect(gradeRangeFor(Number.NaN, "jeans", RANGES)).toBeNull();
  });

  it("takes no confidence at all: the signature is score, category, measured ranges", () => {
    expect(gradeRangeFor.length).toBe(3);
  });
});

describe("GradeRangeNoteView", () => {
  it("shows the range and how it was measured", () => {
    const html = renderToStaticMarkup(createElement(GradeRangeNoteView, { score: 7.6, category: "jeans", ranges: RANGES }));
    expect(html).toContain("Likely 7.3 to 7.9");
    expect(html).toContain("measured on 14 regraded jeans items");
  });

  it("renders nothing when the category has no measured range", () => {
    expect(renderToStaticMarkup(createElement(GradeRangeNoteView, { score: 7.6, category: "t-shirt", ranges: RANGES }))).toBe("");
  });
});

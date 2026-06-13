import { describe, it, expect } from "vitest";
import {
  conditionDatasetLd,
  conditionFaqs,
  fmtGrade,
  gradeTier,
  GRADING_FACTOR_LINKS,
  publishedGradeRows,
  renderExampleCertificates,
  renderGradingFactors,
  renderMethodology,
  renderPerGradeSummary,
  type ConditionCurveLite,
} from "../../functions/_shared/condition-index-render";
import { escape, faqPageJsonLd, formatDate } from "../../functions/_shared/blog-render";

// US-847: GEO enrichment for the public Condition Index detail page. These pure
// helpers power the per-grade value summary, the FAQPage + Dataset JSON-LD, the
// glossary/factor internal links, and the example-certificate links. The page is
// edge-SSR'd by functions/condition-index/[[path]].ts; testing the helpers here
// is the SSR↔structured-data guard (AC5) — same pattern as blog-geo.test.ts.

const CURVE: ConditionCurveLite = {
  slug: "patagonia-better-sweater",
  label: "Patagonia Better Sweater",
  brand: "Patagonia",
  currency: "USD",
  totalSampleSize: 42,
  refreshedAt: "2026-06-01T00:00:00.000Z",
  points: [
    { grade: 9, lowCents: 9000, medianCents: 11000, highCents: 13000, sampleSize: 6 },
    { grade: 8, lowCents: 7000, medianCents: 8500, highCents: 10000, sampleSize: 20 },
    { grade: 6, lowCents: 4000, medianCents: 5000, highCents: 6000, sampleSize: 16 },
    // A thin grade that survived to the DTO with NO median must never render a number.
    { grade: 4, lowCents: null, medianCents: null, highCents: null, sampleSize: 0 },
  ],
};

describe("gradeTier (US-847)", () => {
  it("maps grades to the canonical condition tier + glossary spoke", () => {
    expect(gradeTier(10)).toEqual({ label: "NWT", path: "/grading/nwt" });
    expect(gradeTier(9.5)).toEqual({ label: "NWOT", path: "/grading/nwot" });
    expect(gradeTier(8)).toEqual({ label: "Excellent", path: "/grading/excellent" });
    expect(gradeTier(7)).toEqual({ label: "Very Good", path: "/grading/very-good" });
    expect(gradeTier(6)).toEqual({ label: "Good", path: "/grading/good" });
    expect(gradeTier(5)).toEqual({ label: "Fair", path: "/grading/fair" });
    expect(gradeTier(3)).toEqual({ label: "Poor", path: "/grading/poor" });
  });
});

describe("fmtGrade (US-847)", () => {
  it("drops the trailing .0 but keeps half steps", () => {
    expect(fmtGrade(8)).toBe("8");
    expect(fmtGrade(9.5)).toBe("9.5");
  });
});

describe("publishedGradeRows (US-847)", () => {
  it("drops grades without a median and sorts high → low", () => {
    const rows = publishedGradeRows(CURVE);
    expect(rows.map((r) => r.grade)).toEqual([9, 8, 6]); // grade 4 dropped (no median)
  });
});

describe("renderPerGradeSummary (US-847)", () => {
  const html = renderPerGradeSummary(CURVE);
  it("renders a plain-language line per published grade with tier links", () => {
    expect(html).toContain("Value at each condition grade");
    expect(html).toContain('href="/grading/excellent"');
    expect(html).toContain("$85"); // median of grade 8 (8500 cents)
    expect(html).toContain("20 comps");
  });
  it("never emits a row for a suppressed/median-less grade", () => {
    expect(html).not.toContain("Grade 4");
    // The dollars() helper renders an em-dash placeholder ONLY for a null amount;
    // a published row always carries a real number, so none should appear.
    expect(html).not.toContain(">—<");
  });
  it("returns empty string when no grade has a median", () => {
    expect(
      renderPerGradeSummary({ ...CURVE, points: [{ grade: 4, lowCents: null, medianCents: null, highCents: null, sampleSize: 0 }] }),
    ).toBe("");
  });
});

describe("renderMethodology (US-847)", () => {
  it("states comp count + refreshed date + the no-fabrication guarantee", () => {
    const html = renderMethodology(CURVE);
    expect(html).toContain("42");
    expect(html).toContain(formatDate(CURVE.refreshedAt)); // locale/TZ-agnostic
    expect(html).toContain("omitted rather than estimated");
  });
});

describe("renderGradingFactors (US-847)", () => {
  it("links all five grading-factor glossary spokes", () => {
    const html = renderGradingFactors();
    for (const f of GRADING_FACTOR_LINKS) {
      expect(html).toContain(`href="${f.path}"`);
      expect(html).toContain(escape(f.label)); // "Odor & Cleanliness" → "Odor &amp; Cleanliness"
    }
  });
});

describe("renderExampleCertificates (US-847)", () => {
  it("links example certs when present", () => {
    const html = renderExampleCertificates({
      ...CURVE,
      examples: [
        { certificateId: "abc-123", title: "Patagonia Better Sweater Fleece", overallScore: 8, gradeTier: "Excellent" },
      ],
    });
    expect(html).toContain('href="/cert/abc-123"');
    expect(html).toContain("8.0/10");
  });
  it("degrades to empty string when there are no examples", () => {
    expect(renderExampleCertificates(CURVE)).toBe("");
    expect(renderExampleCertificates({ ...CURVE, examples: [] })).toBe("");
  });
});

describe("conditionFaqs + FAQPage JSON-LD (US-847)", () => {
  const faqs = conditionFaqs(CURVE);
  it("asks one question per published grade anchor with the median answer", () => {
    expect(faqs).toHaveLength(3);
    expect(faqs[0]!.q).toBe("What is a grade-9 (NWOT) Patagonia Better Sweater worth?");
    expect(faqs[1]!.a).toContain("$85");
    expect(faqs[1]!.a).toContain("20 condition-matched resale comps");
  });
  it("produces valid FAQPage JSON-LD", () => {
    const ld = faqPageJsonLd(faqs) as Record<string, unknown>;
    expect(ld["@type"]).toBe("FAQPage");
    expect((ld.mainEntity as unknown[]).length).toBe(3);
  });
});

describe("conditionDatasetLd (US-847)", () => {
  const ld = conditionDatasetLd(CURVE, "https://gradethread.com/condition-index/patagonia-better-sweater", "https://gradethread.com");
  it("is a Dataset with variableMeasured, measurementTechnique, and dateModified", () => {
    expect(ld["@type"]).toBe("Dataset");
    expect(ld.dateModified).toBe("2026-06-01T00:00:00.000Z");
    expect(ld.measurementTechnique).toContain("condition-matched");
    expect(Array.isArray(ld.variableMeasured)).toBe(true);
    expect((ld.variableMeasured as unknown[]).length).toBe(2);
    expect(ld.url).toContain("/condition-index/patagonia-better-sweater");
  });
});

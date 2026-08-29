import { describe, expect, it } from "vitest";
import { FLAW_ENTRIES, getFlawBySlug } from "@/lib/seo/flaw-library";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";

// US-9019. /care/pilling is the head of the largest cluster either keyword pull
// has produced: 447 keywords, 152,400 searches a month. It sat at position 72
// with 203 impressions and zero clicks over the 94 days to 2026-08-26, on 665
// words with no images.
//
// THE DEPTH TARGET IS MEASURED, NOT ASSUMED. The story asked for 1,800 words.
// The SERP was measured in a browser on 2026-08-28 instead, and the reachable
// results are shorter than that: Patagonia 1,351 words / 6 images, Vogue 1,211
// / 10, Gentleman's Gazette 1,022 / 10. What two of the three have that the old
// page did not is a RANKED METHOD COMPARISON, so the structure mattered more
// than the count and the assertions below are about structure.

const pilling = getFlawBySlug("pilling")!;

function wordsIn(strings: string[]): number {
  return strings.join(" ").trim().split(/\s+/).length;
}

describe("the pilling entry has the depth to compete", () => {
  it("exists and is registered as a public route", () => {
    expect(pilling).toBeDefined();
    expect(PUBLIC_ROUTES.some((r) => r.path === "/care/pilling")).toBe(true);
  });

  it("carries enough prose to sit in a field of 1,000 to 1,350 word guides", () => {
    const prose = [
      pilling.definition,
      pilling.gradeImpact,
      pilling.fixability,
      pilling.disclosure,
      pilling.prevention,
      ...pilling.removal,
      ...pilling.howToDetect,
      ...(pilling.methods ?? []).flatMap((m) => [m.works, m.risk]),
      ...(pilling.severity ?? []).flatMap((s) => [s.looksLike, s.grade, s.action]),
      ...pilling.faqs.flatMap((f) => [f.q, f.a]),
    ];
    expect(wordsIn(prose)).toBeGreaterThan(1200);
  });

  it("ranks the methods, which is the structure two of the three top results use", () => {
    expect(pilling.methods?.length).toBeGreaterThanOrEqual(5);
  });

  it("gives every method a risk, including the ones that cannot damage anything", () => {
    // The useful thing to say about the disposable-razor trick every article
    // lists is what it costs when it goes wrong. A blank risk field is the
    // failure mode this catches.
    for (const m of pilling.methods ?? []) {
      expect(m.risk.trim().length, m.name).toBeGreaterThan(30);
      expect(m.works.trim().length, m.name).toBeGreaterThan(20);
      expect(m.cost.trim().length, m.name).toBeGreaterThan(0);
    }
  });

  it("names at least one method to avoid, so the table settles an argument", () => {
    const verdicts = (pilling.methods ?? []).map((m) => m.verdict);
    expect(verdicts).toContain("best");
    expect(verdicts).toContain("avoid");
  });

  it("covers the tools the cluster's long tail asks about", () => {
    const names = (pilling.methods ?? []).map((m) => m.name.toLowerCase()).join(" ");
    // "how to use a sweater comb" and "how to use fabric shaver" are their own
    // keywords in the 2026-08-28 pull and are served on this URL.
    for (const tool of ["shaver", "comb", "razor", "pumice"]) {
      expect(names, tool).toContain(tool);
    }
  });

  it("carries a severity scale tied to the grade, which no laundry blog can write", () => {
    expect(pilling.severity?.length).toBeGreaterThanOrEqual(4);
    for (const band of pilling.severity ?? []) {
      expect(band.grade, band.label).toMatch(/\d/);
      expect(band.action.trim().length, band.label).toBeGreaterThan(20);
    }
  });

  it("says plainly that the heaviest band does not come back", () => {
    // A care page that implies every flaw is fixable is the thing US-9012 moved
    // this family away from.
    // Indexed rather than .at(-1): the test tsconfig's lib predates ES2022.
    const bands = pilling.severity ?? [];
    const heavy = bands[bands.length - 1];
    expect(heavy?.action).toMatch(/not recover|already gone|disclose/i);
  });

  it("answers more than one question", () => {
    expect(pilling.faqs.length).toBeGreaterThanOrEqual(5);
    for (const f of pilling.faqs) expect(f.a.split(/\s+/).length, f.q).toBeGreaterThan(35);
  });

  it("still points the reader at fabric thinning, which is what is underneath", () => {
    expect(pilling.relatedSlugs).toContain("fabric-thinning");
    expect(pilling.removal.join(" ")).toMatch(/thin/i);
  });
});

describe("the cluster is not expanded, only deepened", () => {
  it("keeps the /care/pilling children at two", () => {
    // US-9019 AC6 and the US-9024 gate. /care is 46 URLs at weighted position
    // 42.4 earning 0.6 clicks a month; adding to it at that position multiplies
    // the problem. The 447 long-tail variants are served by these three URLs
    // until the head page proves it can reach page two.
    const children = PUBLIC_ROUTES.filter((r) => /^\/care\/pilling\/[^/]+$/.test(r.path));
    expect(children.map((c) => c.path).sort()).toEqual([
      "/care/pilling/synthetic",
      "/care/pilling/wool",
    ]);
  });

  it("adds no new pilling entry to the flaw library", () => {
    const pillingEntries = FLAW_ENTRIES.filter((f) => /pill/i.test(f.slug));
    expect(pillingEntries.map((f) => f.slug)).toEqual(["pilling"]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  readCharts,
  auditFallbacks,
  categoryMatches,
  claimedFamilies,
  ASKED,
  REACHABLE,
  MAX_CHARTS,
} from "./audit-chart-category-gaps.mjs";

// US-3405. The audit's value is that it reproduces, across all 171 brands, the
// two cases the story found by eye. If it ever stops reproducing those, it has
// stopped being an audit and become a script that prints numbers.

describe("size-chart category fallback audit (US-3405)", () => {
  const charts = readCharts();
  const { fallbacks } = auditFallbacks(charts);
  const forBrand = (re) => fallbacks.filter((f) => re.test(f.brand));

  it("parses a real corpus, so a clean result cannot be vacuous", () => {
    // A parse that returns [] scores nothing and reports zero problems, which
    // reads exactly like a corpus with none.
    expect(charts.length).toBeGreaterThan(300);
    expect(charts.every((c) => c.categoryMatch.length > 0)).toBe(true);
  });

  it("reproduces the Arc'teryx case the story found by eye", () => {
    // "Arc'teryx's tops charts do not list `shirt` in category_match at all."
    const arc = charts.filter((c) => /arc.?teryx/i.test(c.brand) && /top/i.test(c.garment));
    expect(arc.length).toBeGreaterThan(0);
    expect(arc.every((c) => !categoryMatches(c.categoryMatch, "shirt"))).toBe(true);
    expect(forBrand(/arc.?teryx/i).map((f) => f.word)).toContain("shirt");
  });

  it("reproduces the Vuori case the story found by eye", () => {
    // "Vuori's bottoms do not list `jean`."
    const vuori = charts.filter((c) => /^vuori$/i.test(c.brand) && /bottom/i.test(c.garment));
    expect(vuori.length).toBeGreaterThan(0);
    expect(vuori.every((c) => !categoryMatches(c.categoryMatch, "jean"))).toBe(true);
    expect(forBrand(/^vuori$/i).map((f) => f.word)).toContain("jean");
  });

  it("scores the slots the model reads, not just the head of the pool", () => {
    // Counting only the first chart missed Arc'teryx entirely: its head IS a
    // tops chart, and two of its three slots are still bottoms. That undercount
    // is why this is scored over MAX_CHARTS.
    expect(MAX_CHARTS).toBe(3);
    const arcShirt = forBrand(/arc.?teryx/i).find((f) => f.word === "shirt");
    expect(arcShirt?.wrongSlots).toBeGreaterThan(0);
    expect(arcShirt?.slots).toBe(MAX_CHARTS);
  });

  it("does not report a brand that genuinely has no chart for the family", () => {
    // The fallback exists so a brand whose charts do not cover the asked
    // category still sends something. Reporting that would be reporting the
    // feature. Every finding names a family one of the brand's OWN charts claims.
    for (const f of fallbacks) {
      const pool = charts.filter((c) => c.brand === f.brand);
      expect(
        pool.some((c) => claimedFamilies(c.garment).includes(f.family)),
        `${f.brand} is reported for ${f.family} and has no chart claiming it`,
      ).toBe(true);
    }
  });

  it("says nothing when a brand lists the word it is asked about", () => {
    // The other direction: a chart that carries the token must not be reported.
    expect(categoryMatches(["bottom", "pant", "jean"], "jean")).toBe(true);
    expect(categoryMatches(["bottom", "pant"], "jean")).toBe(false);
  });
});

// US-3405, 2026-09-20. The audit's headline used to score a vocabulary the
// resolver is never called with, which inflated it roughly three times.
describe("the vocabulary the resolver can actually be called with", () => {
  const src = readFileSync(
    "services/edge-functions/src/lib/ai-extract.ts",
    "utf8",
  );
  const arrayOf = (name) => {
    const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(src);
    expect(m, `${name} not found in ai-extract.ts`).toBeTruthy();
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const enumValues = new Set([
    ...arrayOf("GARMENT_TYPES"),
    ...arrayOf("GARMENT_CATEGORIES"),
  ]);

  it("every REACHABLE word is a value some caller can pass", () => {
    // Not a vibe: grading-pipeline passes submission.garment_category,
    // ai-extract passes categoryHintFromKnown over garment_category /
    // garment_type / item_category, ai-listing passes garment_type ??
    // garment_category. All of them are this enum or null.
    const words = Object.values(REACHABLE).flat();
    expect(words.length).toBeGreaterThan(10);
    expect(words.filter((w) => !enumValues.has(w))).toEqual([]);
  });

  it("the words the wide list adds are ones no caller can pass", () => {
    // If one of these ever becomes reachable, this fails and the headline has
    // to widen again rather than quietly staying wrong.
    for (const w of ["tee", "polo", "flannel", "jogger", "chino", "romper"]) {
      expect(ASKED.top.concat(ASKED.bottom, ASKED.dress)).toContain(w);
      expect(enumValues.has(w), `${w} is now a real category`).toBe(false);
    }
  });

  it("scoring the reachable set finds strictly fewer asks than the wide one", () => {
    const charts = readCharts();
    const narrow = auditFallbacks(charts, REACHABLE).fallbacks.length;
    const wide = auditFallbacks(charts, ASKED).fallbacks.length;
    expect(narrow).toBeGreaterThan(0);
    expect(narrow).toBeLessThan(wide);
  });

  it("the shipped column is zero, and it is zero by construction", () => {
    // The audit only asks a brand about a family one of its OWN charts claims,
    // and US-3405's filter keeps exactly those. So this column can only be
    // zero, and the case exists to stop someone reading it as a measurement.
    const charts = readCharts();
    for (const vocab of [REACHABLE, ASKED]) {
      const { fallbacks } = auditFallbacks(charts, vocab);
      expect(fallbacks.some((f) => f.wrongSlots > 0)).toBe(true);
      expect(fallbacks.filter((f) => f.wrongSlotsShipped > 0)).toEqual([]);
    }
  });
});

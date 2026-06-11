import { describe, it, expect } from "vitest";
import { PUBLIC_ROUTES } from "../public-routes";

// US-435: CI guard for SEO title/description length + uniqueness. A registry
// route with a truncated (over-length) or duplicate title/description quietly
// degrades SERP appearance and cannibalizes ranking. This fails the build so
// glossary-generated and hand-written metadata stay within policy.
//
// Policy (the " | GradeThread" suffix the <SEO> layer appends counts toward the
// title budget):
//   - title (incl. suffix): <= 60 chars (SERP pixel cap is ~60), unique
//   - description: 70–160 chars (Google truncates ~155–160; <70 wastes the
//     snippet), unique
const TITLE_SUFFIX = " | GradeThread";
const TITLE_MAX = 60;
const DESC_MIN = 70;
const DESC_MAX = 160;

describe("public route metadata budget (US-435)", () => {
  it.each(PUBLIC_ROUTES.map((r) => [r.path, r] as const))(
    "%s title fits the SERP cap",
    (_path, r) => {
      const full = r.title + TITLE_SUFFIX;
      expect(
        full.length,
        `title too long (${full.length} > ${TITLE_MAX}): "${full}"`,
      ).toBeLessThanOrEqual(TITLE_MAX);
      expect(r.title.trim().length, `empty title for ${r.path}`).toBeGreaterThan(0);
    },
  );

  it.each(PUBLIC_ROUTES.map((r) => [r.path, r] as const))(
    "%s description fits the snippet window",
    (_path, r) => {
      expect(
        r.description.length,
        `description ${r.description.length} chars out of ${DESC_MIN}-${DESC_MAX} for ${r.path}: "${r.description}"`,
      ).toBeGreaterThanOrEqual(DESC_MIN);
      expect(
        r.description.length,
        `description ${r.description.length} chars out of ${DESC_MIN}-${DESC_MAX} for ${r.path}: "${r.description}"`,
      ).toBeLessThanOrEqual(DESC_MAX);
    },
  );

  it("every title is unique", () => {
    const seen = new Map<string, string[]>();
    for (const r of PUBLIC_ROUTES) {
      (seen.get(r.title) ?? seen.set(r.title, []).get(r.title)!).push(r.path);
    }
    const dups = [...seen.entries()].filter(([, paths]) => paths.length > 1);
    expect(
      dups,
      `duplicate titles: ${dups.map(([t, p]) => `"${t}" → ${p.join(", ")}`).join("; ")}`,
    ).toEqual([]);
  });

  it("every description is unique", () => {
    const seen = new Map<string, string[]>();
    for (const r of PUBLIC_ROUTES) {
      (seen.get(r.description) ?? seen.set(r.description, []).get(r.description)!).push(
        r.path,
      );
    }
    const dups = [...seen.entries()].filter(([, paths]) => paths.length > 1);
    expect(
      dups,
      `duplicate descriptions: ${dups.map(([, p]) => p.join(", ")).join("; ")}`,
    ).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GARMENT_CATEGORIES, GARMENT_TYPES } from "@/lib/constants";

// US-2815. routes/grade.ts:445 rejects a submission whose garment_category is
// not in GARMENT_CATEGORIES, and the same for garment_type — AFTER the photos
// have uploaded. So the iOS picker has to offer the real list, and a list
// copied by hand into a second language is exactly the thing that drifts.
//
// Same shape as buyer-ios-capability-parity.test.ts: read the Swift, read the
// registry, fail on any difference.

const SWIFT = "ios/GradeThread/Grading/GarmentVocabulary.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * String literals inside one `static let NAME = [ … ]` array.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not defensive tidying — it is the
 * bug this parser was written after. A first pass over the TypeScript side
 * scraped `"other"`, `"neckwear"` and `"tie"` out of an explanatory comment
 * inside the array and reported 26 categories with three duplicates. The array
 * has 22 and no duplicates. Prose that quotes a value is indistinguishable from
 * the value unless the comment is removed before matching.
 */
function swiftArray(src: string, name: string): string[] {
  const start = src.indexOf(`static let ${name} = [`);
  expect(start, `${name} missing from ${SWIFT}`).toBeGreaterThan(-1);
  const end = src.indexOf("]", start);
  expect(end, `${name} is unterminated`).toBeGreaterThan(start);
  const body = src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the iOS garment picker offers exactly what the route accepts", () => {
  it("categories match, in order", () => {
    const swift = swiftArray(read(SWIFT), "categories");
    expect(swift.length, "parsed nothing — the Swift shape changed").toBeGreaterThan(10);
    expect(swift).toEqual([...GARMENT_CATEGORIES]);
  });

  it("types match, in order", () => {
    const swift = swiftArray(read(SWIFT), "types");
    expect(swift.length, "parsed nothing — the Swift shape changed").toBeGreaterThan(3);
    expect(swift).toEqual([...GARMENT_TYPES]);
  });

  it("neither list has duplicates", () => {
    // The symptom that exposed the comment bug. A duplicate here would mean the
    // parser is reading prose again, or the registry genuinely regressed —
    // both worth failing on.
    for (const name of ["categories", "types"] as const) {
      const swift = swiftArray(read(SWIFT), name);
      expect(new Set(swift).size, `${name} has duplicates`).toBe(swift.length);
    }
  });

  it("the route really does validate against these", () => {
    // If this stops being true the parity is pointless, and the picker could
    // safely offer anything. Worth knowing that day rather than later.
    const route = read("services/edge-functions/src/routes/grade.ts");
    expect(route).toContain("GARMENT_CATEGORIES.includes(garmentCategory");
  });
});

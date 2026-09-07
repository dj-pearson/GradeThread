// The two copies of aspect-normalize must agree on their TABLES.
//
// services/edge-functions/src/lib/aspect-normalize.ts (edge publish path) and
// src/lib/aspect-normalize.ts (web composer preview) both normalize aspect
// values, and iOS is server-driven off the first. If their tables drift, the
// same garment gets a different eBay Color in the preview than it does on the
// listing, and nothing fails until a seller notices.
//
// Both headers said "MIRRORED verbatim ... Keep the two in sync" and NOTHING
// enforced it. US-3125 added a house-colour vocabulary to COLOR_FAMILY and had
// to patch both files by hand; patching one and forgetting the other would have
// shipped silently.
//
// ⚠ THE FILES ARE NOT BYTE-IDENTICAL AND MUST NOT BE MADE SO. The web copy
// exports isSizeAspect and isClosedAspect, which the edge copy does not have.
// Copying one over the other breaks `tsc -b` — that is how this was found. So
// this test compares the SHARED TABLES, which is the part that has to agree,
// and deliberately ignores the exports that differ.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EDGE = resolve("services/edge-functions/src/lib/aspect-normalize.ts");
const WEB = resolve("src/lib/aspect-normalize.ts");

/** The literal body of `const <name> = ...;`, whitespace-normalised. */
function table(src: string, name: string): string | null {
  const start = src.indexOf(`const ${name}`);
  if (start === -1) return null;
  const open = src.indexOf("=", start);
  // Tables end at a line that is exactly "};" or "]);" at column 0.
  const end = src.slice(open).search(/\n(\};|\]\);)/);
  if (end === -1) return null;
  return src
    .slice(open, open + end)
    .replace(/\/\/[^\n]*/g, "")   // comments may legitimately differ
    .replace(/\s+/g, " ")
    .trim();
}

const TABLES = [
  "SIZE_GROUPS", "MATERIAL_GROUPS", "COLOR_GROUPS", "DEPARTMENT_GROUPS",
  "SIZE_TYPE_GROUPS", "COLOR_FAMILY", "LENGTH_FAMILY", "SLEEVE_FAMILY",
  "NECKLINE_FAMILY", "PATTERN_FAMILY", "FIT_FAMILY", "RISE_FAMILY",
  "CLOSURE_FAMILY", "OCCASION_FAMILY", "SEASON_FAMILY", "HEEL_HEIGHT_FAMILY",
  "HEEL_STYLE_FAMILY", "LEG_STYLE_FAMILY", "TOE_FAMILY", "SHAFT_FAMILY",
  "STRAP_FAMILY", "BASE_COLORS",
];

describe("aspect-normalize edge/web mirror", () => {
  const edge = readFileSync(EDGE, "utf8");
  const web = readFileSync(WEB, "utf8");

  it.each(TABLES)("%s is identical in both copies", (name) => {
    const a = table(edge, name);
    const b = table(web, name);
    // A null here means the extractor stopped matching the file's shape, which
    // is itself a failure: a silent null on both sides would compare equal and
    // this test would pass while checking nothing.
    expect(a, `${name} not found in the edge copy`).toBeTruthy();
    expect(b, `${name} not found in the web copy`).toBeTruthy();
    expect(b, `${name} has drifted between the two copies`).toBe(a);
  });

  it("COLOR_FAMILY carries the house vocabulary in both copies", () => {
    // A spot check with teeth: these came from US-3125 and are the exact words
    // that would go missing if only one file were patched.
    for (const word of ["espresso", "coffee", "kalamata".slice(0, 0) + "cocoa",
      "anthracite", "oat", "midnight", "camo"]) {
      expect(table(edge, "COLOR_FAMILY")).toContain(`${word}:`);
      expect(table(web, "COLOR_FAMILY")).toContain(`${word}:`);
    }
  });

  it("the header does not claim the files are byte-identical", () => {
    // They are not, and acting on that claim breaks the build.
    expect(edge).not.toContain("MIRRORED verbatim");
    expect(web).not.toContain("MIRRORED verbatim");
  });
});

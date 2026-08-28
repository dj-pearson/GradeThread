import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2890: the quarter-turn math exists twice, and this is what stops it
// drifting.
//
// US-2888 put it in src/lib/measure-photo-geometry.ts, which Vite compiles for
// the browser. US-2890 needs the same math at intake, inside a Deno service
// that cannot import from src/ (no path, no shared workspace, different
// runtime). So services/edge-functions/src/lib/measure-quarter-turn.ts is a
// deliberate second copy.
//
// A COMMENT SAYING "keep these in sync" IS NOT A GUARD. The failure this
// prevents is not dramatic and is nearly invisible: someone corrects a sign in
// rotatePointQuarter on the web side because a rotated line landed mirrored,
// the intake pass keeps the old sign, and from then on a photo rotated in the
// browser and a photo rotated at intake disagree about where the same
// measurement is - with both sides passing their own tests.
//
// KEYED ON THE FUNCTION BODY, normalised for whitespace and for the two things
// that legitimately differ: the web file's `Point` import comes from a type
// module and the edge file declares it locally, and deno fmt indents a chained
// ternary differently from prettier. Nothing else is allowed to differ. If a
// real divergence is ever intended, delete the name from SHARED and say why -
// which is a visible decision rather than a silent one.

const ROOT = process.cwd();
const WEB = resolve(ROOT, "src/lib/measure-photo-geometry.ts");
const EDGE = resolve(ROOT, "services/edge-functions/src/lib/measure-quarter-turn.ts");

/**
 * Every function that must read identically on both sides.
 *
 * Shrink-only in spirit. `rotateCalibrationQuarter` is the one that carries a
 * whole calibration and therefore the one a drift would hurt most, so it is
 * deliberately in the list rather than trusted to its callers.
 */
const SHARED = [
  "rotatedDims",
  "rotatePointQuarter",
  "matMul3",
  "quarterInverseAffine",
  "rotateHomographyQuarter",
  "rotateCalibrationQuarter",
  "invert3",
  "applyH",
  "cardUprightQuarter",
  "quarterLabel",
];

/**
 * The body of `function <name>(`, brace-counted from the end of the parameter
 * list.
 *
 * Balancing the PARAMETER parens first is not optional: a default-value lambda
 * in the signature would otherwise make the first `{` the body, and the
 * comparison would silently pass on two empty strings.
 */
function body(source: string, name: string): string | null {
  const decl = source.search(new RegExp(`function ${name}\\s*(<[^>]*>)?\\s*\\(`));
  if (decl === -1) return null;
  let i = source.indexOf("(", decl);
  let paren = 0;
  for (; i < source.length; i++) {
    if (source[i] === "(") paren++;
    else if (source[i] === ")") {
      paren--;
      if (paren === 0) break;
    }
  }
  const open = source.indexOf("{", i);
  if (open === -1) return null;
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, j + 1);
    }
  }
  return null;
}

/** Collapse formatting so deno fmt and prettier can disagree in peace. */
function normalise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .replace(/,\s*\)/g, ")")
    .replace(/,\s*\]/g, "]")
    .replace(/,\s*\}/g, "}")
    .trim();
}

describe("the quarter-turn math reads the same on the web and at intake", () => {
  const web = readFileSync(WEB, "utf8");
  const edge = readFileSync(EDGE, "utf8");

  it("finds both files and every shared function in each", () => {
    // Guards the guard. A rename on either side that this file did not follow
    // would otherwise make every comparison below vacuously true, which is the
    // failure mode of the whole idea.
    expect(web.length).toBeGreaterThan(1000);
    expect(edge.length).toBeGreaterThan(1000);
    for (const name of SHARED) {
      expect(body(web, name), `${name} not found in ${WEB}`).not.toBeNull();
      expect(body(edge, name), `${name} not found in ${EDGE}`).not.toBeNull();
    }
  });

  for (const name of SHARED) {
    it(`${name} is byte-identical once formatting is normalised`, () => {
      expect(normalise(body(edge, name)!)).toBe(normalise(body(web, name)!));
    });
  }

  it("the body reader is not fooled by a default value in the parameter list", () => {
    // The exact shape that made the first cut of android/scripts/check-root-insets.mjs
    // report a working screen as broken: the first `{` after the declaration
    // belongs to a parameter, not to the body.
    const sample = `function f(cb: () => void = () => {}, n = 1) { return n; }`;
    expect(normalise(body(sample, "f")!)).toBe("{ return n; }");
  });
});

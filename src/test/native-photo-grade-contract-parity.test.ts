import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2815. The photo-grade contract now exists on BOTH phones, and neither copy
// can be trusted to stay right on its own.
//
// The three values below are the ones a client gets wrong with nothing failing
// until a customer hits it, which is why they are read out of the ROUTE here
// rather than compared between the two clients:
//
//   • the image-type vocabulary, where the route says `label` and the capture
//     strip says `tag` (US-2304 found those two lists disagreeing once already);
//   • the required set, which decides whether someone is told BEFORE paying or
//     after a charge, a vision call per image and a refund;
//   • the image cap, which the iOS copy's own comment records being written as
//     12 from memory when the route says 14.

const ROUTE = "services/edge-functions/src/routes/grade.ts";
const QUALITY = "services/edge-functions/src/lib/image-quality.ts";
const SWIFT = "ios/GradeThread/Grading/PhotoGradeUploader.swift";
const KOTLIN = "android/app/src/main/java/com/gradethread/app/grading/PhotoGradeContract.kt";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** Quoted strings in a region, comments removed first. */
function literals(src: string, from: string, to: string): string[] {
  const start = src.indexOf(from);
  expect(start, `anchor ${from} missing`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start + from.length);
  expect(end, `terminator after ${from} missing`).toBeGreaterThan(start);
  const body = src
    .slice(start + from.length, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the required set matches the route's blocking list", () => {
  const expected = (() => {
    const src = read(QUALITY);
    // REQUIRED_IMAGE_TYPES is the list whose absence blocks.
    return literals(src, "REQUIRED_IMAGE_TYPES", "]");
  })();

  it("the route really blocks on three types", () => {
    // If this stops being three, both phones are asking for the wrong set and
    // the parity below would happily agree on it.
    expect(expected.length, "REQUIRED_IMAGE_TYPES changed shape").toBe(3);
  });

  it("Android asks for exactly those", () => {
    expect(literals(read(KOTLIN), "requiredGradingTypes: List<String> = listOf(", ")")).toEqual(
      expected,
    );
  });

  it("iOS asks for exactly those", () => {
    expect(literals(read(SWIFT), "requiredGradingTypes = [", "]")).toEqual(expected);
  });
});

describe("the image cap matches the route", () => {
  const cap = (() => {
    const m = read(ROUTE).match(/MAX_IMAGES_PER_SUBMISSION\s*=\s*([A-Za-z_.]+|\d+)/);
    expect(m, "MAX_IMAGES_PER_SUBMISSION not found on the route").toBeTruthy();
    return m?.[1] ?? "";
  })();

  it("is derived from IMAGE_TYPES rather than typed twice", () => {
    // The route defines the cap as the vocabulary's own length. A phone that
    // hardcodes a number is fine only while that number is right, which is why
    // both are checked against the count below rather than against each other.
    expect(cap.length).toBeGreaterThan(0);
  });

  it("both phones carry the same number", () => {
    const swift = read(SWIFT).match(/maxImages\s*=\s*(\d+)/)?.[1];
    const kotlin = read(KOTLIN).match(/MAX_IMAGES\s*=\s*(\d+)/)?.[1];
    expect(swift, "iOS maxImages missing").toBeTruthy();
    expect(kotlin, "Android MAX_IMAGES missing").toBeTruthy();
    expect(kotlin).toEqual(swift);
  });
});

describe("the tag/label rename survives on both", () => {
  it("Android maps tag -> label, not tag -> tag", () => {
    const src = read(KOTLIN);
    expect(src).toContain('"tag" -> "label"');
    expect(src).toContain('"tag_2" -> "label_2"');
  });

  it("iOS maps the same pair", () => {
    const src = read(SWIFT);
    expect(src).toContain('case .tag: return "label"');
    expect(src).toContain('case .tag2: return "label_2"');
  });

  it("the route really speaks `label`", () => {
    // The whole reason the mapping exists. If the route ever accepted `tag`,
    // both phones would be translating for no reason and the next reader would
    // undo it.
    expect(read(QUALITY)).toContain('"label"');
  });
});

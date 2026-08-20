import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2688. One route reads a camelCase body key where the rest of the edge reads
// snake_case, and iOS is the only client whose transport rewrites keys. The two
// halves have to be pinned TOGETHER: the Swift is now hard-coded to send
// `gradeReportId`, so a well-meaning "make this consistent with the other
// routes" edit on the server would break the client the fix just repaired, in
// the same silent way and with the same 400.
//
// WHY THE SWIFT SIDE IS NOT ENOUGH. `DisputeFilingTests` asserts the encoded
// bytes and runs on iOS CI, which is the right place for it. It cannot see the
// route. This file cannot see the encoder. Neither half alone says the pair
// agrees.

const ROUTE = "services/edge-functions/src/routes/grade.ts";
const SWIFT = "ios/GradeThread/Grading/DisputeFiling.swift";
const SHEET = "ios/GradeThread/Grading/DisputeSheet.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** Comments stripped: a paragraph about a key is not a key. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the dispute route and the iOS body agree on one spelling (US-2688)", () => {
  it("the route accepts BOTH spellings", () => {
    // iOS cannot send camelCase. The shared encoder applies .convertToSnakeCase
    // to the CodingKey's stringValue, so no client-side declaration survives it
    // - which is why the fix is here and not in Swift.
    const src = code(ROUTE);
    expect(src).toContain("body.gradeReportId");
    expect(
      src.includes("body.grade_report_id"),
      "the route stopped accepting the snake_case spelling, which is the only " +
        "one iOS can send; every dispute filed from the phone 400s again",
    ).toBe(true);
  });

  it("the Swift does NOT pretend CodingKeys protect the key", () => {
    // They do not, and a declaration that reads as protection is worse than
    // none: the first fix for this story was exactly that, and it shipped to
    // iOS CI before the byte-level test caught it.
    const src = code(SWIFT);
    expect(src).not.toContain('case gradeReportId = "gradeReportId"');
  });

  it("the request type is NOT declared inside the view again", () => {
    // It was, and that is how it went unnoticed: a struct inside a function
    // body is not something a test can encode, so nothing ever looked at the
    // bytes.
    const sheet = code(SHEET);
    expect(sheet).not.toMatch(/struct DisputeRequest\s*:/);
    expect(sheet).toContain("DisputeRequest(");
  });

  it("evidence photos ride the key the route reads", () => {
    // `images` is a single word, so .convertToSnakeCase leaves it alone and it
    // was never at risk - which is also why the Swift declares no CodingKeys
    // for it. Asserted on the property, not on a CodingKey that should not
    // exist.
    const route = code(ROUTE);
    expect(route).toContain("body.images");
    expect(code(SWIFT)).toContain("let images: [String]?");
  });

  it("the cap agrees with the route, which rejects the WHOLE filing over it", () => {
    const route = read(ROUTE);
    const m = /MAX_DISPUTE_EVIDENCE\s*=\s*(\d+)/.exec(route);
    expect(m, "MAX_DISPUTE_EVIDENCE vanished from the route").toBeTruthy();
    const swift = read("ios/GradeThread/Grading/DisputeEvidence.swift");
    const s = /static let maxPhotos\s*=\s*(\d+)/.exec(swift);
    expect(s, "maxPhotos vanished from the Swift").toBeTruthy();
    expect(Number(s![1])).toBe(Number(m![1]));
  });
});

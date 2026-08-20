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
  it("the route reads gradeReportId, camelCase", () => {
    const src = code(ROUTE);
    expect(src).toContain("body.gradeReportId");
    // If this ever becomes true, the Swift CodingKeys below are now wrong and
    // every iOS filing 400s again. Change both or neither.
    expect(
      src.includes("body.grade_report_id"),
      "the route started reading snake_case; ios/GradeThread/Grading/DisputeFiling.swift " +
        "pins the camelCase spelling and must change in the same commit",
    ).toBe(false);
  });

  it("the Swift pins that spelling explicitly", () => {
    // Without this the shared encoder's .convertToSnakeCase rewrites it to
    // grade_report_id, which is the outage this story is about.
    const src = code(SWIFT);
    expect(src).toContain('case gradeReportId = "gradeReportId"');
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
    const route = code(ROUTE);
    expect(route).toContain("body.images");
    expect(code(SWIFT)).toContain("case images");
    // Single-word keys are not rewritten by the encoder, so `images` was never
    // at risk. Asserted anyway because the pair is the contract, not the risk.
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

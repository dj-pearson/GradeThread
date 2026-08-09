// US-2136 AC4: the submission upload's parallel arrays must stay aligned.
//
// grade.ts zips `images`, `image_types`, `phashes`, `exif_metadata` and now
// `quality_scores` BY INDEX. Nothing on the wire carries a key, so a field
// appended outside the per-photo loop — or appended conditionally — silently
// shifts every later photo's metadata onto the wrong image. The failure is not
// an error: it is one seller's tag sharpness attributed to another seller's
// front shot, and a confidence cap applied to the wrong submission.
//
// This is a source check because the alignment is a property of the LOOP, and
// no unit test of the page component would notice a field moved three lines up.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SUBMISSION = join(process.cwd(), "src", "pages", "new-submission.tsx");

/** Every field grade.ts reads positionally alongside `images`. */
const PARALLEL_FIELDS = [
  "images",
  "image_types",
  "phashes",
  "exif_metadata",
  "quality_scores",
];

describe("US-2136: the per-photo upload fields are appended together", () => {
  // Normalized to LF: the repo is CRLF on Windows, and a check that matches
  // across a line break would pass or fail by checkout setting otherwise.
  const source = readFileSync(SUBMISSION, "utf8").split("\r\n").join("\n");

  it("appends every parallel field inside one loop over photos", () => {
    // Bound the search to the loop body: from `for (const photo of` to the
    // closing brace of that block, found by the next line at the same indent.
    const start = source.indexOf("for (const photo of");
    expect(start, "the per-photo append loop moved or was renamed").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n      }", start));

    for (const field of PARALLEL_FIELDS) {
      expect(
        body.includes(`"${field}"`),
        `${field} must be appended INSIDE the per-photo loop — grade.ts zips ` +
          `these by index, so one appended elsewhere misattributes every ` +
          `later photo's metadata.`,
      ).toBe(true);
    }
  });

  it("appends each parallel field exactly once, unconditionally", () => {
    for (const field of PARALLEL_FIELDS) {
      // `formData.append("x"` or the wrapped `formData.append(\n  "x"` form.
      const appends =
        source.match(new RegExp(`formData\\.append\\(\\s*"${field}"`, "g"))?.length ?? 0;
      expect(
        appends,
        `${field} is appended ${appends} times; a second (or conditional) ` +
          `append pushes an extra entry and shifts the whole array.`,
      ).toBe(1);
    }
  });

  it("sends an EMPTY string for an unmeasured quality, never a zero", () => {
    // Zero is a measurement — "we looked and it is unreadable" — and it caps
    // authenticity confidence. Absent must stay absent.
    expect(source).toMatch(
      /typeof photo\.qualityScore === "number" \? String\(photo\.qualityScore\) : ""/,
    );
  });
});

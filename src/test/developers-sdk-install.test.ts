// /developers must not tell customers to clone the GradeThread repository.
//
// The SDK is not on npm yet, and the page's install block was a `git clone` of
// github.com/dj-pearson/GradeThread. That repository is private, so the command
// fails for every outside customer. Until the package is published the page
// says so and points at the REST API and support; once it is, the install line
// is `npm install @gradethread/sdk`, which this also allows.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync(resolve(process.cwd(), "src/pages/marketing/developers.tsx"), "utf8");

// Code only: the comment explaining the history names the old command.
const CODE = PAGE.replace(/^\s*\/\/.*$/gm, "");

describe("/developers SDK install copy", () => {
  it("does not give a git clone of the private repository", () => {
    expect(CODE).not.toMatch(/git clone/);
    expect(CODE).not.toMatch(/github\.com\/dj-pearson\/GradeThread/);
  });

  it("says the SDK is unpublished and names a way forward, unless it has an npm install", () => {
    if (/npm install @gradethread\/sdk/.test(CODE)) return;
    expect(CODE).toMatch(/SDK is not published yet/);
    expect(CODE).toMatch(/mailto:support@gradethread\.com/);
  });
});

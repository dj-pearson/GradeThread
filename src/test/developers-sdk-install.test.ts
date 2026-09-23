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

// The SDK's own README carried the same git clone after the page stopped.
describe("sdk/gradethread-js/README.md install section", () => {
  const README = readFileSync(resolve(process.cwd(), "sdk/gradethread-js/README.md"), "utf8");
  const install = README.slice(README.indexOf("## Install"), README.indexOf("## Quick start"));

  it("does not give a git clone of the private repository", () => {
    expect(install).not.toMatch(/git clone/);
    expect(install).not.toMatch(/github\.com\/dj-pearson\/GradeThread/);
  });

  it("says the SDK is unpublished and points at the HTTP API docs", () => {
    expect(install).toMatch(/not published to npm yet/);
    expect(install).toContain("https://gradethread.com/developers");
    expect(install).toMatch(/mailto:support@gradethread\.com/);
  });
});

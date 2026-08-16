// US-2637: a half-built dist/ is treated as no dist/, not as a good one.
//
// `npm run build` is `tsc -b && vite build && node scripts/prerender.mjs`. When
// the prerender errors or is KILLED — the pre-push lane has been killed at the
// coverage step for memory before — what is left behind is a dist/ with 688
// asset files, a seo-manifest.json, and an index.html that is still the raw
// template with `<!--prerender:body-->` in it.
//
// `existsSync` said "built", so every dist-gated guard ran against a document
// containing none of the content it asserts on, and failed with messages like
// "expected … to contain 'logo_primary.png'". Nothing in that failure names the
// prerender. Measured on this box 2026-08-16: dist/ held 688 assets and exactly
// two HTML files (index.html, 404.html), index.html still carried the marker,
// and the only visible symptom was a logo assertion in an unrelated suite.
//
// The rule this settles: a build output missing the step that produces the thing
// under test is the SAME epistemic state as no build output. Skip locally, fail
// loudly in CI, and say which step did not run.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireDist, distIsRequired } from "./dist-required";

const PRERENDERED = "<html><body><div id=\"root\"><h1>Home</h1></div></body></html>";
const RAW_TEMPLATE = "<html><body><div id=\"root\"><!--prerender:body--></div></body></html>";

function withIndex(html: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "gt-dist-"));
  const p = join(dir, "index.html");
  if (html !== null) writeFileSync(p, html);
  return p;
}

describe("US-2637: requireDist tells a half-built dist from a built one", () => {
  it("a prerendered index.html is accepted", () => {
    const p = withIndex(PRERENDERED);
    try {
      expect(requireDist(p, "probe")).toBe(true);
    } finally {
      rmSync(join(p, ".."), { recursive: true, force: true });
    }
  });

  it("an index.html still carrying the prerender marker is not", () => {
    const p = withIndex(RAW_TEMPLATE);
    try {
      // Locally: skip, exactly as an absent dist/ does. The dev has no build
      // output worth asserting against either way.
      expect(requireDist(p, "probe")).toBe(false);
    } finally {
      rmSync(join(p, ".."), { recursive: true, force: true });
    }
  });

  it("in CI the half-built case throws, and the message names the prerender", () => {
    const p = withIndex(RAW_TEMPLATE);
    const prior = process.env.DIST_TESTS_REQUIRED;
    process.env.DIST_TESTS_REQUIRED = "1";
    try {
      // The whole value is in WHICH failure the reader sees. A generic "dist is
      // missing" here would send them to the build step; the real cause is the
      // step after it.
      expect(() => requireDist(p, "probe")).toThrow(/HALF-BUILT/);
      expect(() => requireDist(p, "probe")).toThrow(/prerender/);
    } finally {
      if (prior === undefined) delete process.env.DIST_TESTS_REQUIRED;
      else process.env.DIST_TESTS_REQUIRED = prior;
      rmSync(join(p, ".."), { recursive: true, force: true });
    }
  });

  it("an absent dist/ still gives the original message, not the new one", () => {
    // Two different causes must not collapse into one message. Absent means the
    // build never ran; half-built means it ran and stopped partway.
    const p = withIndex(null);
    const prior = process.env.DIST_TESTS_REQUIRED;
    process.env.DIST_TESTS_REQUIRED = "1";
    try {
      expect(() => requireDist(p, "probe")).toThrow(/US-2038/);
      expect(() => requireDist(p, "probe")).not.toThrow(/HALF-BUILT/);
    } finally {
      if (prior === undefined) delete process.env.DIST_TESTS_REQUIRED;
      else process.env.DIST_TESTS_REQUIRED = prior;
    }
  });

  it("the CI/local decision is unchanged", () => {
    // Untouched by this story, asserted so the half-build branch cannot be
    // "fixed" later by loosening the thing it depends on.
    expect(distIsRequired({ CI: "true" })).toBe(true);
    expect(distIsRequired({})).toBe(false);
    expect(distIsRequired({ CI: "true", DIST_TESTS_REQUIRED: "0" })).toBe(false);
  });
});

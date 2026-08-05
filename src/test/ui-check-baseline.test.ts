// US-2402: keep the mandated UI check at zero findings on src/.
//
// `npx impeccable detect src` reported 14 anti-patterns, all of them the
// broken-image rule, and every single one was the literal tag text sitting in a
// COMMENT or a test name — prose about images, not images. The rule is right to
// be greedy (it cannot know a string is prose), so the fix was on our side: the
// prose now says "an img element" / "a linked image" and the tool reports zero.
//
// THE COST WAS NEVER THE NOISE, IT WAS THE PRECEDENT. CLAUDE.md says there is no
// excuse for asserting a UI is clean without running this tool, and the tool's
// honest answer here was 14 findings that all had to be dismissed by hand. A
// check whose correct response is always "ignore it" stops being read, and the
// first real finding arrives inside a list nobody opens.
//
// WHY THIS TEST RATHER THAN THE TOOL ITSELF: impeccable runs via npx with no
// install, which means a network fetch. Putting that in the vitest lane would
// make an offline run — or a flaky registry — look like a UI regression, and it
// exits 0 even when it finds things, so a lane step would have to parse its
// prose output. This asserts the LOCAL property that keeps the count at zero:
// the tag text never appears without its src. It is a re-derivation of the rule,
// not a wrapper around it, and it is deliberately narrower — it guards the one
// class of finding this repo actually produces.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TAG = "<" + "img";

/**
 * Test DIRECTORIES are out of scope, matching what the detector itself scans —
 * it reported src/lib/verified.test.ts (a test file beside its module) but
 * nothing under src/test/ or src/lib/__tests__/. Guard suites legitimately hold
 * the tag text in regexes and in prose about what they assert, and holding them
 * to a copy rule the tool does not apply would be noise of our own making.
 */
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!TEST_DIRS.has(entry)) out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every occurrence of the img tag text that has no `src=` within the next few
 * lines. A real element always names its source — in JSX often on the following
 * line — so what is left is prose, which is exactly what the detector flags.
 */
function taglikeWithoutSrc(src: string): number[] {
  const lines = src.split(/\r?\n/);
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (!line.includes(TAG)) return;
    // Look ahead far enough for a multi-line JSX element to name its src.
    const window = lines.slice(i, i + 4).join("\n");
    if (!/\bsrc\s*=/.test(window)) hits.push(i + 1);
  });
  return hits;
}

describe("impeccable baseline for src/ (US-2402)", () => {
  it("no img tag text appears without a src — the whole broken-image finding set", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      for (const line of taglikeWithoutSrc(readFileSync(file, "utf8"))) {
        offenders.push(`${file.replace(/\\/g, "/")}:${line}`);
      }
    }
    expect(
      offenders,
      "These lines write the img tag text with no src. If it is prose in a " +
        "comment or a test name, say 'an img element' or 'a linked image' " +
        "instead — the detector cannot tell prose from markup, and every one of " +
        "these shows up in `npx impeccable detect src` as a finding a reviewer " +
        "then has to dismiss by hand. If it is a real element, give it a src.",
    ).toEqual([]);
  });

  it("catches the shape it is meant to catch", () => {
    // Negative control: the guard is only worth having if it fails on the thing
    // it was written for. This is the exact text that was in safe-url.ts:1.
    const prose = "// Scheme allowlist for URLs that reach an <a href> / " + TAG + " src> from the";
    expect(taglikeWithoutSrc(prose)).toEqual([1]);
    // ...and does not fire on a real element, including a multi-line one.
    expect(taglikeWithoutSrc(TAG + ' src="/logo.png" alt="" />')).toEqual([]);
    expect(taglikeWithoutSrc([TAG, '  className="x"', '  src={url}', "/>"].join("\n"))).toEqual([]);
  });
});

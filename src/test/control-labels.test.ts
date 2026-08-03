// US-2335 AC3: the number of unlabelled form controls must not grow.
//
// WHY THIS IS A BASELINE AND NOT A LINT RULE. The obvious move is to switch on
// `jsx-a11y/control-has-associated-label`. It was tried: 612 violations across
// 175 files, and sampling them shows correct code — `<Label htmlFor="fullName">`
// beside `<Input id="fullName">` is properly labelled, and the rule flags it
// because it only understands NESTING and aria-*, never htmlFor↔id across
// siblings. A rule that fails the build on hundreds of already-correct controls
// does not get fixed; it gets disabled, and then it protects nothing.
//
// So the pairing is resolved the way a browser resolves it
// (scripts/audit-control-labels.mjs) and the result is pinned here. New
// violations fail. The baseline only moves DOWN.
//
// The count landed at 361, which is within two of the story's ~359 estimate —
// two independent methods agreeing, after an intermediate 544 that turned out
// to be double-counting shadcn's <Select> alongside its own <SelectTrigger>.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditFile, walk } from "../../scripts/audit-control-labels.mjs";

/**
 * Controls with no resolvable accessible name, as of 2026-08-03.
 *
 * NOT a target to sit at — a ceiling that only ratchets down. Lower it whenever
 * a batch lands; never raise it. Raising it is the moment this test stops
 * meaning anything, so if you are about to, add the label instead.
 */
const BASELINE = 74;

describe("form controls carry an accessible name (US-2335)", () => {
  const files = walk(resolve(process.cwd(), "src"));

  it("scans a real corpus", () => {
    // Guards the guard: a broken walk() makes every assertion below vacuous.
    expect(files.length).toBeGreaterThan(200);
  });

  it("does not exceed the recorded baseline", () => {
    let total = 0;
    const perFile: Array<[string, number]> = [];
    for (const f of files) {
      const hits = auditFile(readFileSync(f, "utf8"));
      if (hits.length) {
        total += hits.length;
        perFile.push([f, hits.length]);
      }
    }
    if (total > BASELINE) {
      perFile.sort((a, b) => b[1] - a[1]);
      const worst = perFile.slice(0, 5)
        .map(([f, n]) => `${f.replace(/^.*[\\/]src[\\/]/, "")} (${n})`)
        .join(", ");
      throw new Error(
        `${total} unlabelled controls, baseline ${BASELINE}. A screen reader ` +
          `user cannot tell what these are for. Give the control an aria-label, ` +
          `or point a <Label htmlFor> at its id. Worst files: ${worst}`,
      );
    }
    expect(total).toBeLessThanOrEqual(BASELINE);
  });

  it("the auth surface stays clean", () => {
    // The highest-traffic screens, and already at zero — so this is a
    // regression guard rather than a target. Every new signup and login passes
    // through here, which makes it the one surface worth pinning individually.
    for (const page of ["src/pages/login.tsx", "src/pages/signup.tsx"]) {
      const hits = auditFile(readFileSync(resolve(process.cwd(), page), "utf8"));
      expect(hits, `${page} regressed: ${JSON.stringify(hits)}`).toEqual([]);
    }
  });
});

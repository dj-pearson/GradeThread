// US-2623: the UI gate's SCOPE, pinned.
//
// WHY A TEST ABOUT SCOPE AND NOT ABOUT RULES. The gate's rules were never the
// weak part — the seven ENFORCED ones have blocked at zero since US-2336. What
// failed is much simpler and much harder to notice: `functions/` was not being
// looked at. It was excluded with a note saying scoring it "needs its own
// decision", and then nothing decided. A `.key-takeaways` callout on the live
// blog template carried a 4px accent stripe on every published post — the exact
// pattern the project's guidance calls the single most recognizable tell — and
// the gate said OK the whole time, truthfully, about the tree it was given.
//
// A gate that passes because of what it was pointed at is worse than no gate,
// because the green is read as evidence. So the roots are asserted here, in the
// suite that runs on every push, rather than left to a comment in the script.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENFORCED,
  NOT_SOURCE_CHECKABLE,
  ROOTS,
  matchesNoise,
  reconcileNoise,
} from "../../scripts/check-ui-antipatterns.mjs";

/**
 * The names the project's guidance uses, against the ids the TOOL uses.
 *
 * Two of the four tells named in CLAUDE.md were carried in ENFORCED under
 * names impeccable has never emitted, which is why they enforced nothing. The
 * mapping is kept so the guidance can keep its own vocabulary while this test
 * checks against the tool's.
 */
const RENAMED_TO: Record<string, string> = {
  "uppercase-eyebrow": "hero-eyebrow-chip",
  "icon-tile-grid": "icon-tile-stack",
};

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("US-2623: the UI anti-pattern gate scores every tree that renders UI", () => {
  it("both roots are scanned, and `functions` is one of them", () => {
    const paths = ROOTS.map((r) => r.path);
    // `functions/` renders the blog, the certificate pages and every og card —
    // the highest-traffic public HTML we serve. Dropping it from this list is
    // the regression this story exists to prevent, and it would otherwise show
    // up as the gate getting FASTER and staying green.
    expect(paths).toContain("src");
    expect(paths).toContain("functions");
  });

  it("every tell the guidance names is either blocking or recorded as uncheckable", () => {
    // ⚠ THIS USED TO ASSERT ONLY `ENFORCED.has(rule)`, AND IT PASSED FOR
    // MONTHS WHILE TWO OF THE FOUR NAMES ENFORCED NOTHING. Membership in a Set
    // is not the property anyone cares about; the property is that a bad
    // component gets stopped. `uppercase-eyebrow` was never one of the tool's
    // rule ids at all — it calls that tell `hero-eyebrow-chip` — and
    // `nested-cards` is real but browser-scoped, so a source scan can never
    // raise it. An id matching no rule produces no finding, which reads exactly
    // like a clean codebase.
    //
    // Found 2026-08-23 by writing a textbook instance of each tell into a probe
    // component and scanning it: four of the seven enforced ids said nothing.
    //
    // So the check now demands an ANSWER for each named tell rather than a
    // membership: it blocks, or it is written down as not source-checkable with
    // a reason. Removing one from both places is still a policy change and
    // still fails here.
    for (const rule of ["side-tab", "gradient-text", "nested-cards", "uppercase-eyebrow"]) {
      const blocking = ENFORCED.has(rule);
      const recorded = [...NOT_SOURCE_CHECKABLE.keys()].some(
        (id) => id === rule || RENAMED_TO[rule] === id,
      );
      expect(
        blocking || recorded,
        `${rule} is neither enforced nor recorded as uncheckable — it has ` +
          `silently stopped being policy`,
      ).toBe(true);
    }
  });

  it("every enforced rule is proven alive by a fixture, not just listed", () => {
    // The other half, and the one that would have caught the above. selfCheck()
    // in the gate scans scripts/fixtures/ui-antipatterns/ and requires each
    // enforced id to come back from the detector. Here we assert the fixtures
    // exist and cover the set, so nobody can satisfy selfCheck() by shrinking
    // ENFORCED to nothing.
    expect(ENFORCED.size, "the enforced set has been emptied").toBeGreaterThan(2);
    for (const rule of ENFORCED) {
      const fixture = `scripts/fixtures/ui-antipatterns/${rule}.tsx`;
      expect(
        existsSync(join(process.cwd(), fixture)),
        `${rule} is enforced but has no fixture at ${fixture}, so nothing ` +
          `proves the detector still raises it`,
      ).toBe(true);
    }
  });

  it("every allowed finding is a named site with a stated reason", () => {
    // The point of a named list over a number: a count of 2 permits any two
    // findings, a list of 2 permits exactly these two.
    for (const root of ROOTS) {
      for (const entry of root.knownNoise) {
        expect(entry.file, `${root.path}: an allowlist entry needs a file`).toBeTruthy();
        expect(entry.snippet, `${entry.file}: an allowlist entry needs a snippet`).toBeTruthy();
        expect(
          (entry.why ?? "").length,
          `${entry.file}: an allowlist entry without a reason is a suppression`,
        ).toBeGreaterThan(40);
      }
    }
  });

  it("the allowlist only shrinks: a stale entry is an error, not a shrug", () => {
    // Exercised directly rather than trusted, because this is the half that
    // makes the list self-cleaning. A fixed site leaves an entry behind, and an
    // entry that matches nothing quietly widens what the next one can hide.
    const entry = { file: "a/b.ts", snippet: "XYZ", why: "x".repeat(50) };
    expect(reconcileNoise([], [entry]).stale).toHaveLength(1);
    expect(reconcileNoise([{ file: "a/b.ts", snippet: "XYZ!" }], [entry]).stale).toHaveLength(0);
    expect(reconcileNoise([{ file: "a/c.ts", snippet: "XYZ" }], [entry]).unexpected).toHaveLength(1);
  });

  it("matching survives a Windows path", () => {
    // impeccable reports absolute paths with backslashes on this box and
    // forward slashes in CI. An allowlist that only matched one of those would
    // pass locally and fail the build, or worse, the other way round.
    const entry = { file: "functions/_shared/blog-render.ts", snippet: "<img", why: "" };
    expect(matchesNoise({ file: "C:\\r\\functions\\_shared\\blog-render.ts", snippet: "<img\\b" }, entry)).toBe(true);
    expect(matchesNoise({ file: "/r/functions/_shared/blog-render.ts", snippet: "<img\\b" }, entry)).toBe(true);
  });

  it("nothing runs a bare `impeccable detect` as the gate", () => {
    // The wrapper IS the gate — a bare detect exits non-zero on the whole rule
    // set at once, including the noise, which is how it gets switched off.
    for (const file of [".github/workflows/ci.yml", "scripts/verify.mjs", "package.json"]) {
      const src = read(file);
      if (!src.includes("impeccable")) continue;
      const bare = src
        .split(/\r?\n/)
        .filter((l) => /impeccable detect/.test(l) && !/^\s*(#|\/\/)/.test(l));
      expect(bare, `${file} should invoke check-ui-antipatterns.mjs, not impeccable directly`).toEqual([]);
    }
  });
});

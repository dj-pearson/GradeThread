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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENFORCED, ROOTS, matchesNoise, reconcileNoise } from "../../scripts/check-ui-antipatterns.mjs";

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

  it("the tells the guidance names are all still blocking", () => {
    // Not an exhaustive rule list — these are the ones the project's own UI
    // guidance calls out by name, so a quiet removal is a policy change.
    for (const rule of ["side-tab", "gradient-text", "nested-cards", "uppercase-eyebrow"]) {
      expect(ENFORCED.has(rule), `${rule} must stay blocking`).toBe(true);
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

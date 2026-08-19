import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FLAW_ENTRIES,
  FLAW_LIBRARY_HUB_PATH,
  FLAW_LIBRARY_LEGACY_HUB_PATH,
  flawPath,
  legacyFlawPath,
} from "@/lib/seo/flaw-library";

// US-9012 AC3. The flaw library moved from /grading/flaws to /care. Thirty-two
// URLs with ten weeks of history had to keep working, and a rename of any slug
// must not silently orphan the old one.
//
// This reads public/_redirects rather than trusting that somebody remembered,
// because the failure mode is invisible: a missing rule 404s an old URL and
// nothing in the build says so.

const redirects = readFileSync(resolve(process.cwd(), "public/_redirects"), "utf8");

/** Non-comment, non-blank rule lines, in file order. */
const rules = redirects
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

describe("the /care move keeps the old URLs alive (US-9012)", () => {
  it("moved the library to /care", () => {
    expect(FLAW_LIBRARY_HUB_PATH).toBe("/care");
    expect(FLAW_LIBRARY_LEGACY_HUB_PATH).toBe("/grading/flaws");
  });

  it("301s the hub", () => {
    expect(rules).toContain("/grading/flaws          /care         301");
  });

  it("301s every entry page through the splat", () => {
    expect(rules).toContain("/grading/flaws/*        /care/:splat  301");
  });

  it("keeps the redirects ABOVE the catch-all, or they never run", () => {
    // public/_redirects is first-match-wins. A rule after `/* -> /404.html`
    // is dead. The first draft of this move put them below it, which would
    // have 404'd all 32 old URLs while looking correct in the diff.
    const catchAll = rules.findIndex((l) => l.startsWith("/*"));
    const hubRule = rules.findIndex((l) => l.startsWith("/grading/flaws "));
    const splatRule = rules.findIndex((l) => l.startsWith("/grading/flaws/*"));
    expect(catchAll).toBeGreaterThan(-1);
    expect(hubRule).toBeGreaterThan(-1);
    expect(splatRule).toBeGreaterThan(-1);
    expect(hubRule).toBeLessThan(catchAll);
    expect(splatRule).toBeLessThan(catchAll);
  });

  it("covers all 32 entries, whatever their slugs are", () => {
    // The splat rule covers any slug, so this asserts the shape rather than
    // 32 literal lines: every legacy path must sit under the prefix the splat
    // matches, and every new path under /care.
    expect(FLAW_ENTRIES).toHaveLength(32);
    for (const f of FLAW_ENTRIES) {
      expect(legacyFlawPath(f.slug).startsWith("/grading/flaws/")).toBe(true);
      expect(flawPath(f.slug).startsWith("/care/")).toBe(true);
      // The splat maps the tail verbatim, so the slugs have to match or the
      // redirect lands on a 404 that looks like a working redirect.
      expect(legacyFlawPath(f.slug).replace("/grading/flaws/", "/care/")).toBe(
        flawPath(f.slug),
      );
    }
  });

  it("uses 301 rather than 302, because the move is permanent", () => {
    for (const rule of rules.filter((l) => l.startsWith("/grading/flaws"))) {
      expect(rule.endsWith("301")).toBe(true);
    }
  });
});

describe("the reframe actually happened (US-9012)", () => {
  it("gives every entry removal steps and a prevention paragraph", () => {
    for (const f of FLAW_ENTRIES) {
      expect(f.removal.length, f.slug).toBeGreaterThanOrEqual(3);
      expect(f.prevention.length, f.slug).toBeGreaterThan(80);
      expect(f.removalHeading.length, f.slug).toBeGreaterThan(10);
    }
  });

  it("is honest about the ones that do not come out", () => {
    // The whole differentiator. A laundry blog has to promise a fix to justify
    // the page; if this number ever goes to zero, somebody has started
    // pretending.
    const permanent = FLAW_ENTRIES.filter((f) => f.comesOut === "no");
    expect(permanent.length).toBeGreaterThanOrEqual(8);
    // The verdict belongs in the HEADING, which is what a reader sees first and
    // what the page turns into an explicit "Short answer: it does not come out"
    // banner. Asserting on step 1 would be wrong: moth holes are permanent AND
    // step 1 is "kill whatever is still in the fibres", which is correct advice.
    for (const f of permanent) {
      expect(f.removalHeading, f.slug).toMatch(
        /not|cannot|never|no |permanent|gone|replaced/i,
      );
    }
  });

  it("stopped using grading language in the titles", () => {
    // The old set read "Pilling on Clothes: Grade Impact". These pages are for
    // the person holding the garment, not for us.
    const gradingWords = FLAW_ENTRIES.filter((f) => /grade impact|grading/i.test(f.title));
    expect(gradingWords.map((f) => f.slug)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2833: the two UI gates have to agree about which rules each one owns.
//
// The source gate (check-ui-antipatterns.mjs) keeps NOT_SOURCE_CHECKABLE: rules
// a directory scan can never raise. The browser gate (check-ui-browser.mjs)
// keeps ENFORCED_BROWSER_RULES: the rules it scans live pages for. Those are
// the same four tells seen from two sides, and if they drift apart a tell falls
// between them and nothing checks it — which is precisely the state US-2833 was
// filed about, where four ids sat in an ENFORCED list enforcing nothing.
//
// This does NOT run a browser. The runtime proof that each rule still fires is
// selfCheck() inside check-ui-browser.mjs, against
// scripts/fixtures/ui-browser/index.html. What is pinned here is cheap and
// still worth pinning: the two lists match, and the fixture still contains the
// markup each rule needs. A fixture quietly tidied into good markup would make
// selfCheck fail loudly, which is correct but reads as a broken tool rather
// than an edited fixture, so the tells are named here too.

// Imported through the .d.mts declarations, deliberately, rather than cast from
// a dynamic import. A `as unknown as {...}` here would type-check against a
// shape written in this file, so scripts/check-ui-browser.d.mts could drift from
// the script and nothing would notice — and tsc believes the declaration, not
// the .mjs.
import {
  ALLOWED,
  ENFORCED_BROWSER_RULES,
  PAGES,
  unlistedPairs,
} from "../../scripts/check-ui-browser.mjs";
import { NOT_SOURCE_CHECKABLE } from "../../scripts/check-ui-antipatterns.mjs";

const ROOT = process.cwd();
const FIXTURE = resolve(ROOT, "scripts/fixtures/ui-browser/index.html");

describe("the source gate and the browser gate cover the same four tells", () => {
  it("neither list gains a rule without the other", () => {

    expect(
      [...ENFORCED_BROWSER_RULES].sort(),
      "a rule the source scan cannot raise is not being scanned in a browser " +
        "either, or vice versa. Either way one of CLAUDE.md's craft-floor tells " +
        "is now checked by nothing.",
    ).toEqual([...NOT_SOURCE_CHECKABLE.keys()].sort());
  });

  it("names the tool's real rule ids, not the ones this repo invented", () => {
    // These four spellings were verified against impeccable's own rule table.
    // The three on the left are the names this repo used and the tool does not
    // have; an id matching no rule is silently absent from every scan.
    for (const invented of ["icon-tile-grid", "uppercase-eyebrow", "border-and-shadow"]) {
      expect(
        ENFORCED_BROWSER_RULES,
        `${invented} is not a rule impeccable has - it would enforce nothing`,
      ).not.toContain(invented);
    }
    expect(ENFORCED_BROWSER_RULES).toContain("gpt-thin-border-wide-shadow");
    expect(ENFORCED_BROWSER_RULES).toContain("icon-tile-stack");
    expect(ENFORCED_BROWSER_RULES).toContain("hero-eyebrow-chip");
    expect(ENFORCED_BROWSER_RULES).toContain("nested-cards");
  });

  it("the fixture still carries the markup each rule needs", () => {
    const html = readFileSync(FIXTURE, "utf8");
    // One assertion per tell, so a tidy-up says WHICH one it removed.
    expect(html, "no tracked uppercase eyebrow above the h1").toMatch(
      /text-transform:\s*uppercase/,
    );
    expect(html, "no card nested inside a card").toMatch(
      /class="card"[\s\S]{0,400}class="card"/,
    );
    expect(html, "no rounded-square icon tile").toMatch(/border-radius:\s*1[26]px/);
    expect(html, "no hairline border under a wide shadow").toMatch(
      /border:\s*1px solid[\s\S]{0,120}box-shadow:\s*0 \d{2}px \d{2}px/,
    );
  });

  it("the allowlist is named entries with reasons, never a count", () => {
    for (const [key, why] of Object.entries(ALLOWED)) {
      expect(key, `${key} is not a page::rule pair`).toMatch(/^\/[^:]*::[a-z-]+$/);
      expect(
        why.length,
        `${key} has no real reason - "known" is not a reason`,
      ).toBeGreaterThan(30);
      expect(
        /^\d+$/.test(why.trim()),
        `${key} records a number. A count permits any N findings; only a reason ` +
          `permits a specific one.`,
      ).toBe(false);
    }
  });

  it("unlistedPairs only excuses a pair an entry names", () => {
    const rows = [
      { path: "/pricing", rule: "nested-cards", count: 14 },
      { path: "/", rule: "nested-cards", count: 8 },
    ];
    expect(unlistedPairs(rows, {})).toHaveLength(2);
    // An entry for one page must NOT excuse the same rule on another page.
    const excused = unlistedPairs(rows, { "/pricing::nested-cards": "a written reason here" });
    expect(excused.map((r) => r.path)).toEqual(["/"]);
    // An entry for a different rule on the same page excuses nothing.
    expect(unlistedPairs(rows, { "/pricing::icon-tile-stack": "x" })).toHaveLength(2);
  });

  it("scans a representative set, not the whole site", () => {
    // AC2. Small enough to run, wide enough to cover the layouts these rules
    // are about. If this grows past ~15 the run stops being cheap, which is the
    // cost half of AC1's decision.
    expect(PAGES.length).toBeGreaterThan(4);
    expect(PAGES.length).toBeLessThan(16);
    expect(PAGES).toContain("/");
    for (const p of PAGES) expect(p.startsWith("/"), `${p} is not a path`).toBe(true);
  });
});

// US-3346: the unfilled-recommended-specifics list is alphabetical, and every
// surface that showed it used to say it was eBay's demand ordering.
//
// Two halves, deliberately different instruments:
//   - the summariser is CALLED, because truncation arithmetic is logic;
//   - the surfaces are SCANNED, because a claim in the product is a sentence,
//     and where that sentence lives is exactly what a scan is good for.
// The scan half is the one that was red before the copy changed.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MISSING_SPECIFICS_ORDER_LABEL,
  MISSING_SPECIFICS_ORDER_NOTE,
  summariseMissingSpecifics,
} from "../aspect-coverage-copy";

const SRC = path.resolve(__dirname, "../..");

/**
 * Every surface that renders the unfilled-recommended-specifics list.
 *
 * Named rather than globbed on purpose: a glob that stops matching is a guard
 * that stops guarding, and this list is short enough to keep by hand. Each file
 * is asserted to still render the list, so moving the feature turns this red
 * instead of quietly emptying the corpus.
 */
const SURFACES = [
  "components/flipdesk/composer/specifics-section.tsx",
  "components/flipdesk/publish-to-ebay-dialog.tsx",
  "pages/flipdesk/autolister-drafts.tsx",
];

/**
 * Phrases that assert an ordering the census says does not exist.
 *
 * Worded to match the CLAIM, not the correction: the notes written to explain
 * this finding say "demand ranking" and "search-demand", never these, so a
 * honest correction cannot trip the guard it is correcting. (Mode 7 in
 * guards-that-do-not-guard: writing about a guard is writing input to it.)
 */
const BANNED = [
  "most-searched",
  "most searched",
  "30-day buyer search volume",
  "ranked by search volume",
  "in order) helps buyers",
];

describe("summariseMissingSpecifics", () => {
  it("shows the whole list when it fits and counts nothing", () => {
    const s = summariseMissingSpecifics(["Character", "Closure", "Fabric Type"], 6);
    expect(s.shown).toEqual(["Character", "Closure", "Fabric Type"]);
    expect(s.moreCount).toBe(0);
    expect(s.text).toBe("Character, Closure, Fabric Type");
  });

  it("counts the remainder rather than silently truncating", () => {
    // The bug this exists to stop: showing six names off an alphabetical list
    // and letting the seller read them as the six that matter.
    const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const s = summariseMissingSpecifics(names, 6);
    expect(s.shown).toHaveLength(6);
    expect(s.moreCount).toBe(4);
    expect(s.text).toBe("A, B, C, D, E, F and 4 more");
  });

  it("drops blanks and duplicates before counting", () => {
    const s = summariseMissingSpecifics(["Theme", " ", "Theme", "", "Color"], 6);
    expect(s.shown).toEqual(["Theme", "Color"]);
    expect(s.moreCount).toBe(0);
  });

  it("trims names, because a chip of whitespace is worse than no chip", () => {
    expect(summariseMissingSpecifics(["  Fabric Type  "], 6).shown).toEqual(["Fabric Type"]);
  });

  it("survives a caller with no room", () => {
    const s = summariseMissingSpecifics(["A", "B"], 0);
    expect(s.shown).toEqual([]);
    expect(s.moreCount).toBe(2);
    expect(s.text).toBe("2 unfilled");
  });

  it("says nothing when there is nothing missing", () => {
    expect(summariseMissingSpecifics([], 6)).toEqual({ shown: [], moreCount: 0, text: "" });
  });

  it("names the ordering and its reason in words a seller can check", () => {
    expect(MISSING_SPECIFICS_ORDER_LABEL).toBe("A to Z");
    // AC3: the source is named, not implied.
    expect(MISSING_SPECIFICS_ORDER_NOTE).toMatch(/eBay does not tell us/);
    expect(MISSING_SPECIFICS_ORDER_NOTE).toMatch(/A to Z/);
  });
});

describe("no surface claims an ordering eBay does not publish", () => {
  it.each(SURFACES)("%s still renders the missing-specifics list", (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), "utf8");
    // If this fails, the feature moved and SURFACES is stale — which is the
    // failure mode where the scan below passes over an empty corpus.
    expect(src).toContain("summariseMissingSpecifics");
  });

  it.each(SURFACES)("%s does not describe the list as eBay's demand ranking", (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), "utf8");
    const hits = BANNED.filter((phrase) => src.toLowerCase().includes(phrase.toLowerCase()));
    expect(
      hits,
      `${rel} tells the seller the unfilled-specifics list is ordered by how often buyers ` +
        "search each aspect. It is alphabetical: eBay sends no such signal on this tree " +
        "(src/test/aspect-demand-absent.test.ts holds the measurement).",
    ).toEqual([]);
  });
});

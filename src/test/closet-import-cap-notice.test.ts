// US-3263: the sentence a TRIMMED closet import prints.
//
// An import that brought in 25 of a seller's 200 listings and said nothing is
// worse than one that refused: the seller closes the tab believing FlipDesk has
// seen their closet, and every judgement they make about the product after that
// is made about a quarter of it.
//
// Two different bounds can trim a read and they are not the same fact:
//
//   "rows"           the flat per-read bound. A property of the free plan, the
//                    same number for everyone on it, and "we take 25 at a time"
//                    is the whole truth about it.
//   "activeListings" what is left of THIS account's live-listing cap right now.
//                    Quoting it as though it were the plan's import rule ("the
//                    free plan imports 4 at a time") is a true sentence about
//                    the wrong rule, and it changes the moment they end a
//                    listing, with nothing on screen to explain why.

import { describe, expect, it } from "vitest";
import { closetImportCapNotice } from "@/lib/lister-extension";

describe("closetImportCapNotice", () => {
  it("says nothing when the read was not trimmed", () => {
    expect(closetImportCapNotice({ free_capped: false, left_behind: 0 })).toBeNull();
    expect(closetImportCapNotice(null)).toBeNull();
    expect(closetImportCapNotice(undefined)).toBeNull();
  });

  it("says nothing when the flag is set but nothing was actually left", () => {
    // Belt and braces: a toast claiming 0 listings were left behind is noise.
    expect(closetImportCapNotice({ free_capped: true, left_behind: 0 })).toBeNull();
  });

  it("names the per-read bound when that is what bit", () => {
    const text = closetImportCapNotice({
      free_capped: true,
      free_cap: 25,
      free_cap_reason: "rows",
      left_behind: 175,
    });
    expect(text).toContain("175");
    expect(text).toContain("25 at a time");
    expect(text).toContain("FlipDesk plan");
    // It must NOT blame the listing cap, which had nothing to do with it.
    expect(text).not.toContain("live listing");
  });

  it("names the listing cap when the plan was nearly full", () => {
    const text = closetImportCapNotice({
      free_capped: true,
      free_cap: 4,
      free_cap_reason: "activeListings",
      left_behind: 56,
    });
    expect(text).toContain("56");
    expect(text).toContain("4 more");
    expect(text).toContain("live listings");
    // The wrong sentence, the one this branch exists to prevent.
    expect(text).not.toContain("imports 4 at a time");
  });

  it("uses the singular when exactly one more listing fit", () => {
    const text = closetImportCapNotice({
      free_capped: true,
      free_cap: 1,
      free_cap_reason: "activeListings",
      left_behind: 59,
    });
    expect(text).toContain("1 more live listing");
    expect(text).not.toContain("1 more live listings");
  });

  it("explains a read that brought in nothing new at all", () => {
    // The plan's listing cap is full. Rows the seller already holds still get
    // refreshed, so the run is real, but no NEW listing came in and the toast
    // must not imply one did.
    const text = closetImportCapNotice({
      free_capped: true,
      free_cap: 0,
      free_cap_reason: "activeListings",
      left_behind: 35,
    });
    expect(text).toContain("nothing new came in");
    expect(text).toContain("35");
  });

  it("falls back to the per-read wording when an older server sends no reason", () => {
    // A page newer than the edge deploy. The flat bound is the safe reading:
    // it is the only one an older server could have applied.
    const text = closetImportCapNotice({
      free_capped: true,
      free_cap: 25,
      left_behind: 10,
    });
    expect(text).toContain("25 at a time");
  });
});

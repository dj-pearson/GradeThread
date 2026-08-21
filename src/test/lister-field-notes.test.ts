// US-2730 AC5: a field the Lister tried and failed to fill has to SAY so.
//
// THE GAP. US-2730 added brand and tags, the first fields the Lister has ever
// filled beyond title and description, and made runFlow report each honestly:
// `brandFilled` and `tagsCommitted`/`tagsTotal` go into the result. Nothing read
// them. They were declared on ListerResult and consumed by no surface, so a
// brand whose selector matched nothing was exactly the silent no-op US-2477
// exists to prevent — one field along, and in the same release that introduced
// the field.
//
// The asymmetry was visible in one grep: priceFilled had priceNote() and a
// toast; brandFilled had a type declaration and a console line.
//
// These notes compose. A run can miss the price, drop photos AND fail the
// brand, and showing only the loudest hides the rest — which is the same
// reasoning priceNote and photoNote already carry.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { brandNote, tagsNote, priceNote } from "@/components/flipdesk/listing-kit";

describe("US-2730: brandNote", () => {
  it("warns when the brand was tried and missed", () => {
    const msg = brandNote({ brandFilled: false });
    expect(msg).not.toBe("");
    expect(msg.toLowerCase()).toContain("brand");
    // It has to tell the seller what to DO, not just that something happened.
    expect(msg.toLowerCase()).toContain("yourself");
  });

  it("says nothing when the brand filled", () => {
    expect(brandNote({ brandFilled: true })).toBe("");
  });

  it("says nothing when the extension did not report — undefined is not false", () => {
    // An extension built before this field sends no brandFilled at all. Reading
    // "did not say" as "did not fill" warns on every run of every older install,
    // which trains the seller to ignore the warning that means something. Same
    // rule priceNote already follows.
    expect(brandNote({})).toBe("");
    expect(brandNote({ brandFilled: undefined })).toBe("");
  });
});

describe("US-2730: tagsNote", () => {
  it("reports a PARTIAL commit, which is why this is a count and not a boolean", () => {
    // Poshmark caps tags at three. Two of three is a real outcome that neither
    // "worked" nor "failed" describes.
    const msg = tagsNote({ tagsCommitted: 2, tagsTotal: 3 });
    expect(msg).toContain("2");
    expect(msg).toContain("3");
  });

  it("reports none-committed differently from partial", () => {
    const none = tagsNote({ tagsCommitted: 0, tagsTotal: 3 });
    const some = tagsNote({ tagsCommitted: 2, tagsTotal: 3 });
    expect(none).not.toBe("");
    expect(none).not.toBe(some);
    expect(none.toLowerCase()).toContain("none");
  });

  it("says nothing when every tag landed", () => {
    expect(tagsNote({ tagsCommitted: 3, tagsTotal: 3 })).toBe("");
  });

  it("says nothing when there were no tags to add", () => {
    // No tags offered is not a failure to add tags.
    expect(tagsNote({ tagsCommitted: 0, tagsTotal: 0 })).toBe("");
  });

  it("says nothing when the extension did not report", () => {
    expect(tagsNote({})).toBe("");
    expect(tagsNote({ tagsCommitted: 2 })).toBe("");
    expect(tagsNote({ tagsTotal: 3 })).toBe("");
  });

  it("does not warn when MORE committed than offered", () => {
    // Should not happen. If it does, it is not a shortfall and warning about it
    // would be noise on top of a bug elsewhere.
    expect(tagsNote({ tagsCommitted: 4, tagsTotal: 3 })).toBe("");
  });
});

describe("US-2730: the notes compose", () => {
  it("a run that misses the price AND the brand reports both", () => {
    const res = { priceFilled: false, brandFilled: false };
    const combined = priceNote(res) + brandNote(res);
    expect(combined.toLowerCase()).toContain("price");
    expect(combined.toLowerCase()).toContain("brand");
  });

  it("a clean run says nothing at all", () => {
    const res = { priceFilled: true, brandFilled: true, tagsCommitted: 3, tagsTotal: 3 };
    expect(priceNote(res) + brandNote(res) + tagsNote(res)).toBe("");
  });

  it("the toast actually reads them", () => {
    // The whole finding was a note that existed and was never rendered. Pin the
    // call sites, or this file can pass over a surface nobody sees.
    const src = readFileSync("src/components/flipdesk/listing-kit.tsx", "utf8");
    expect(src).toContain("const brandMsg = brandNote(res);");
    expect(src).toContain("const tagsMsg = tagsNote(res);");
    // And both must reach the composed string the toast prints.
    expect(src).toMatch(/\$\{brandMsg\}/);
    expect(src).toMatch(/\$\{tagsMsg\}/);
  });
});

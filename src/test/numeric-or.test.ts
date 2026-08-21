// US-2740: a numeric string is read as a zero, so a draft with a price shows none.
//
// WHY THIS FILE EXISTS SEPARATELY FROM cross-post-setup.test.ts.
//
// That suite already "covers" numericOr, in the sense that it asserts the
// function's NAME appears in listing-kit.tsx and that the call sites are spelled
// a particular way:
//
//   expect(src).toContain("function numericOr(")
//   expect(src).toContain("price: numericOr(raw.price, 0)")
//
// Those are source scans. They cannot see behaviour, and they were the only
// thing holding this fix. Sabotaged three ways — reverting the body to the exact
// strict `typeof value === "number"` check that CAUSED the original bug, letting
// junk strings coerce instead of falling back, and treating an empty string as a
// number — all three sailed through with 50 tests green, because the name and
// the call sites never moved.
//
// One of those tests even re-implements the rule locally and asserts against the
// copy:
//
//   const first = (a) => a.find((p) => p != null && p > 0) ?? 0
//
// which tests the mirror, not the code.
//
// So this file calls the real function. The source assertions in the other suite
// stay — they pin the CALL SITES, which is a different and also useful thing —
// but the behaviour is held here.

import { describe, expect, it } from "vitest";
import { numericOr } from "@/components/flipdesk/listing-kit";

describe("US-2740: numericOr", () => {
  it("reads a numeric STRING as a number — the actual bug", () => {
    // PostgREST returns a Postgres `numeric` as a string so precision survives
    // the JSON round trip. The row really did hold 32.49 and every surface
    // showed nothing.
    expect(numericOr("32.49", 0)).toBe(32.49);
    expect(numericOr("19", 0)).toBe(19);
    expect(numericOr("0.5", 0)).toBe(0.5);
  });

  it("reads a number as itself", () => {
    expect(numericOr(32.49, 0)).toBe(32.49);
    expect(numericOr(0, 7)).toBe(0);
    expect(numericOr(-5, 0)).toBe(-5);
  });

  it("refuses junk rather than coercing it — a price is money", () => {
    // The seven cases AC5 pins. Each of these is something JavaScript would
    // happily turn into a number if asked loosely, and each would end up on a
    // live listing.
    expect(numericOr("", 0)).toBe(0);
    expect(numericOr("   ", 0)).toBe(0);
    expect(numericOr("TBD", 0)).toBe(0);
    expect(numericOr(null, 0)).toBe(0);
    expect(numericOr(undefined, 0)).toBe(0);
    expect(numericOr(Number.NaN, 0)).toBe(0);
    expect(numericOr({}, 0)).toBe(0);
    expect(numericOr([], 0)).toBe(0);
  });

  it("refuses a non-finite number", () => {
    expect(numericOr(Number.POSITIVE_INFINITY, 0)).toBe(0);
    expect(numericOr(Number.NEGATIVE_INFINITY, 0)).toBe(0);
  });

  it("an empty or blank string falls back, and 0 cannot prove it", () => {
    // WHY THE FALLBACK IS NON-ZERO HERE. Number("") is 0 and Number("   ") is 0,
    // both finite — so with a fallback of 0, dropping the `value.trim() !== ""`
    // guard returns 0 either way and the assertion cannot tell. Sabotaging that
    // guard passed a version of this file that only ever checked against 0.
    expect(numericOr("", 99)).toBe(99);
    expect(numericOr("   ", 99)).toBe(99);
    // A tab, built without an escape sequence: writing "	" through this
    // toolchain has produced a literal tab in the source more than once.
    expect(numericOr(String.fromCharCode(9, 10), 99)).toBe(99);
  });

  it("returns the fallback it was given, not a hard-coded zero", () => {
    // The call sites all pass 0 today. A test that only ever checks for 0 cannot
    // tell "returned the fallback" from "returned zero".
    expect(numericOr("nope", 99)).toBe(99);
    expect(numericOr(null, -1)).toBe(-1);
  });

  it("the two comparisons that disagreed now agree", () => {
    // THE ROOT OF THE INCONSISTENCY. '32.49' > 0 is TRUE by coercion, while
    // typeof '32.49' === 'number' is FALSE. So one real price read as present in
    // one comparison and absent in the next, in the same render.
    const raw: unknown = "32.49";
    const asPresent = numericOr(raw, 0) > 0;
    const asValue = numericOr(raw, 0);
    expect(asPresent).toBe(true);
    expect(asValue).toBe(32.49);
  });

  it("first POSITIVE price wins, over a mixed list of the shapes prod returns", () => {
    // The real call site: [a, b, c].map((p) => numericOr(p, 0)).find((p) => p > 0)
    const firstPositive = (prices: unknown[]) =>
      prices.map((p) => numericOr(p, 0)).find((p) => p > 0) ?? 0;

    expect(firstPositive(["32.49", 19, 5])).toBe(32.49);
    expect(firstPositive([0, null, "24.99"])).toBe(24.99);
    expect(firstPositive([null, null, "32.49"])).toBe(32.49);
    expect(firstPositive([null, 0, null])).toBe(0);
    // A stale 0 on a draft row must not shadow a real price further down.
    expect(firstPositive(["0", "0", "18.00"])).toBe(18);
    // And junk in the list does not stop a later real price being found.
    expect(firstPositive(["TBD", "", "12.50"])).toBe(12.5);
  });
});

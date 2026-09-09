import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDate } from "@/lib/import-mapping";

// US-3247. parseDate's full-date branch read the UTC calendar day off a Date
// that had been parsed as LOCAL midnight. "Jan 25, 2026" therefore came back as
// 2026-01-24 for every seller ahead of UTC -- British Summer Time through
// UTC+13. The US is behind UTC, which is exactly why it survived: the dates
// only moved for sellers nobody here was testing as.
//
// It matters because these are acquisition and sale dates on imported
// inventory, and they feed the P&L, the fiscal-year window and the tax packet.
// A 1 January purchase imported from Vendoo or List Perfectly could land in the
// previous tax year.
//
// BE HONEST ABOUT WHAT THESE PROVE. The behavioural cases below pass against
// the BROKEN code on this machine and on CI, because both run behind or at UTC.
// They are still worth having -- they pin the contract and they would fail on a
// UTC+X runner -- but the assertion that actually holds the fix in place is the
// source check at the bottom.

describe("an imported date keeps the day the seller typed (US-3247)", () => {
  it("reads a named date as that calendar day", () => {
    expect(parseDate("Jan 25, 2026")).toBe("2026-01-25");
    expect(parseDate("25 January 2026")).toBe("2026-01-25");
  });

  it("reads a bare ISO date unchanged", () => {
    // This one was never wrong: a bare ISO string parses as UTC midnight, so
    // the UTC day and the intended day already agreed.
    expect(parseDate("2026-01-25")).toBe("2026-01-25");
  });

  it("keeps 1 January in the year it was typed", () => {
    // The failure that costs money: an acquisition on the first day of a tax
    // year importing into the previous one.
    expect(parseDate("Jan 1, 2026")).toBe("2026-01-01");
    expect(parseDate("2026-01-01")).toBe("2026-01-01");
  });

  it("still rejects what it rejected before", () => {
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate("")).toBeNull();
  });

  it("no longer takes the UTC day off a locally-parsed Date", () => {
    // The load-bearing assertion. A behavioural test cannot fail here, so this
    // is what stops the one-liner coming back.
    const src = readFileSync(resolve(process.cwd(), "src/lib/import-mapping.ts"), "utf8");
    const at = src.indexOf("Full date strings that carry an explicit year");
    expect(at, "the branch comment moved — re-point this guard").toBeGreaterThan(-1);
    const branch = src.slice(at, at + 2200);
    expect(branch).toContain("toLocalDate(d)");
    // `new Date(s)` is still fine and still there; reading .toISOString() off
    // it is the defect.
    expect(branch).not.toMatch(/d\.toISOString\(\)/);
    // And the other half. Reading the LOCAL day off EVERYTHING is the same
    // mistake mirrored -- a date-only ISO string parses as UTC midnight, so its
    // local day is the day before across the whole of the Americas. The
    // passthrough is what stops the fix becoming a bigger bug than the bug.
    expect(branch).toMatch(/date-only|dateOnly/);
  });
});

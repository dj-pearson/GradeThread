import { describe, it, expect } from "vitest";
import { parseDate } from "@/lib/import-mapping";

// Fixed reference so year-inference for bare "M/D" values is deterministic.
const REF = new Date("2026-06-01T12:00:00Z");

describe("parseDate", () => {
  it("parses full ISO dates", () => {
    expect(parseDate("2026-01-18")).toBe("2026-01-18");
  });

  it("parses explicit M/D/YYYY and M/D/YY", () => {
    expect(parseDate("1/25/2026")).toBe("2026-01-25");
    expect(parseDate("1/25/26")).toBe("2026-01-25");
    expect(parseDate("01-25-2026")).toBe("2026-01-25");
  });

  // Regression: a year-less "M/D" used to hit `new Date("1/25")` which V8
  // resolves to 2001-01-25, producing absurd days_to_sell. It must now infer
  // the most recent occurrence at or before the reference date.
  it("infers the current year for bare M/D at or before the reference date", () => {
    expect(parseDate("1/25", REF)).toBe("2026-01-25");
    expect(parseDate("2/2", REF)).toBe("2026-02-02");
    expect(parseDate("3/11", REF)).toBe("2026-03-11");
    expect(parseDate("1/25", REF)).not.toContain("2001");
  });

  it("rolls a bare M/D that is still ahead of the reference back to last year", () => {
    // Dec 30 is after Jun 1, 2026 → most recent occurrence is 2025-12-30.
    expect(parseDate("12/30", REF)).toBe("2025-12-30");
  });

  it("rejects impossible calendar dates", () => {
    expect(parseDate("2/30", REF)).toBeNull();
    expect(parseDate("13/40", REF)).toBeNull();
  });

  it("returns null for empty/garbage", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
  });
});

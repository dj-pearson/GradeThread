import { describe, it, expect } from "vitest";
import { todayLocalDate, toLocalDate } from "@/lib/local-date";

// US-1636: date-only defaults must reflect the user's LOCAL calendar day, not
// UTC (an evening user west of UTC would otherwise record tomorrow's date).
describe("local-date helpers", () => {
  it("todayLocalDate returns a YYYY-MM-DD string", () => {
    expect(todayLocalDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("toLocalDate formats an instant as YYYY-MM-DD", () => {
    expect(toLocalDate("2026-03-15T12:00:00Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches the local calendar day (en-CA), not the UTC date", () => {
    const d = new Date();
    const expected = d.toLocaleDateString("en-CA");
    expect(todayLocalDate()).toBe(expected);
    expect(toLocalDate(d)).toBe(expected);
  });
});

// SUB-08: set before anything reads the clock. Node re-reads TZ when the env
// var is assigned, so every Date below is Los Angeles local time.
process.env.TZ = "America/Los_Angeles";

import { describe, it, expect } from "vitest";
import { localDayRangeIso, sanitizeSearch } from "@/lib/search-filter";
import { applySubmissionFilters, NO_SUBMISSION_FILTERS } from "@/lib/submission-list-query";

function inRange(iso: string, r: { gte?: string; lt?: string }): boolean {
  const t = Date.parse(iso);
  return (!r.gte || t >= Date.parse(r.gte)) && (!r.lt || t < Date.parse(r.lt));
}

describe("local-day date range (SUB-08)", () => {
  it("runs in Los Angeles", () => {
    expect(new Date("2026-09-30T18:00:00").getTimezoneOffset()).toBe(420);
  });

  it("a 6pm Sep 30 row is inside a Sep 30 to Sep 30 range", () => {
    const sixPm = new Date("2026-09-30T18:00:00").toISOString(); // 2026-10-01T01:00Z
    const range = localDayRangeIso("2026-09-30", "2026-09-30");
    expect(inRange(sixPm, range)).toBe(true);
    // The old UTC end bound dropped it.
    expect(Date.parse(sixPm) <= Date.parse("2026-09-30T23:59:59.999Z")).toBe(false);
  });

  it("excludes the local days either side", () => {
    const range = localDayRangeIso("2026-09-30", "2026-09-30");
    expect(inRange(new Date("2026-09-29T23:59:00").toISOString(), range)).toBe(false);
    expect(inRange(new Date("2026-10-01T00:00:00").toISOString(), range)).toBe(false);
    expect(inRange(new Date("2026-09-30T00:00:00").toISOString(), range)).toBe(true);
  });

  it("the list uses gte and lt, not lte", () => {
    const calls: string[] = [];
    const q = {
      eq: () => q,
      or: () => q,
      gte: (c: string, v: string) => (calls.push(`gte ${c} ${v}`), q),
      lt: (c: string, v: string) => (calls.push(`lt ${c} ${v}`), q),
    };
    applySubmissionFilters(q, { ...NO_SUBMISSION_FILTERS, dateFrom: "2026-09-30", dateTo: "2026-09-30" });
    expect(calls).toEqual([
      "gte created_at 2026-09-30T07:00:00.000Z",
      "lt created_at 2026-10-01T07:00:00.000Z",
    ]);
  });
});

describe("search wildcards are escaped (SUB-08)", () => {
  it("escapes LIKE wildcards and the backslash", () => {
    expect(sanitizeSearch("levi_s")).toBe("levi\\_s");
    expect(sanitizeSearch("50%")).toBe("50\\%");
    expect(sanitizeSearch("a\\b")).toBe("a\\\\b");
  });

  it("strips double quotes, which PostgREST reads as value quoting", () => {
    expect(sanitizeSearch('"vintage"')).toBe("vintage");
    expect(sanitizeSearch('levi\'s "501"')).toBe("levi's  501");
  });
});

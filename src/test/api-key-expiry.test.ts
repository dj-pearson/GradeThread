// DEV-07: a key's expiry is the END of the chosen day where the seller is, and
// the date picker's minimum is tomorrow in local time, not in UTC.
import { afterEach, describe, expect, it, vi } from "vitest";
import { endOfLocalDayIso, localYmd } from "@/lib/utils";

const originalTz = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

describe("key expiry dates (America/Chicago)", () => {
  it("'2026-09-30' becomes Sep 30 at 23:59:59 local", () => {
    process.env.TZ = "America/Chicago";
    const iso = endOfLocalDayIso("2026-09-30")!;
    const d = new Date(iso);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 9, 30]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([23, 59, 59]);
    // 23:59:59 CDT is 04:59:59 the next day in UTC.
    expect(iso).toBe("2026-10-01T04:59:59.000Z");
  });

  it("at 21:00 local the minimum pickable date is tomorrow's LOCAL date", () => {
    process.env.TZ = "America/Chicago";
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 25, 21, 0, 0)); // Sep 25, 21:00 local = Sep 26 UTC
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(localYmd(tomorrow)).toBe("2026-09-26");
    // The UTC slice this replaced would have said the 27th.
    expect(tomorrow.toISOString().slice(0, 10)).toBe("2026-09-27");
  });

  it("rejects a value that is not a calendar date", () => {
    expect(endOfLocalDayIso("")).toBeNull();
    expect(endOfLocalDayIso("2026-02-30")).toBeNull();
    expect(endOfLocalDayIso("09/30/2026")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  DROP_PRESETS,
  nextPresetUtc,
  zonedWallTimeToUtc,
  isoToZonedInput,
  zonedInputToIso,
  formatInZone,
} from "./scheduling";

describe("zonedWallTimeToUtc", () => {
  it("converts a winter (CST, UTC-6) wall time to UTC", () => {
    // 2026-01-04 19:00 in Chicago = 2026-01-05 01:00 UTC.
    const utc = zonedWallTimeToUtc(2026, 1, 4, 19, 0, "America/Chicago");
    expect(utc.toISOString()).toBe("2026-01-05T01:00:00.000Z");
  });

  it("converts a summer (CDT, UTC-5) wall time to UTC — DST aware", () => {
    // 2026-06-14 19:00 in Chicago = 2026-06-15 00:00 UTC.
    const utc = zonedWallTimeToUtc(2026, 6, 14, 19, 0, "America/Chicago");
    expect(utc.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("treats UTC wall time as identity", () => {
    const utc = zonedWallTimeToUtc(2026, 6, 14, 19, 0, "UTC");
    expect(utc.toISOString()).toBe("2026-06-14T19:00:00.000Z");
  });
});

describe("nextPresetUtc", () => {
  const sun7 = DROP_PRESETS.find((p) => p.id === "sun-7pm")!;

  it("returns the next Sunday 7 PM in the target zone, strictly in the future", () => {
    // Thursday 2026-06-11 in Chicago — next Sunday is 2026-06-14.
    const from = new Date("2026-06-11T15:00:00Z");
    const next = nextPresetUtc(sun7, "America/Chicago", from);
    // 2026-06-14 19:00 CDT = 2026-06-15 00:00 UTC.
    expect(next.toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  it("rolls to the following week when this week's slot has passed", () => {
    // It is already Sunday 2026-06-15 01:00 UTC = 8 PM CDT (past 7 PM) — skip.
    const from = new Date("2026-06-15T01:00:00Z");
    const next = nextPresetUtc(sun7, "America/Chicago", from);
    expect(next.toISOString()).toBe("2026-06-22T00:00:00.000Z");
  });

  it("lands on the target weekday in the chosen zone", () => {
    const from = new Date("2026-06-11T15:00:00Z");
    const next = nextPresetUtc(sun7, "America/New_York", from);
    const weekdayInZone = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
    }).format(next);
    expect(weekdayInZone).toBe("Sunday");
  });

  it("handles a day-agnostic preset (next occurrence of the time)", () => {
    const tonight = DROP_PRESETS.find((p) => p.id === "tonight-7pm")!;
    const from = new Date("2026-06-11T15:00:00Z"); // 10:00 CDT, before 7 PM
    const next = nextPresetUtc(tonight, "America/Chicago", from);
    // Same day 7 PM CDT = 2026-06-12 00:00 UTC.
    expect(next.toISOString()).toBe("2026-06-12T00:00:00.000Z");
  });
});

describe("isoToZonedInput / zonedInputToIso round-trip", () => {
  it("round-trips through a non-browser timezone", () => {
    const iso = "2026-06-15T00:00:00.000Z";
    const local = isoToZonedInput(iso, "America/Chicago");
    expect(local).toBe("2026-06-14T19:00");
    expect(zonedInputToIso(local, "America/Chicago")).toBe(iso);
  });

  it("returns empty/null for blank input", () => {
    expect(isoToZonedInput(null, "UTC")).toBe("");
    expect(zonedInputToIso("", "UTC")).toBeNull();
  });
});

describe("formatInZone", () => {
  it("renders a friendly label in the target zone", () => {
    const out = formatInZone("2026-06-15T00:00:00.000Z", "America/Chicago");
    expect(out).toContain("Jun 14");
    expect(out).toContain("7:00");
  });

  it("handles invalid input gracefully", () => {
    expect(formatInZone("not-a-date", "UTC")).toBe("—");
  });
});

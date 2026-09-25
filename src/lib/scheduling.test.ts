import { describe, it, expect } from "vitest";
import {
  DROP_PRESETS,
  nextPresetUtc,
  zonedWallTimeToUtc,
  isoToZonedInput,
  zonedInputToIso,
  formatInZone,
  assertFutureDrop,
  dropHealth,
  MAX_SCHEDULED_PUBLISH_ATTEMPTS,
  PUBLISH_CLAIM_STALE_MS,
  shiftInZone,
  zonedInputToIsoDetailed,
  getFormatter,
  formatTimeInZone,
  spreadTimes,
  orderForSpread,
  bestDropSlots,
} from "./scheduling";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

describe("assertFutureDrop (SD-2)", () => {
  const NOW = Date.parse("2026-09-25T12:00:00Z");
  it("rejects a time inside the cron's five-minute window", () => {
    const r = assertFutureDrop(new Date(NOW + 60_000).toISOString(), NOW);
    expect(r.ok).toBe(false);
  });
  it("rejects a past time with the seller-facing reason", () => {
    const r = assertFutureDrop(new Date(NOW - 60_000).toISOString(), NOW);
    expect(r).toEqual({ ok: false, reason: "That time has passed. Pick a later time." });
  });
  it("accepts a time ten minutes out", () => {
    expect(assertFutureDrop(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toEqual({ ok: true });
  });
  it("rejects junk", () => {
    expect(assertFutureDrop("nope", NOW).ok).toBe(false);
  });
});

describe("dropHealth (SD-3)", () => {
  const NOW = Date.parse("2026-09-25T12:00:00Z");
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  const base = { scheduled_publish_at: at(3_600_000) };

  it("a future drop with no history is scheduled", () => {
    expect(dropHealth(base, NOW)).toBe("scheduled");
  });
  it("a fresh claim reads as publishing", () => {
    expect(dropHealth({ ...base, publish_claimed_at: at(-60_000) }, NOW)).toBe("publishing");
  });
  it("a fresh claim whose attempt already failed is not publishing", () => {
    // The cron's failure patch does not clear publish_claimed_at.
    expect(
      dropHealth(
        {
          scheduled_publish_at: at(-2 * 60_000),
          publish_claimed_at: at(-90_000),
          publish_failed_at: at(-30_000),
          publish_attempts: 1,
          publish_error: "Missing item specific",
        },
        NOW,
      ),
    ).toBe("retrying");
  });
  it("a new claim taken after an earlier failure is publishing again", () => {
    expect(
      dropHealth(
        {
          ...base,
          publish_claimed_at: at(-30_000),
          publish_failed_at: at(-6 * 60_000),
          publish_attempts: 2,
          publish_error: "x",
        },
        NOW,
      ),
    ).toBe("publishing");
  });
  it("a stale claim does not", () => {
    expect(dropHealth({ ...base, publish_claimed_at: at(-11 * 60_000) }, NOW)).toBe("scheduled");
  });
  it("an attempt with an error reads as retrying", () => {
    expect(
      dropHealth({ ...base, publish_attempts: 3, publish_error: "Missing item specific" }, NOW),
    ).toBe("retrying");
  });
  it("a drop more than ten minutes past with no fresh claim is overdue", () => {
    expect(dropHealth({ scheduled_publish_at: at(-11 * 60_000) }, NOW)).toBe("overdue");
    expect(dropHealth({ scheduled_publish_at: at(-2 * 60_000) }, NOW)).toBe("scheduled");
  });
  it("a synced row or an exhausted budget is blocked", () => {
    expect(dropHealth({ ...base, synced_to_ebay_at: at(-1) }, NOW)).toBe("blocked");
    expect(dropHealth({ ...base, publish_attempts: 5, publish_error: "x" }, NOW)).toBe("blocked");
  });
});

describe("the client mirrors the cron's constants (SD-3)", () => {
  const edge = (rel: string) =>
    readFileSync(resolve(process.cwd(), "services/edge-functions/src", rel), "utf8");

  it("MAX_SCHEDULED_PUBLISH_ATTEMPTS matches publish-due-policy.ts", () => {
    const m = /export const MAX_SCHEDULED_PUBLISH_ATTEMPTS = (\d+);/.exec(
      edge("lib/publish-due-policy.ts"),
    );
    expect(m, "constant not found in the edge policy file").not.toBeNull();
    expect(Number(m![1])).toBe(MAX_SCHEDULED_PUBLISH_ATTEMPTS);
  });

  it("PUBLISH_CLAIM_STALE_MS matches the publish-due route", () => {
    const m = /const PUBLISH_CLAIM_STALE_MS = (\d+) \* 60_000;/.exec(
      edge("routes/flipdesk-ebay-publish-due.ts"),
    );
    expect(m, "constant not found in the publish-due route").not.toBeNull();
    expect(Number(m![1]) * 60_000).toBe(PUBLISH_CLAIM_STALE_MS);
  });
});

describe("shiftInZone keeps the wall-clock hour across DST (SD-6)", () => {
  const CHI = "America/Chicago";
  it("+1 day across fall-back lands on the same 7:00 PM", () => {
    const iso = zonedInputToIso("2026-10-31T19:00", CHI)!;
    const out = shiftInZone(iso, CHI, { days: 1 });
    expect(isoToZonedInput(out, CHI)).toBe("2026-11-01T19:00");
    // 25 hours of absolute time, not 24.
    expect(Date.parse(out) - Date.parse(iso)).toBe(25 * 3_600_000);
  });
  it("+1 day across spring-forward lands on the same 7:00 PM", () => {
    const iso = zonedInputToIso("2026-03-07T19:00", CHI)!;
    const out = shiftInZone(iso, CHI, { days: 1 });
    expect(isoToZonedInput(out, CHI)).toBe("2026-03-08T19:00");
    expect(Date.parse(out) - Date.parse(iso)).toBe(23 * 3_600_000);
  });
  it("-1 day walks back the same way", () => {
    const iso = zonedInputToIso("2026-11-01T19:00", CHI)!;
    expect(isoToZonedInput(shiftInZone(iso, CHI, { days: -1 }), CHI)).toBe("2026-10-31T19:00");
  });
  it("minutes are absolute time", () => {
    const iso = "2026-06-15T00:00:00.000Z";
    expect(shiftInZone(iso, CHI, { minutes: 60 })).toBe("2026-06-15T01:00:00.000Z");
  });
});

describe("DST gaps, overlaps and impossible dates (SD-7)", () => {
  it("a Chicago spring-forward gap time moves forward by the gap", () => {
    const iso = zonedInputToIso("2026-03-08T02:30", "America/Chicago")!;
    expect(isoToZonedInput(iso, "America/Chicago")).toBe("2026-03-08T03:30");
    expect(zonedInputToIsoDetailed("2026-03-08T02:30", "America/Chicago")?.adjusted).toBe("gap");
  });
  it("a London spring-forward gap time moves forward by the gap", () => {
    const iso = zonedInputToIso("2026-03-29T01:30", "Europe/London")!;
    expect(isoToZonedInput(iso, "Europe/London")).toBe("2026-03-29T02:30");
  });
  it("a Sydney spring-forward gap time moves forward too", () => {
    const iso = zonedInputToIso("2026-10-04T02:30", "Australia/Sydney")!;
    expect(isoToZonedInput(iso, "Australia/Sydney")).toBe("2026-10-04T03:30");
  });
  it("a Chicago fall-back time takes the earlier instant", () => {
    expect(zonedInputToIso("2026-11-01T01:30", "America/Chicago")).toBe("2026-11-01T06:30:00.000Z");
    expect(zonedInputToIsoDetailed("2026-11-01T01:30", "America/Chicago")?.adjusted).toBe("overlap");
  });
  it("a London fall-back time takes the earlier instant", () => {
    expect(zonedInputToIso("2026-10-25T01:30", "Europe/London")).toBe("2026-10-25T00:30:00.000Z");
  });
  it("an ordinary time is not flagged", () => {
    expect(zonedInputToIsoDetailed("2026-06-14T19:00", "America/Chicago")).toEqual({
      iso: "2026-06-15T00:00:00.000Z",
      adjusted: null,
    });
  });
  it("rejects impossible dates and times instead of rolling them over", () => {
    for (const v of ["2026-02-30T10:00", "2026-13-01T10:00", "2026-00-10T10:00", "2026-06-01T24:00", "2026-06-01T10:60", "2026-06-00T10:00"]) {
      expect(zonedInputToIso(v, "America/Chicago"), v).toBeNull();
    }
    expect(zonedInputToIso("2028-02-29T10:00", "UTC")).toBe("2028-02-29T10:00:00.000Z");
  });
  it("a 2:30 AM Sunday preset in Chicago's spring-forward week lands at 3:30", () => {
    const preset = { id: "x", label: "Sunday 2:30 AM", weekday: 0, hour: 2, minute: 30 };
    const next = nextPresetUtc(preset, "America/Chicago", new Date("2026-03-05T12:00:00Z"));
    expect(isoToZonedInput(next.toISOString(), "America/Chicago")).toBe("2026-03-08T03:30");
  });
});

describe("getFormatter (SD-13)", () => {
  it("returns the same instance for repeated (kind, zone) calls", () => {
    expect(getFormatter("time", "America/Chicago")).toBe(getFormatter("time", "America/Chicago"));
    expect(getFormatter("time", "America/Chicago")).not.toBe(getFormatter("time", "UTC"));
    expect(getFormatter("date", "UTC")).not.toBe(getFormatter("time", "UTC"));
  });
  it("formats a clock time in the zone", () => {
    expect(formatTimeInZone("2026-06-15T00:00:00.000Z", "America/Chicago")).toBe("7:00 PM");
    expect(formatTimeInZone("junk", "UTC")).toBe("-");
  });
});

describe("spreadTimes and orderForSpread (SD-14)", () => {
  it("spreads three drops ten minutes apart from the start", () => {
    const T = "2026-10-04T00:00:00.000Z";
    expect(spreadTimes(3, T, 10)).toEqual([
      "2026-10-04T00:00:00.000Z",
      "2026-10-04T00:10:00.000Z",
      "2026-10-04T00:20:00.000Z",
    ]);
    expect(spreadTimes(0, T, 10)).toEqual([]);
    expect(spreadTimes(2, "junk", 10)).toEqual([]);
  });

  const drops = [
    { id: "a", scheduled_publish_at: "2026-10-04T00:00:00Z", listing_price: 20, promoted: false },
    { id: "b", scheduled_publish_at: "2026-10-04T00:05:00Z", listing_price: 80, promoted: true },
    { id: "c", scheduled_publish_at: "2026-10-03T23:00:00Z", listing_price: 80, promoted: false },
  ];
  it("current order is time order", () => {
    expect(orderForSpread(drops, "current").map((d) => d.id)).toEqual(["c", "a", "b"]);
  });
  it("price high to low keeps time order on ties", () => {
    expect(orderForSpread(drops, "price").map((d) => d.id)).toEqual(["c", "b", "a"]);
  });
  it("promoted first", () => {
    expect(orderForSpread(drops, "promoted").map((d) => d.id)).toEqual(["b", "c", "a"]);
  });
});

describe("bestDropSlots (SD-15)", () => {
  const CHI = "America/Chicago";
  // Sunday 2026-06-14 19:xx CDT, and a scatter of other hours.
  const sundaySeven = (i: number) => zonedInputToIso(`2026-0${6 + (i % 3)}-${["14", "12", "09"][i % 3]}T19:${String(10 + (i % 40)).padStart(2, "0")}`, CHI)!;

  it("returns null under the sample floor", () => {
    expect(bestDropSlots(Array.from({ length: 10 }, (_, i) => sundaySeven(i)), CHI)).toBeNull();
  });

  it("puts Sunday 7 PM first for sales clustered there", () => {
    const sales = Array.from({ length: 40 }, (_, i) =>
      i < 30 ? sundaySeven(i) : zonedInputToIso(`2026-06-1${i % 5}T${10 + (i % 5)}:15`, CHI)!,
    );
    const slots = bestDropSlots(sales, CHI)!;
    expect(slots).not.toBeNull();
    expect(slots[0]).toMatchObject({ weekday: 0, hour: 19, minute: 0, label: "Sunday 7 PM" });
    expect(slots[0]!.hint).toBe("You sold 30 items in this hour");
    expect(slots.length).toBeLessThanOrEqual(3);
  });

  it("ignores day-only stamps at 00:00:00Z", () => {
    const dayOnly = Array.from({ length: 40 }, (_, i) => `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`);
    expect(bestDropSlots(dayOnly, CHI)).toBeNull();
  });
});

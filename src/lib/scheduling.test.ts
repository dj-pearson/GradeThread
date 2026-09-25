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

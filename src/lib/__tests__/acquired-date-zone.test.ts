import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acquiredDateZoneFor } from "@/lib/acquired-date-zone";

// US-3314. The owner's decision was to correct FORWARD: leave the rows written
// before 2026-09-20 alone, and record the zone from here on so a future repair
// has something to reconstruct from. That decision is only worth anything if
// every writer keeps doing it, and a writer that quietly stops looks exactly
// like a writer that never started -- the column is nullable and NULL is a
// legitimate value, so nothing else in the stack would report it.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every web file that writes inventory_items.acquired_date. */
const WRITERS = [
  "src/lib/composer-save.ts",
  "src/pages/flipdesk/intake.tsx",
  "src/components/flipdesk/bulk-intake.tsx",
  "src/components/flipdesk/snap-catalog.tsx",
];

describe("acquiredDateZoneFor", () => {
  it("returns a zone for a real day", () => {
    const zone = acquiredDateZoneFor("2026-09-20");
    expect(typeof zone).toBe("string");
    expect(zone).not.toBe("");
  });

  it("returns null when there is no day, so a row cannot claim one", () => {
    // A zone beside a null date would say the day was named somewhere. It was
    // not, and a repair reading that pair would have nothing to correct.
    expect(acquiredDateZoneFor(null)).toBeNull();
    expect(acquiredDateZoneFor(undefined)).toBeNull();
    expect(acquiredDateZoneFor("")).toBeNull();
    expect(acquiredDateZoneFor("   ")).toBeNull();
  });
});

describe("every acquired_date writer records the zone (US-3314)", () => {
  it("finds the writers at all, so a clean result cannot be vacuous", () => {
    // Guards the guard: a renamed or moved file would empty the scan below and
    // every assertion in it would pass on nothing.
    for (const file of WRITERS) {
      expect(read(file), `${file} no longer writes acquired_date`).toMatch(
        /acquired_date\b/,
      );
    }
  });

  it("each one calls the shared helper beside the day", () => {
    for (const file of WRITERS) {
      const src = read(file);
      expect(
        src,
        `${file} writes acquired_date without acquired_date_tz. A day with no ` +
          "zone is a day the future repair may not touch, so a writer that " +
          "stops recording it silently shrinks what can ever be corrected.",
      ).toMatch(/acquired_date_tz/);
      expect(
        src,
        `${file} should get the zone from acquiredDateZoneFor, not from its own ` +
          "Intl call: the null-day rule lives in that helper and a hand-rolled " +
          "copy would write a zone onto a row with no date.",
      ).toMatch(/acquiredDateZoneFor\(/);
    }
  });

  it("nobody hand-rolls the zone lookup at a write site", () => {
    for (const file of WRITERS) {
      expect(
        read(file),
        `${file} calls Intl.DateTimeFormat().resolvedOptions() directly`,
      ).not.toMatch(/resolvedOptions\(\)\s*\.\s*timeZone/);
    }
  });
});

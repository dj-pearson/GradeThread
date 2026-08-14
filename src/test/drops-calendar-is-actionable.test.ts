import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isoToZonedInput, zonedInputToIso } from "@/lib/scheduling";

// US-2522. The scheduled-drops calendar was a picture of the schedule: every
// interaction was a link into a draft, so moving three drops by an hour meant
// opening three drafts and typing six times. A busy day overflowed its cell,
// the grid was not a grid to a screen reader, and "Upcoming" stopped dead at 12
// with nothing saying so.

const PAGE = "src/pages/flipdesk/scheduled-drops.tsx";
const DIALOG = "src/components/flipdesk/drop-day-dialog.tsx";
const HOOK = "src/hooks/use-scheduled-drops.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("a drop can be changed from the calendar (US-2522)", () => {
  it("the page opens a day rather than only linking into drafts", () => {
    const src = read(PAGE);
    expect(src).toContain("<DropDayDialog");
    expect(src).toMatch(/function openDay\(day: number\)/);
    // A cell with drops is clickable and answers the keyboard.
    expect(src).toMatch(/onClick=\{\(\) => dayDrops\.length > 0 && openDay\(cell\.day\)\}/);
    expect(src).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
  });

  it("the dialog offers reschedule, unschedule and a whole-day shift", () => {
    const src = read(DIALOG);
    expect(src).toContain("Reschedule");
    expect(src).toContain("Unschedule");
    expect(src).toContain("Shift the whole day");
    expect(src).toMatch(/useRescheduleDrop\(\)/);
    expect(src).toMatch(/useCancelDrop\(\)/);
    expect(src).toMatch(/useShiftDrops\(\)/);
  });

  it("unscheduling clears the time and leaves the draft alone", () => {
    const src = read(HOOK);
    expect(src).toMatch(/scheduled_publish_at: null/);
    // Only a draft is schedulable, so only a draft may be moved from here.
    expect(src).toMatch(/\.eq\("listing_status", "draft"\)/);
    // US-1552: `.or()` on a mutation is rejected by the production PostgREST
    // and accepted by the newer local stack, so CI cannot catch it. Comments
    // stripped first — the file explains the rule, and an explanation of a ban
    // must not read as a violation of it.
    const code = src
      .replace(/(^|\s)\/\/[^\n]*/g, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\.or\(/);
  });

  it("a shift moves each drop relative to its own time", () => {
    const src = read(HOOK);
    // Not "set them all to X" — the gaps between a day's staggered drops are
    // the whole reason someone staggered them.
    expect(src).toMatch(
      /new Date\(d\.scheduled_publish_at\)\.getTime\(\) \+ minutes \* 60_000/,
    );
  });
});

describe("the calendar reads as a calendar (US-2522)", () => {
  it("the grid is announced and traversable", () => {
    const src = read(PAGE);
    expect(src).toMatch(/role="grid"/);
    expect(src).toMatch(/role="columnheader"/);
    expect(src).toMatch(/role="gridcell"/);
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(src, `${key} does not move the cursor`).toContain(key);
    }
    // A roving tabstop, not 35 tab stops.
    expect(src).toMatch(/tabIndex=\{cell\.day === focusedDay \? 0 : -1\}/);
    // And real focus follows it, or the arrows move a highlight nothing announces.
    expect(src).toMatch(/focusedCellRef\.current\?\.focus\(\)/);
  });

  it("a busy day collapses instead of overflowing", () => {
    const src = read(PAGE);
    expect(src).toMatch(/const VISIBLE_PER_DAY = \d+/);
    expect(src).toMatch(/dayDrops\.slice\(0, VISIBLE_PER_DAY\)/);
    expect(src).toMatch(/\+\{hidden\} more/);
  });

  it("Upcoming is no longer a silent cap at 12", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/drops\.slice\(0, 12\)/);
    expect(src).toMatch(/showAllUpcoming \? drops : drops\.slice\(0, UPCOMING_PREVIEW\)/);
    expect(src).toContain("Show all ${drops.length}");
  });
});

describe("times survive the round trip through a timezone (US-2522)", () => {
  it("a wall-clock value typed in a zone comes back the same", () => {
    // The reschedule input is a datetime-local shown in the SELECTED zone, not
    // the browser's. A round trip that drifts is a drop published at the wrong
    // hour, which is the one thing this page exists to get right.
    for (const zone of ["America/New_York", "Europe/London", "Asia/Tokyo"]) {
      const typed = "2026-11-14T09:30";
      const iso = zonedInputToIso(typed, zone);
      expect(iso, `${zone} produced no instant`).toBeTruthy();
      expect(isoToZonedInput(iso!, zone)).toBe(typed);
    }
  });

  it("an empty or malformed value yields no instant", () => {
    expect(zonedInputToIso("", "America/New_York")).toBeNull();
    expect(zonedInputToIso("not-a-date", "America/New_York")).toBeNull();
  });
});

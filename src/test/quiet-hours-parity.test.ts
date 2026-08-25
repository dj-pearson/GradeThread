import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseQuietHours, describeQuietWindow } from "@/lib/quiet-hours";

// US-2853: the settings card and the push gate read the SAME stored jsonb. They
// live in two runtimes (Vite and Deno) so the parser is duplicated, and a
// duplicated parser drifts silently — the card would show a window the server
// never applies, which is the worst possible failure for a "do not disturb"
// control because the user has no way to notice.
//
// Two guards. The behavioural half runs the client parser over the cases that
// matter; the textual half asserts the edge file still states the two rules that
// are easy to "clean up" into their obvious-looking opposites.

const EDGE = "services/edge-functions/src/lib/quiet-hours.ts";

function edgeSrc(): string {
  return readFileSync(resolve(process.cwd(), EDGE), "utf8");
}

describe("quiet hours parse parity (US-2853)", () => {
  it("reads the stored shape the edge writes against", () => {
    expect(
      parseQuietHours({
        enabled: true,
        start_hour: 22,
        end_hour: 7,
        tz: "America/Chicago",
      }),
    ).toEqual({ enabled: true, startHour: 22, endHour: 7, tz: "America/Chicago" });
  });

  it("treats a window with no enabled flag as ON", () => {
    expect(parseQuietHours({ start_hour: 1, end_hour: 5 })?.enabled).toBe(true);
  });

  it("defaults a missing zone to UTC", () => {
    expect(parseQuietHours({ start_hour: 1, end_hour: 5 })?.tz).toBe("UTC");
  });

  it("reads anything unusable as no quiet hours", () => {
    for (const bad of [
      null,
      undefined,
      "22-07",
      [],
      {},
      { start_hour: 22 },
      { start_hour: 24, end_hour: 7 },
      { start_hour: -1, end_hour: 7 },
      { start_hour: "late", end_hour: 7 },
    ]) {
      expect(parseQuietHours(bad)).toBeNull();
    }
  });
});

describe("quiet hours copy tells the truth about the window", () => {
  it("says a wrapping window crosses midnight", () => {
    expect(describeQuietWindow(22, 7)).toContain("the next morning");
  });

  it("does not claim a same-day window wraps", () => {
    expect(describeQuietWindow(9, 17)).not.toContain("the next morning");
  });

  it("calls an equal-hours window off, matching the edge", () => {
    expect(describeQuietWindow(9, 9)).toContain("Off");
  });
});

describe("the edge gate still holds the rules the client mirrors", () => {
  it("keeps start === end as no window rather than a 24-hour mute", () => {
    expect(edgeSrc()).toContain("if (qh.startHour === qh.endHour) return false;");
  });

  it("keeps the absent-enabled-flag default ON", () => {
    expect(edgeSrc()).toContain("enabled: o.enabled !== false");
  });

  it("still fails open — an unreadable preference never mutes", () => {
    const text = edgeSrc();
    expect(text).toContain("if (error) return false;");
    expect(text).toContain("catch {\n    return false;\n  }");
  });
});

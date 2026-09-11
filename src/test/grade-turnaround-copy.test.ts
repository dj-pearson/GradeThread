import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  readyByCopy,
  slaCeilingFor,
  TYPICAL_TURNAROUND,
  turnaroundCopy,
} from "@/lib/grading-journey";

// US-3328: once finished grades wait for their paid turnaround (US-3326), the
// copy has to promise a delivery time and stop saying "minutes" for the tiers
// that are held. With nothing loaded it must say exactly what it said before.

describe("turnaround copy follows the live hold", () => {
  it("nothing loaded = the original sentence, word for word", () => {
    expect(turnaroundCopy("standard", undefined)).toBe(turnaroundCopy("standard"));
    expect(turnaroundCopy("standard", { holdEnabled: false })).toBe(turnaroundCopy("standard"));
  });

  it("hold on: Standard and Premium promise a time and drop the minutes claim", () => {
    for (const tier of ["standard", "premium"] as const) {
      const copy = turnaroundCopy(tier, { holdEnabled: true });
      expect(copy).not.toContain(TYPICAL_TURNAROUND);
      expect(copy).not.toMatch(/minutes/i);
      expect(copy).toMatch(/delivered within \d+ hours? of payment/i);
    }
  });

  it("hold on: Express is never held, so its sentence is unchanged", () => {
    expect(turnaroundCopy("express", { holdEnabled: true })).toBe(turnaroundCopy("express"));
  });

  it("an admin-edited hour count reaches the copy", () => {
    expect(slaCeilingFor("standard", 24)).toBe("24 hours");
    expect(slaCeilingFor("premium", 1)).toBe("1 hour");
    expect(turnaroundCopy("standard", { holdEnabled: true, slaHours: { standard: 24 } }))
      .toMatch(/within 24 hours/);
    // A bad value falls back to the compiled table rather than printing 0.
    expect(slaCeilingFor("standard", 0)).toBe(slaCeilingFor("standard"));
  });

  it("the ready-by line carries the time it was given", () => {
    expect(readyByCopy("Fri, Sep 12, 3:00 PM")).toContain("ready by Fri, Sep 12, 3:00 PM");
  });
});

describe("the tier picker reads live hours", () => {
  it("prints a delivery promise, not a tilde estimate", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/submission/grade-pricing-summary.tsx"),
      "utf8",
    );
    expect(src).toContain("Delivered within {slaCeilingFor(key, turnaround.live?.slaHours?.[key])}");
    expect(src).not.toMatch(/"~1 hour"/);
  });
});

// US-2596: a blank measurements box has to explain itself.
//
// Every step of the MeasureCard pass fails softly on purpose — a bad card shot
// must never block a listing. The sum of those soft failures was a feature that
// produced no measurements and no explanation on any surface, which took three
// rounds of guessing to even localise. These are the words that end that.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { measurePassNote } from "@/components/flipdesk/measurement-photo-editor";

describe("US-2596: the measure pass explains itself", () => {
  it("says nothing when there is nothing to say", () => {
    // A pass that worked, and a pass that has never run, are both silent —
    // the form below already shows the numbers.
    expect(measurePassNote(null)).toBeNull();
    expect(measurePassNote({ reason: null, message: null })).toBeNull();
    expect(measurePassNote({ reason: "already_measured", message: null })).toBeNull();
  });

  it("tells the seller what to reshoot when no card was found", () => {
    const note = measurePassNote({ reason: "no_measurement_photo", message: null });
    expect(note).toBeTruthy();
    // The copy has to name the fix, not the failure.
    expect(note).toMatch(/flat/i);
    expect(note).toMatch(/four corner squares/i);
  });

  it("prefers the server's specific reason over the generic one", () => {
    // The detector distinguishes "too blurry" from "card not fully visible",
    // and those are different reshoots.
    expect(
      measurePassNote({
        reason: "calibration_failed",
        message: "Hold steadier — the photo is too blurry to read the card.",
      }),
    ).toBe("Hold steadier — the photo is too blurry to read the card.");
  });

  it("falls back to advice when the server sent no detail", () => {
    const note = measurePassNote({ reason: "calibration_failed", message: null });
    expect(note).toMatch(/four corner squares/i);
  });

  it("does not invent copy for an unknown reason", () => {
    expect(measurePassNote({ reason: "something_new", message: null })).toBeNull();
    expect(measurePassNote({ reason: "something_new", message: "raw detail" })).toBe(
      "raw detail",
    );
  });

  it("reads the same key the server writes", () => {
    // Two files, one string. A rename on either side silently reverts this
    // whole feature to the blank box it replaced.
    const web = readFileSync(
      "src/components/flipdesk/measurement-photo-editor.tsx",
      "utf8",
    );
    const edge = readFileSync(
      "services/edge-functions/src/lib/measure-autofill.ts",
      "utf8",
    );
    expect(web).toContain('MEASURE_PASS_KEY = "measurements._pass"');
    expect(edge).toContain('MEASURE_PASS_KEY = "measurements._pass"');
  });
});

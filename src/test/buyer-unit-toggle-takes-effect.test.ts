import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useMeasurementPrefs } from "@/stores/measurement-prefs";

// US-3251. Two measurement-unit preferences existed and neither knew about the
// other.
//
//   useMeasurementPrefs          a zustand store in localStorage, per device.
//                                THE ONE EVERYTHING RENDERS FROM: the
//                                measurement form, the photo editor, body
//                                profiles, description blocks.
//   buyer_preferences.unit_preference
//                                a database column, written by the Measurement
//                                unit toggle on buyer settings and read by
//                                exactly one thing -- that same page,
//                                re-populating its own buttons.
//
// So a buyer picked CM, was told "Preferences saved", opened their body profile
// and read inches. The toggle they used was inert; the one that mattered was
// somewhere else and stranded on one device.
//
// Assert the STORE, not the button. The button was always right.

const settingsSrc = readFileSync(
  resolve(process.cwd(), "src/pages/buyer/settings.tsx"),
  "utf8",
);

describe("the buyer's unit toggle reaches what renders (US-3251)", () => {
  it("the store is the thing the render surfaces read (self-check)", () => {
    // If this stops being true the whole premise moves, and the assertions
    // below would be checking a store nobody uses.
    for (const rel of [
      "src/components/flipdesk/measurement-form.tsx",
      "src/components/flipdesk/measurement-photo-editor.tsx",
      "src/pages/fit/body-profiles.tsx",
      "src/lib/description-block-bulk.ts",
    ]) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src, `${rel} no longer reads useMeasurementPrefs`).toContain(
        "useMeasurementPrefs",
      );
    }
  });

  it("saving writes through to the store", () => {
    expect(settingsSrc).toMatch(
      /useMeasurementPrefs\.getState\(\)\.setUnit\(unit\)/,
    );
  });

  it("seeding adopts the saved value, so the choice travels between devices", () => {
    expect(settingsSrc).toMatch(
      /useMeasurementPrefs\.getState\(\)\.setUnit\(preferences\.unit_preference\)/,
    );
  });

  it("the store actually round-trips a unit", () => {
    // Cheap, but it is the thing the two source assertions are betting on.
    const before = useMeasurementPrefs.getState().unit;
    useMeasurementPrefs.getState().setUnit("cm");
    expect(useMeasurementPrefs.getState().unit).toBe("cm");
    useMeasurementPrefs.getState().setUnit("in");
    expect(useMeasurementPrefs.getState().unit).toBe("in");
    useMeasurementPrefs.getState().setUnit(before);
  });
});

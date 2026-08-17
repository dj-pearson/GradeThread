// US-2639 AC3: Android's per-slot upload caps must match the web table.
//
// The sibling of src/test/ios-upload-caps-parity.test.ts, and it exists for the
// same reason: the numbers are ONE decision with three copies, so the only way
// they stay one decision is a test that reads both and compares.
//
// WHY THE TEST LIVES HERE rather than in the Android suite. It has to read the
// TypeScript table, which Kotlin cannot; the Android side can only pin its own
// half. This is the side that can see both.
//
// WHAT ANDROID WAS DOING UNTIL 2026-08-16: nothing. A single
// `MAX_LONG_EDGE = 2048` applied to every photo, which is BELOW the web
// default, let alone the macro tiers — 68% fewer pixels by area than web or iOS
// on an authenticity slot. The MeasureCard case had a hard number to fail
// against: its fiducials are 1in squares needing ~40px each, and a garment
// filling ~50in of frame put them at 41px, at the detector floor before any
// server-side downscale.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_UPLOAD_MAX_WIDTH_PX,
  MACRO_UPLOAD_MAX_WIDTH_PX,
} from "@/lib/macro-photo-quality";

const PROCESSOR = "android/app/src/main/java/com/gradethread/app/capture/PhotoProcessor.kt";
const kotlin = readFileSync(resolve(process.cwd(), PROCESSOR), "utf8");

/** The `UPLOAD_CAPS` map, parsed out of the Kotlin source. */
function androidCaps(): Record<string, number> {
  const start = kotlin.indexOf("val UPLOAD_CAPS: Map<String, Int> = mapOf(");
  expect(start, "UPLOAD_CAPS was renamed or removed from PhotoProcessor.kt")
    .toBeGreaterThan(-1);
  const end = kotlin.indexOf("\n    )", start);
  const body = kotlin.slice(start, end);
  const out: Record<string, number> = {};
  for (const m of body.matchAll(/"([a-z_]+)"\s+to\s+(\d+)/g)) {
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

describe("Android upload caps match the web table", () => {
  it("covers exactly the same slots", () => {
    // Not a subset check. A slot present on one side and missing on the other
    // is the defect in either direction: an extra Android key would be a number
    // nobody else honours, a missing one is a seller sending half the pixels.
    expect(Object.keys(androidCaps()).sort())
      .toEqual(Object.keys(MACRO_UPLOAD_MAX_WIDTH_PX).sort());
  });

  it("uses the same value for every slot", () => {
    const android = androidCaps();
    for (const [slot, web] of Object.entries(MACRO_UPLOAD_MAX_WIDTH_PX)) {
      expect(android[slot], `${slot}: Android ${android[slot]} vs web ${web}`)
        .toBe(web);
    }
  });

  it("the measurement slot is on the authenticity tier, not the default", () => {
    // The slot with a hard number behind it (US-2632): fiducial detection, not
    // aesthetics. Pinned by itself so a future trim of "macro" slots cannot
    // quietly demote it — it is the one that is NOT a macro shot.
    expect(androidCaps().measurement).toBe(3600);
    expect(androidCaps().measurement).toBeGreaterThan(DEFAULT_UPLOAD_MAX_WIDTH_PX);
  });

  it("falls back to the Android default, and that default is DELIBERATE", () => {
    // US-2639 AC4. The three platforms disagree on the default ON PURPOSE:
    // web 2400, iOS 1600 (lowered for upload speed on mobile data), Android
    // 2048. Nothing in AC1's measurement implicated the default — what it
    // measured failing was the macro slots. This asserts the fallback is the
    // named constant rather than a literal, so the decision stays in one place.
    expect(kotlin).toMatch(/UPLOAD_CAPS\[serverPhotoType\] \?: MAX_LONG_EDGE/);
    expect(kotlin).toMatch(/const val MAX_LONG_EDGE = 2048/);
    // And the reason is written down, not just the number.
    expect(kotlin).toContain("US-2639 AC4");
  });

  it("every intake path resolves a cap, so none silently uses the default", () => {
    // The gap this story is about was not a wrong number — it was that no call
    // site could express a slot at all. PhotoProcessor.process took no photo
    // type and neither did any caller, so "add a table" was not the change;
    // "make the pipeline slot-aware" was.
    const paths = [
      "android/app/src/main/java/com/gradethread/app/capture/CaptureScreen.kt",
      "android/app/src/main/java/com/gradethread/app/intake/ShareTargetActivity.kt",
    ];
    for (const p of paths) {
      const src = readFileSync(resolve(process.cwd(), p), "utf8");
      expect(src, `${p} must resolve a per-slot cap`).toContain(
        "PhotoProcessor.uploadCapFor(",
      );
    }
    // The import path resolves caps for the whole batch up front instead.
    const screen = readFileSync(
      resolve(process.cwd(), "android/app/src/main/java/com/gradethread/app/capture/CaptureScreen.kt"),
      "utf8",
    );
    expect(screen).toContain("plannedDestinations(");
    expect(screen).toContain("slotCaps = caps");
  });

  it("process() takes a long edge rather than reading the constant", () => {
    expect(kotlin).toMatch(/longEdge: Int = MAX_LONG_EDGE/);
    // Both the decode sample size and the exact resize must honour it. Passing
    // it to only one produces a photo that is downscaled correctly and decoded
    // at the wrong resolution, or vice versa — a subtle quality loss that no
    // dimension assertion would catch.
    expect(kotlin).toMatch(/sampleSize\(bounds\.outWidth, bounds\.outHeight, longEdge\)/);
    expect(kotlin).toMatch(/targetDimensions\(upright\.width, upright\.height, longEdge\)/);
  });
});

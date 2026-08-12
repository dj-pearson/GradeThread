// US-2135: the iOS per-slot upload caps must match the web table.
//
// `MACRO_UPLOAD_MAX_WIDTH_PX` (src/lib/macro-photo-quality.ts) and
// `CaptureSlot.uploadMaxLongEdge` (ios/GradeThread/Capture/CaptureSlot.swift)
// are two copies of the same resolution decision. Two copies of a number drift
// silently, and the symptom here is unusually quiet: nothing breaks, no test
// fails, no seller complains - the grader just gets less to read on one
// platform than the other, and the accuracy difference shows up much later as
// "iOS grades seem worse".
//
// Same remedy the title-sync and rubric pairs use: pin the behaviour, from the
// side that can actually run.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_UPLOAD_MAX_WIDTH_PX,
  MACRO_UPLOAD_MAX_WIDTH_PX,
} from "@/lib/macro-photo-quality";

const swift = readFileSync(
  join(process.cwd(), "ios/GradeThread/Capture/CaptureSlot.swift"),
  "utf8",
);

/**
 * The `uploadMaxLongEdge` switch body, comments stripped.
 *
 * Stripped because the property's doc comment quotes the numbers while
 * explaining them - a raw scan would match the prose and pass with the switch
 * deleted. That mistake has recurred often enough today to be the default
 * assumption for any source-reading assertion.
 */
const switchBody = (() => {
  const at = swift.indexOf("public var uploadMaxLongEdge: CGFloat {");
  if (at === -1) throw new Error("uploadMaxLongEdge was renamed or removed");
  const end = swift.indexOf("\n    }", at);
  return swift
    .slice(at, end)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\n)\s*\/\/\/?.*/g, " ");
})();

/** photoType -> cap, as the Swift switch actually assigns them. */
function parseSwiftCaps(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of switchBody.matchAll(/case ([^:]+):\s*(\d+)/g)) {
    const labels = m[1];
    const cap = Number(m[2]);
    if (!labels || !Number.isFinite(cap)) continue;
    for (const t of labels.matchAll(/"([^"]+)"/g)) {
      const name = t[1];
      if (name) out[name] = cap;
    }
  }
  return out;
}

const swiftCaps = parseSwiftCaps();

describe("US-2135: iOS upload caps match the web table", () => {
  it("the Swift switch was actually parsed", () => {
    // Guards the guard: a regex that stopped matching would leave every
    // assertion below comparing an empty object and passing.
    expect(Object.keys(swiftCaps).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(MACRO_UPLOAD_MAX_WIDTH_PX).length).toBeGreaterThanOrEqual(10);
  });

  it("every macro slot has the same cap on both platforms", () => {
    expect(swiftCaps).toEqual({ ...MACRO_UPLOAD_MAX_WIDTH_PX });
  });

  it("the fallback is the shared default, not a hardcoded number", () => {
    // `default:` must defer to PhotoCompressor.defaultMaxLongEdge. Writing 1600
    // there would silently detach iOS from its own compressor default the day
    // that changes.
    expect(
      /default:\s*PhotoCompressor\.defaultMaxLongEdge/.test(switchBody),
      "the default branch no longer defers to PhotoCompressor.defaultMaxLongEdge",
    ).toBe(true);
    // And the web default is deliberately HIGHER than iOS's 1600, so a macro
    // slot is the only place they were ever meant to converge.
    expect(DEFAULT_UPLOAD_MAX_WIDTH_PX).toBeGreaterThan(1600);
  });

  it("the capture path compresses at the PINNED slot's cap", () => {
    // US-1648 pins `capturedSlot` before the async hop so a strip tap mid-flight
    // cannot redirect a sensitive photo. The cap has to follow that same pinned
    // value - reading the live active slot would compress a serial shot at the
    // 1600px default while still filing it correctly.
    const intake = readFileSync(
      join(process.cwd(), "ios/GradeThread/Capture/PhotoIntakeView.swift"),
      "utf8",
    ).replace(/(^|\n)\s*\/\/.*/g, " ");
    expect(
      intake,
      "the camera capture no longer passes a per-slot cap, so every macro shot " +
        "is compressed at the 1600px default",
    ).toContain("maxLongEdge: capturedSlot.uploadMaxLongEdge");
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VIDEO_ABSTAIN_STATUS,
  VIDEO_CAPTURE_SOURCE_FIELD,
  VIDEO_CAPTURE_SOURCES,
  INVENTORY_ITEM_FIELD,
  VIDEO_FIELD,
  VIDEO_GRADING_FIELD,
  VIDEO_GRADING_OPT_IN,
  VIDEO_SLOT_MARKS_FIELD,
  VIDEO_SUBMIT_FORMATS,
  VIDEO_SUBMIT_MAX_BYTES,
  VIDEO_SUBMIT_MAX_DURATION_SECONDS,
  videoSubmitRejection,
  VIDEO_DURATION_MUST_BE_READABLE,
  VIDEO_EXCLUDES_PHOTOS,
  VIDEO_UPLOAD_COMPLETE_IS_NOT_GRADED,
} from "@/lib/video-grading-contract";

// US-2504 AC2. The TypeScript contract was written so a native client would have
// a spec instead of a page to reverse-engineer. The native client now exists, and
// a spec kept in step by hand is the same private handshake one level along — a
// renamed field or a lowered cap would break iOS with nothing red.
//
// So this reads the Swift mirror as TEXT and compares it, value by value, to the
// real TypeScript import. It runs on the machine the edit is made on, in about a
// second, rather than on a macOS runner or not at all.

const SWIFT = resolve(
  process.cwd(),
  "ios/GradeThread/Grading/VideoGradingContract.swift",
);

const swift = () => readFileSync(SWIFT, "utf8");

/** `static let name = "value"` */
function swiftString(name: string): string | null {
  const m = new RegExp(`static let ${name}\\s*=\\s*"([^"]*)"`).exec(swift());
  return m ? m[1]! : null;
}

/** `static let name = <numeric expression>` — evaluated, so `60 * 1024 * 1024`
 *  is compared as a NUMBER. Comparing the text would pass on `60 * 1024` too.
 *
 *  The line end is `\r?\n`, not `\n`. On a CRLF checkout the `\r` sits between
 *  the numeric run and the newline, so the anchor matched nothing and this
 *  returned null for EVERY number — failing the file on a Windows working tree
 *  while staying green on Linux CI. Same shape as the one in
 *  extension-unified/test/sync-poll.test.cjs, found the same afternoon. */
function swiftNumber(name: string): number | null {
  const m = new RegExp(`static let ${name}\\s*=\\s*([0-9_ */+.]+)\\r?\\n`).exec(swift());
  if (!m) return null;
  const expr = m[1]!.trim().replace(/_/g, "");
  if (!/^[0-9 */+.]+$/.test(expr)) return null;
  return Number(new Function(`return (${expr});`)());
}

/** `static let name = ["a", "b"]` */
function swiftArray(name: string): string[] | null {
  const m = new RegExp(`static let ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(swift());
  if (!m) return null;
  return [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

describe("the Swift video-grading contract mirrors the TypeScript one", () => {
  it("parses the file it guards", () => {
    // Without this, a formatting change that stops the helpers matching returns
    // null everywhere and every comparison below fails loudly rather than
    // passing against nothing — but this names the cause instead of leaving a
    // reader to work out why six assertions went red at once.
    expect(swift().length).toBeGreaterThan(1000);
    expect(swiftString("videoField")).not.toBeNull();
    expect(swiftNumber("maxBytes")).not.toBeNull();
    expect(swiftArray("formats")).not.toBeNull();
  });

  it("agrees on every multipart field name", () => {
    expect(swiftString("videoField")).toBe(VIDEO_FIELD);
    expect(swiftString("videoGradingField")).toBe(VIDEO_GRADING_FIELD);
    expect(swiftString("videoGradingOptIn")).toBe(VIDEO_GRADING_OPT_IN);
    expect(swiftString("videoSlotMarksField")).toBe(VIDEO_SLOT_MARKS_FIELD);
    expect(swiftString("videoCaptureSourceField")).toBe(VIDEO_CAPTURE_SOURCE_FIELD);
    expect(swiftString("inventoryItemField")).toBe(INVENTORY_ITEM_FIELD);
  });

  it("agrees on the capture-source vocabulary", () => {
    // Provenance is positive-only: an unrecognised value normalises to null
    // server-side, so a typo here does not read as "recorded live" — it silently
    // drops the claim the recorder exists to make.
    expect(swiftString("captureSourceInAppRecorder")).toBe(VIDEO_CAPTURE_SOURCES[0]);
    expect(swiftString("captureSourceLibrary")).toBe(VIDEO_CAPTURE_SOURCES[1]);
  });

  it("agrees on the ROUTE's caps, not the validation library's", () => {
    // The trap the TypeScript file calls out: lib/video-validation.ts defaults
    // to 100 MB / 60s and routes/grade.ts is stricter. A recorder built to the
    // looser numbers produces clips refused after the whole upload.
    expect(swiftNumber("maxBytes")).toBe(VIDEO_SUBMIT_MAX_BYTES);
    expect(swiftNumber("maxDurationSeconds")).toBe(VIDEO_SUBMIT_MAX_DURATION_SECONDS);
    expect(swiftNumber("maxBytes")).not.toBe(100 * 1024 * 1024);
    expect(swiftNumber("maxDurationSeconds")).not.toBe(60);
  });

  it("agrees on the accepted containers and the abstain status", () => {
    expect(swiftArray("formats")).toEqual([...VIDEO_SUBMIT_FORMATS]);
    expect(swiftString("abstainStatus")).toBe(VIDEO_ABSTAIN_STATUS);
  });

  it("carries the same rejection sentences, in the same order", () => {
    // The messages are user-facing copy AND the order is behavioural: the photo
    // conflict is reported first because it is the only one the seller can fix
    // without re-recording. Compared against the real function's output so a
    // reworded sentence on either side is caught.
    const source = swift();
    const cases = [
      { bytes: 10, durationSeconds: 5, format: "mov", stagedPhotoCount: 2 },
      { bytes: 0, durationSeconds: 5, format: "mov", stagedPhotoCount: 0 },
      {
        bytes: VIDEO_SUBMIT_MAX_BYTES + 1,
        durationSeconds: 5,
        format: "mov",
        stagedPhotoCount: 0,
      },
      { bytes: 10, durationSeconds: 5, format: "avi", stagedPhotoCount: 0 },
      { bytes: 10, durationSeconds: 0, format: "mov", stagedPhotoCount: 0 },
      {
        bytes: 10,
        durationSeconds: VIDEO_SUBMIT_MAX_DURATION_SECONDS + 1,
        format: "mov",
        stagedPhotoCount: 0,
      },
    ];
    for (const clip of cases) {
      const message = videoSubmitRejection(clip);
      expect(message, JSON.stringify(clip)).toBeTruthy();
      // The size and duration sentences interpolate their cap, so compare the
      // stable half rather than the rendered string.
      const stable = message!
        .replace(/\(max [^)]*\)/, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\.$/, "");
      expect(source, `Swift is missing: ${stable}`).toContain(stable);
    }
  });

  it("keeps the three behavioural flags the recorder has to honour", () => {
    // ⚠ THIS COMMENT USED TO SAY the flags "are prose in TypeScript and
    // constants in Swift, so they cannot be compared by value", and checked only
    // that Swift declared them. They are NOT prose: all three are exported
    // constants in video-grading-contract.ts. So the comparison this file exists
    // to make was being skipped on its own premise, and two of the three
    // TypeScript constants had no reader at all — which is how they turned up on
    // the dead-export list, filed as code to delete rather than as a check that
    // was only ever run on one side.
    //
    // Both sides are asserted now. A flag flipped to false in TypeScript, or
    // deleted from Swift, fails here.
    const source = swift();
    const pairs: Array<[boolean, string]> = [
      [VIDEO_DURATION_MUST_BE_READABLE, "durationMustBeReadable"],
      [VIDEO_EXCLUDES_PHOTOS, "excludesPhotos"],
      [VIDEO_UPLOAD_COMPLETE_IS_NOT_GRADED, "uploadCompleteIsNotGraded"],
    ];
    for (const [ts, swiftName] of pairs) {
      expect(ts, `${swiftName}: the TypeScript side`).toBe(true);
      expect(source, `${swiftName}: the Swift side`).toContain(
        `static let ${swiftName} = true`,
      );
    }
  });
});

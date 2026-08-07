// US-1766: the pure half of guided walk-around capture.
//
// These four helpers are what stands between "the seller pressed record" and a
// clip the edge will actually accept, so each is checked against the constraint
// it exists to satisfy rather than against its own implementation.
import { describe, expect, it } from "vitest";
import {
  IN_APP_VIDEO_CAPTURE_SOURCE,
  LIBRARY_VIDEO_CAPTURE_SOURCE,
  pickRecorderMimeType,
  RECORDER_MIME_CANDIDATES,
  recordedClipExtension,
  recordedClipName,
  segmentMarkSeconds,
  serializeVideoSlotMarks,
  VIDEO_SLOT_KEYS,
} from "@/lib/video-capture";

describe("pickRecorderMimeType", () => {
  it("takes the first candidate the browser supports", () => {
    // Safari: mp4 only.
    expect(pickRecorderMimeType((t) => t === "video/mp4")).toBe("video/mp4");
    // Chrome: no mp4 recording, vp9 available.
    expect(pickRecorderMimeType((t) => t.startsWith("video/webm"))).toBe(
      "video/webm;codecs=vp9",
    );
  });

  it("returns null when nothing is supported, rather than a format we can't record", () => {
    expect(pickRecorderMimeType(() => false)).toBeNull();
  });

  it("treats a browser whose isTypeSupported throws as unsupported", () => {
    // Some engines throw on an unknown codec string instead of returning false.
    // Throwing out of the recorder's feature check would take the whole capture
    // step down, when the honest answer is just "offer the file picker".
    expect(
      pickRecorderMimeType(() => {
        throw new Error("nope");
      }),
    ).toBeNull();
  });

  it("only ever offers containers the edge's magic-byte sniff accepts", () => {
    // validateVideoUpload accepts mp4 / quicktime / webm. A candidate outside
    // that set would produce a recording the server then rejects — the one
    // failure this list must never allow.
    for (const candidate of RECORDER_MIME_CANDIDATES) {
      expect(candidate).toMatch(/^video\/(mp4|quicktime|webm)\b/);
    }
  });
});

describe("recordedClipExtension / recordedClipName", () => {
  it("names the file after what it actually is", () => {
    expect(recordedClipExtension("video/mp4")).toBe("mp4");
    expect(recordedClipExtension("video/webm;codecs=vp9")).toBe("webm");
    expect(recordedClipName("video/mp4")).toBe("walk-around.mp4");
    expect(recordedClipName("video/webm;codecs=vp8")).toBe("walk-around.webm");
  });
});

describe("segmentMarkSeconds", () => {
  it("marks the middle of the segment, not either edge", () => {
    // The hand-off at each end is where the camera is moving; the middle is the
    // frame most likely to show the view the seller was filming.
    expect(segmentMarkSeconds(0, 4)).toBe(2);
    expect(segmentMarkSeconds(4, 9)).toBe(6.5);
  });

  it("refuses a segment with no duration", () => {
    expect(segmentMarkSeconds(3, 3)).toBeNull();
    expect(segmentMarkSeconds(5, 2)).toBeNull();
    expect(segmentMarkSeconds(Number.NaN, 2)).toBeNull();
  });

  it("rounds to 2dp so the serialized marks stay compact", () => {
    expect(segmentMarkSeconds(0, 1 / 3)).toBe(0.17);
  });
});

describe("serializeVideoSlotMarks", () => {
  it("round-trips the marks a guided recording produces", () => {
    const marks = { front: 1.5, back: 5.25, label: 9, detail: 13.75 };
    expect(JSON.parse(serializeVideoSlotMarks(marks))).toEqual(marks);
  });

  it("emits nothing when no view was marked", () => {
    // "" is the signal not to send the field at all — an empty object would
    // claim the seller marked views they never did.
    expect(serializeVideoSlotMarks({})).toBe("");
  });
});

describe("capture-source markers", () => {
  it("match the strings the edge normalizes against", () => {
    // parseVideoCaptureSource (services/edge-functions/src/lib/
    // verified-capture.ts) recognizes exactly these two; anything else becomes
    // null there, so a drift here silently downgrades every live recording.
    expect(IN_APP_VIDEO_CAPTURE_SOURCE).toBe("in_app_recorder");
    expect(LIBRARY_VIDEO_CAPTURE_SOURCE).toBe("library");
  });

  it("covers every required view with a prompt key", () => {
    expect([...VIDEO_SLOT_KEYS]).toEqual(["front", "back", "label", "detail"]);
  });
});

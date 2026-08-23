import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPTURE_SOURCES_FIELD,
  IN_APP_CAPTURE_SOURCE,
  LIBRARY_CAPTURE_SOURCE,
  LIVE_CAPTURE_OPT_IN,
  LIVE_CAPTURE_OPT_IN_FIELD,
  PHOTO_CAPTURE_SOURCES,
  qualifiesForLiveCapture,
} from "@/lib/photo-capture-contract";

// US-2802. The server half of Live Capture has been complete and unreachable
// since US-340: grade.ts reads the fields, verified-capture.ts awards the badge,
// certificate.tsx renders it — and no client ever sent the opt-in, so
// evaluateLiveCapture returned "not opted into Live Capture" for every
// submission ever made.
//
// These cases pin the handshake so the iOS and Android clients implement a spec
// rather than reverse-engineering four strings out of edge route code, and so a
// rename on either side cannot silently un-earn the badge again.

const WEB = "src/pages/new-submission.tsx";
const UPLOAD = "src/components/submission/photo-upload.tsx";
const CAMERA = "src/components/submission/camera-capture-dialog.tsx";
const EDGE = "services/edge-functions/src/routes/grade.ts";
const VERIFIED = "services/edge-functions/src/lib/verified-capture.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("both ends speak the same field names", () => {
  it("the edge reads every field the contract declares", () => {
    const edge = read(EDGE);
    // Only the field this story wired. The 360 pair is read by the same
    // route and stays unfed on purpose (no browser sensor); the contract
    // module deliberately does not name it, so neither does this.
    for (const field of [LIVE_CAPTURE_OPT_IN_FIELD]) {
      expect(edge, `the edge never reads "${field}"`).toContain(
        `formData.get("${field}")`,
      );
    }
    // The per-image array is read with getAll, not get — it is parallel to
    // `images`, one entry per photo.
    expect(edge, `the edge never reads "${CAPTURE_SOURCES_FIELD}"`).toContain(
      `formData.getAll("${CAPTURE_SOURCES_FIELD}")`,
    );
  });

  it("the in-app source string is the one the badge check compares against", () => {
    // The whole tier turns on this literal. verified-capture.ts owns it; if the
    // two ever disagree the client sends a value that looks right, the server
    // silently calls it not-live, and nothing anywhere errors.
    expect(read(VERIFIED)).toContain(
      `export const IN_APP_CAPTURE_SOURCE = "${IN_APP_CAPTURE_SOURCE}";`,
    );
  });

  it("the opt-in is an exact string the server compares exactly", () => {
    expect(LIVE_CAPTURE_OPT_IN).toBe("true");
    expect(read(EDGE)).toContain(
      `(formData.get("${LIVE_CAPTURE_OPT_IN_FIELD}") as string | null) === "true"`,
    );
  });

  it("is NOT the video tier's vocabulary", () => {
    // Two tiers, two source strings, and swapping them earns nothing silently
    // because each is compared against its own literal.
    expect(IN_APP_CAPTURE_SOURCE).not.toBe("in_app_recorder");
    expect(read("src/lib/video-capture.ts")).toContain(
      'IN_APP_VIDEO_CAPTURE_SOURCE = "in_app_recorder"',
    );
  });

  it("the web sends both fields from the contract, not from spelled literals", () => {
    const web = read(WEB);
    expect(web).toContain('from "@/lib/photo-capture-contract"');
    expect(web).toContain(
      `formData.append(${"LIVE_CAPTURE_OPT_IN_FIELD"}, ${"LIVE_CAPTURE_OPT_IN"})`,
    );
    expect(web).toContain(
      `formData.append(${"CAPTURE_SOURCES_FIELD"}, photo.captureSource)`,
    );
  });
});

describe("the web actually produces provenance, rather than declaring it", () => {
  it("the camera dialog is the only site that claims in-app capture", () => {
    const upload = read(UPLOAD);
    // Exactly one call passes the in-app source. Any second one is a new way to
    // earn the badge and should be looked at deliberately, not merged quietly.
    const claims = upload.split(`processFile(key, file, ${"IN_APP_CAPTURE_SOURCE"})`).length - 1;
    expect(claims, "expected exactly one in-app capture claim").toBe(1);
  });

  it("every other path defaults to the weaker claim", () => {
    // Failing closed is the point: an origin nobody recorded must not be
    // reported as live.
    expect(read(UPLOAD)).toContain(
      `captureSource: PhotoCaptureSource = ${"LIBRARY_CAPTURE_SOURCE"}`,
    );
    expect(read(UPLOAD)).toContain(
      `captureSource: state.captureSource ?? ${"LIBRARY_CAPTURE_SOURCE"}`,
    );
  });

  it("a camera capture carries no EXIF, which is why the opt-in gate had to widen", () => {
    // canvas.toBlob strips everything. This is the reason provenanceAvailable
    // (EXIF make/model/time on EVERY photo) can never be true for an all-camera
    // submission, and why gating Live Capture on it would have shipped a tier
    // that still could not be earned — the exact bug this story is about.
    expect(read(CAMERA)).toContain('canvas.toBlob(');
    expect(read(CAMERA)).toContain('"image/jpeg"');
    expect(read(WEB)).toContain("provenanceAvailable || allPhotosInApp");
  });
});

describe("qualifiesForLiveCapture", () => {
  const IN = IN_APP_CAPTURE_SOURCE;
  const LIB = LIBRARY_CAPTURE_SOURCE;

  it("needs consent AND an all-in-app photo set", () => {
    expect(qualifiesForLiveCapture([IN, IN], true)).toBe(true);
    expect(qualifiesForLiveCapture([IN, IN], false)).toBe(false);
    expect(qualifiesForLiveCapture([IN, LIB], true)).toBe(false);
  });

  it("one library photo is enough to lose it", () => {
    // The claim is about the whole submission. A single uploaded photo makes
    // "every photo was taken live" false, and the server rejects the
    // combination outright rather than downgrading it.
    expect(qualifiesForLiveCapture([IN, IN, IN, LIB], true)).toBe(false);
  });

  it("an empty set is NOT live, though `every` would say it is", () => {
    // Array.every is vacuously true on []. A submission with no photos claiming
    // the strongest provenance tier is exactly the vacuous pass to refuse.
    expect(qualifiesForLiveCapture([], true)).toBe(false);
  });

  it("has exactly two sources, so 'not in-app' means library", () => {
    expect([...PHOTO_CAPTURE_SOURCES].sort()).toEqual([IN, LIB].sort());
  });
});

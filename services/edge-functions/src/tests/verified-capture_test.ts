// Unit tests for Verified Capture provenance evaluation (US-340).
//
// evaluateVerifiedCapture + parseExifDate are pure (clock injected). No DB/env
// dependency — the module only reads optional tuning env vars that default.
//
//   deno test --allow-env src/tests/verified-capture_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  evaluateLiveCapture,
  evaluateVerifiedCapture,
  evaluateVideoCapture,
  IN_APP_CAPTURE_SOURCE,
  MIN_VIDEO_VERIFIED_FRAMES,
  VIDEO_FRAME_CAPTURE_SOURCE,
  type LiveCaptureImage,
  parseExifDate,
  type VerifiedCaptureImage,
  type VerifiedCaptureResult,
} from "../lib/verified-capture.ts";

// Derive timestamps via the same parser so the test is timezone-independent.
const SUBMIT = parseExifDate("2026:06:11 12:00:00")!;
const RECENT = "2026:06:10 12:00:00"; // 1 day before submit
const OLD = "2026:01:01 12:00:00"; // > 30 days before submit
const FUTURE = "2026:06:20 12:00:00"; // after submit

function img(
  image_type: string,
  exif: Record<string, unknown> | null,
): VerifiedCaptureImage {
  return { image_type, exif };
}

function iphone(dt: string, extra: Record<string, unknown> = {}) {
  return { make: "Apple", model: "iPhone 14 Pro", dateTimeOriginal: dt, ...extra };
}

Deno.test("parseExifDate handles the EXIF colon-date form", () => {
  assert(parseExifDate("2026:06:11 12:00:00") !== null);
  assertEquals(parseExifDate("not a date"), null);
  assertEquals(parseExifDate(undefined), null);
});

Deno.test("not opted in → never verified", () => {
  const r = evaluateVerifiedCapture({
    optedIn: false,
    submittedAtMs: SUBMIT,
    images: [img("front", iphone(RECENT)), img("back", iphone(RECENT))],
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.verified, false);
});

Deno.test("opted in, consistent recent unedited device → verified", () => {
  const r = evaluateVerifiedCapture({
    optedIn: true,
    submittedAtMs: SUBMIT,
    images: [
      img("front", iphone(RECENT)),
      img("back", iphone(RECENT)),
      img("label", iphone(RECENT)),
    ],
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.verified, true);
  assertEquals(r.with_exif, 3);
  assertEquals(r.device, "Apple iPhone 14 Pro");
});

Deno.test("mixed devices → not verified", () => {
  const r = evaluateVerifiedCapture({
    optedIn: true,
    submittedAtMs: SUBMIT,
    images: [
      img("front", iphone(RECENT)),
      img("back", { make: "Samsung", model: "SM-G991", dateTimeOriginal: RECENT }),
    ],
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.verified, false);
});

Deno.test("editor software tell → not verified", () => {
  const r = evaluateVerifiedCapture({
    optedIn: true,
    submittedAtMs: SUBMIT,
    images: [img("front", iphone(RECENT, { software: "Adobe Photoshop 25.0" }))],
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.verified, false);
});

Deno.test("future capture timestamp → not verified", () => {
  const r = evaluateVerifiedCapture({
    optedIn: true,
    submittedAtMs: SUBMIT,
    images: [img("front", iphone(FUTURE))],
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.verified, false);
});

Deno.test("capture older than the window → not verified", () => {
  const r = evaluateVerifiedCapture({
    optedIn: true,
    submittedAtMs: SUBMIT,
    images: [img("front", iphone(OLD))],
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.verified, false);
});

Deno.test("cross-account photo reuse → not verified", () => {
  const r = evaluateVerifiedCapture({
    optedIn: true,
    submittedAtMs: SUBMIT,
    images: [img("front", iphone(RECENT)), img("back", iphone(RECENT))],
    crossUserReuse: true,
    nowMs: SUBMIT,
  });
  assertEquals(r.verified, false);
});

Deno.test("any image missing provenance → not verified (never penalized elsewhere)", () => {
  const r = evaluateVerifiedCapture({
    optedIn: true,
    submittedAtMs: SUBMIT,
    images: [img("front", iphone(RECENT)), img("back", null)],
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.verified, false);
});

// US-1642: provenance can't vouch for a tampered image.
Deno.test("suspected manipulation → not verified (badge withheld)", () => {
  const r = evaluateVerifiedCapture({
    optedIn: true,
    submittedAtMs: SUBMIT,
    // An otherwise-passing set (recent, consistent, unedited device) …
    images: [img("front", iphone(RECENT)), img("back", iphone(RECENT))],
    crossUserReuse: false,
    manipulationSuspected: true, // … but the vision pass flagged manipulation.
    nowMs: SUBMIT,
  });
  assertEquals(r.verified, false);
  assert(r.reasons.some((x) => x.includes("manipulation")));
});

// ── Live Capture — fraud-proof grading mode (US-1283) ────────────────────────

// A passing/failing standard Verified Capture result to compose with.
const VERIFIED: VerifiedCaptureResult = {
  verified: true,
  reasons: ["ok"],
  device: "Apple iPhone 14 Pro",
  with_exif: 2,
  total: 2,
  max_age_days: 30,
  checked_at: new Date(SUBMIT).toISOString(),
};
const NOT_VERIFIED: VerifiedCaptureResult = {
  ...VERIFIED,
  verified: false,
  reasons: ["photos were captured on more than one device"],
};

function liveImg(image_type: string, source: string | null): LiveCaptureImage {
  return { image_type, capture_source: source };
}

const LIVE = IN_APP_CAPTURE_SOURCE;

Deno.test("live: not opted in → no Live-Verified, mirrors the verified fallback", () => {
  const r = evaluateLiveCapture({
    liveCaptureOptIn: false,
    verifiedCapture: VERIFIED,
    images: [liveImg("front", LIVE), liveImg("back", LIVE)],
    manipulationSuspected: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, "verified");
  assertEquals(r.live_capture, false);
});

Deno.test("live: device-attested + provenance verified + no manipulation → live_verified", () => {
  const r = evaluateLiveCapture({
    liveCaptureOptIn: true,
    verifiedCapture: VERIFIED,
    images: [liveImg("front", LIVE), liveImg("back", LIVE)],
    manipulationSuspected: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, "live_verified");
  assert(r.device_attested);
  assert(r.live_capture);
});

Deno.test("live: a single library upload downgrades the badge (never a silent pass)", () => {
  const r = evaluateLiveCapture({
    liveCaptureOptIn: true,
    verifiedCapture: VERIFIED,
    images: [liveImg("front", LIVE), liveImg("back", "library")],
    manipulationSuspected: false,
    nowMs: SUBMIT,
  });
  // Provenance still passed, so it falls back to standard Verified Capture.
  assertEquals(r.badge, "verified");
  assertEquals(r.device_attested, false);
  assert(r.reasons.some((x) => x.includes("not captured live in-app")));
});

Deno.test("live: manipulation suspected downgrades the badge", () => {
  const r = evaluateLiveCapture({
    liveCaptureOptIn: true,
    verifiedCapture: VERIFIED,
    images: [liveImg("front", LIVE), liveImg("back", LIVE)],
    manipulationSuspected: true,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, "verified");
  assert(r.reasons.some((x) => x.includes("manipulation")));
});

Deno.test("live: failed provenance + not attested → no badge at all", () => {
  const r = evaluateLiveCapture({
    liveCaptureOptIn: true,
    verifiedCapture: NOT_VERIFIED,
    images: [liveImg("front", "library"), liveImg("back", null)],
    manipulationSuspected: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, null);
  assertEquals(r.device_attested, false);
});

Deno.test("live: attested but provenance failed → no live_verified, drops to no badge", () => {
  const r = evaluateLiveCapture({
    liveCaptureOptIn: true,
    verifiedCapture: NOT_VERIFIED,
    images: [liveImg("front", LIVE), liveImg("back", LIVE)],
    manipulationSuspected: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, null);
});

// ── Video Capture (US-1762) ──────────────────────────────────────────────────
//
// The claim is narrow on purpose: every view the buyer sees came out of ONE
// take this server decoded itself. Each test below is one way that claim could
// be false while the badge still rendered.

function frame(image_type: string, source: string | null = VIDEO_FRAME_CAPTURE_SOURCE) {
  return { image_type, capture_source: source };
}

const FOUR_FRAMES = ["front", "back", "label", "detail"].map((t) => frame(t));

Deno.test("video: four server-extracted frames, clean signals → video_verified", () => {
  const r = evaluateVideoCapture({
    videoGraded: true,
    images: FOUR_FRAMES,
    durationSeconds: 18.4,
    manipulationSuspected: false,
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, "video_verified");
  assertEquals(r.frames_used, 4);
  assertEquals(r.duration_seconds, 18.4);
  assert(r.reasons[0]!.includes("one 18.4s clip"));
});

Deno.test("video: a photo submission earns nothing and claims nothing", () => {
  const r = evaluateVideoCapture({
    videoGraded: false,
    images: [frame("front", null), frame("back", "in_app_camera")],
    durationSeconds: null,
    manipulationSuspected: false,
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, null);
  assertEquals(r.video_graded, false);
  assertEquals(r.reasons, ["not graded from a video clip"]);
});

Deno.test("video: ONE hand-picked photo mixed in breaks the one-take claim", () => {
  // This is the whole point of the badge. A single library still among the
  // frames means a buyer could be looking at a different garment's front.
  const r = evaluateVideoCapture({
    videoGraded: true,
    images: [...FOUR_FRAMES, frame("defect", null)],
    durationSeconds: 12,
    manipulationSuspected: false,
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, null);
  assert(r.reasons[0]!.includes("did not come from the clip"));
});

Deno.test("video: fewer frames than the required-view count earns no badge", () => {
  const r = evaluateVideoCapture({
    videoGraded: true,
    images: FOUR_FRAMES.slice(0, MIN_VIDEO_VERIFIED_FRAMES - 1),
    durationSeconds: 9,
    manipulationSuspected: false,
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, null);
  assert(r.reasons[0]!.includes(String(MIN_VIDEO_VERIFIED_FRAMES)));
});

Deno.test("video: no images at all is not a silent pass", () => {
  const r = evaluateVideoCapture({
    videoGraded: true,
    images: [],
    durationSeconds: 9,
    manipulationSuspected: false,
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(r.badge, null);
  assertEquals(r.frames_used, 0);
});

Deno.test("video: suspected manipulation or cross-account reuse withholds the badge", () => {
  const tampered = evaluateVideoCapture({
    videoGraded: true,
    images: FOUR_FRAMES,
    durationSeconds: 12,
    manipulationSuspected: true,
    crossUserReuse: false,
    nowMs: SUBMIT,
  });
  assertEquals(tampered.badge, null);
  assertEquals(tampered.reasons, ["image manipulation suspected"]);

  const reused = evaluateVideoCapture({
    videoGraded: true,
    images: FOUR_FRAMES,
    durationSeconds: 12,
    manipulationSuspected: false,
    crossUserReuse: true,
    nowMs: SUBMIT,
  });
  assertEquals(reused.badge, null);
  assert(reused.reasons[0]!.includes("different account"));
});

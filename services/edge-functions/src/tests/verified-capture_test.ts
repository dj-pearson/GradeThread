// Unit tests for Verified Capture provenance evaluation (US-340).
//
// evaluateVerifiedCapture + parseExifDate are pure (clock injected). No DB/env
// dependency — the module only reads optional tuning env vars that default.
//
//   deno test --allow-env src/tests/verified-capture_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  evaluateVerifiedCapture,
  parseExifDate,
  type VerifiedCaptureImage,
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

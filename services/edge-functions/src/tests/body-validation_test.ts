// Unit tests for the request body-size guard + input validation helpers
// (US-267). Pure functions only — no live APIs, no network.

import { assert, assertEquals } from "@std/assert";
import {
  BodyTooLargeError,
  capBodyStream,
  capForPath,
  JSON_MAX_BYTES,
  UPLOAD_MAX_BYTES,
} from "../middleware/body-limit.ts";
import {
  ALLOWED_IMAGE_MIME,
  decodeBase64Image,
  MAX_DECODED_IMAGE_BYTES,
  zodErrorDetails,
  z,
} from "../lib/validation.ts";

// ── body-limit: per-path caps ───────────────────────────────────────────────

Deno.test("capForPath: upload paths get the 15MB cap", () => {
  assertEquals(capForPath("/api/grade/submit"), UPLOAD_MAX_BYTES);
  assertEquals(capForPath("/api/v1/grades"), UPLOAD_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/images/upload"), UPLOAD_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/disclosure/annotated"), UPLOAD_MAX_BYTES);
});

Deno.test("capForPath: JSON-only paths get the 256KB cap", () => {
  assertEquals(capForPath("/api/payments/checkout"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/keys"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/workspace/invite"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/pricing/scan"), JSON_MAX_BYTES);
});

// The prospect/appraise scan posts its photos as base64 data URIs inside JSON.
// A single 1600px/q0.75 JPEG is ~450-500 KB raw, ~600-670 KB base64, so under
// the 256 KB JSON cap the whole flow answered "Request body too large" on the
// FIRST photo, before the route's own 12 MB check ever ran.
Deno.test("capForPath: photo-bearing JSON endpoints get the upload cap", () => {
  assertEquals(capForPath("/api/flipdesk/scout/prospect"), UPLOAD_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/scout/appraise"), UPLOAD_MAX_BYTES);
  assertEquals(capForPath("/api/grading/public/authenticity-check"), UPLOAD_MAX_BYTES);
  assertEquals(capForPath("/api/buyer/authenticity"), UPLOAD_MAX_BYTES);
});

// Sibling scout routes carry no image bytes and must stay on the JSON cap.
// `appraise-url` is the one that would be easy to widen by accident: it shares
// the first nine characters with `appraise` and submits URLs, never photos.
Deno.test("capForPath: image-free scout siblings stay on the JSON cap", () => {
  assertEquals(capForPath("/api/flipdesk/scout/appraise-url"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/scout/buy"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/scout"), JSON_MAX_BYTES);
});

// eBay evidence uploads are multipart images behind a path parameter, so they
// are matched by an anchored pattern rather than a prefix.
Deno.test("capForPath: eBay evidence uploads match through the path parameter", () => {
  assertEquals(capForPath("/api/flipdesk/ebay/cases/5-1234/evidence"), UPLOAD_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/ebay/returns/abc/evidence"), UPLOAD_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/ebay/payment-disputes/99/evidence"), UPLOAD_MAX_BYTES);
  // Not the multipart upload: the JSON preview, a deeper path, and an unrelated
  // surface that merely ends in the same word.
  assertEquals(capForPath("/api/flipdesk/ebay/evidence/preview"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/ebay/cases/5-1234/evidence/extra"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/flipdesk/ebay/offers/1/evidence"), JSON_MAX_BYTES);
});

Deno.test("capForPath: prefix match is boundary-safe", () => {
  // A path that merely starts with the same letters as an upload prefix but is
  // a different segment must NOT inherit the upload cap.
  assertEquals(capForPath("/api/gradebook"), JSON_MAX_BYTES);
  assertEquals(capForPath("/api/grade"), UPLOAD_MAX_BYTES); // exact prefix is fine
});

// ── body-limit: streaming byte cap (US-362) ──────────────────────────────────

// Helper: build a ReadableStream that emits `count` chunks of `size` bytes.
function chunkedStream(count: number, size: number): ReadableStream<Uint8Array> {
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= count) {
        controller.close();
        return;
      }
      emitted++;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of stream) total += chunk.byteLength;
  return total;
}

Deno.test("capBodyStream: passes a body under the cap through unchanged", async () => {
  // 4 × 100 bytes = 400, under a 1000 cap.
  const total = await drain(capBodyStream(chunkedStream(4, 100), 1000));
  assertEquals(total, 400);
});

Deno.test("capBodyStream: passes a body exactly at the cap", async () => {
  const total = await drain(capBodyStream(chunkedStream(10, 100), 1000));
  assertEquals(total, 1000);
});

Deno.test("capBodyStream: aborts a body that exceeds the cap (no Content-Length needed)", async () => {
  // 20 × 100 = 2000 bytes streamed against a 1000 cap — must abort mid-read.
  const guarded = capBodyStream(chunkedStream(20, 100), 1000);
  let thrown: unknown = null;
  try {
    await drain(guarded);
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof BodyTooLargeError);
  assertEquals((thrown as BodyTooLargeError).maxBytes, 1000);
});

// ── zod error flattening ─────────────────────────────────────────────────────

Deno.test("zodErrorDetails: flattens issues to field:message strings", () => {
  const schema = z.object({
    items: z.array(z.object({ tier: z.enum(["standard", "premium"]) })),
  });
  const res = schema.safeParse({ items: [{ tier: "bogus" }] });
  assert(!res.success);
  const details = zodErrorDetails(res.error);
  assertEquals(details.length, 1);
  assert(details[0].startsWith("items.0.tier:"));
});

// ── base64 image validation ──────────────────────────────────────────────────

// Smallest valid PNG (1x1) + its raw bytes for size assertions.
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
// JPEG SOI + APP0 header bytes, base64-encoded (enough to sniff as image/jpeg).
const JPEG_HEADER_B64 = btoa(
  String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46),
);

Deno.test("decodeBase64Image: accepts a valid PNG with matching MIME", () => {
  const res = decodeBase64Image(PNG_1X1_B64, "image/png");
  assert(res.ok);
  assertEquals(res.image.mime, "image/png");
  assert(res.image.bytes.length > 0);
});

Deno.test("decodeBase64Image: reads MIME from a data URL", () => {
  const res = decodeBase64Image(`data:image/png;base64,${PNG_1X1_B64}`, undefined);
  assert(res.ok);
  assertEquals(res.image.mime, "image/png");
});

Deno.test("decodeBase64Image: accepts a JPEG header", () => {
  const res = decodeBase64Image(JPEG_HEADER_B64, "image/jpeg");
  assert(res.ok);
  assertEquals(res.image.mime, "image/jpeg");
});

Deno.test("decodeBase64Image: rejects declared/actual MIME mismatch", () => {
  // PNG bytes declared as JPEG.
  const res = decodeBase64Image(PNG_1X1_B64, "image/jpeg");
  assert(!res.ok);
  assert(res.error.includes("does not match"));
});

Deno.test("decodeBase64Image: rejects a disallowed MIME", () => {
  const res = decodeBase64Image(PNG_1X1_B64, "image/svg+xml");
  assert(!res.ok);
  assert(res.error.includes("content_type must be one of"));
});

Deno.test("decodeBase64Image: rejects missing content_type", () => {
  const res = decodeBase64Image(PNG_1X1_B64, undefined);
  assert(!res.ok);
  assert(res.error.includes("content_type is required"));
});

Deno.test("decodeBase64Image: rejects malformed base64", () => {
  const res = decodeBase64Image("not*valid*base64!!", "image/png");
  assert(!res.ok);
  assert(res.error.includes("malformed"));
});

Deno.test("decodeBase64Image: rejects non-image bytes", () => {
  const res = decodeBase64Image(btoa("hello world, not an image"), "image/png");
  assert(!res.ok);
});

Deno.test("decodeBase64Image: enforces the byte-size cap", () => {
  // A base64 string whose decoded size exceeds a tiny cap is rejected up front.
  const big = "A".repeat(2048); // ~1536 decoded bytes
  const res = decodeBase64Image(big, "image/png", 512);
  assert(!res.ok);
  assert(res.error.includes("exceeds"));
});

Deno.test("constants: allowlist + default cap are sane", () => {
  assert(ALLOWED_IMAGE_MIME.includes("image/jpeg"));
  assert(ALLOWED_IMAGE_MIME.includes("image/png"));
  assertEquals(MAX_DECODED_IMAGE_BYTES, 10 * 1024 * 1024);
});

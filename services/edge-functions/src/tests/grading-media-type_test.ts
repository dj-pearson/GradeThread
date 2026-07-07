// The Anthropic vision API 400s when the declared image media_type disagrees
// with the actual bytes ("specified image/webp but the image appears to be
// image/jpeg"). Storage object names lie — a `.webp`-named object can hold JPEG
// bytes — which failed whole gradings (front/back/label). mediaTypeForVision
// must derive the type from the magic bytes, not the extension.

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { mediaTypeForVision } = await import("../lib/grading-pipeline.ts");

// Minimal magic-byte headers (>= 12 bytes so the sniffer engages).
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
function webp(): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return b;
}

Deno.test("JPEG bytes behind a .webp path → image/jpeg (the failing case)", () => {
  assertEquals(mediaTypeForVision(JPEG, "u/s/back_123.webp"), "image/jpeg");
});

Deno.test("WEBP bytes behind a .jpg path → image/webp", () => {
  assertEquals(mediaTypeForVision(webp(), "u/s/front_9.jpg"), "image/webp");
});

Deno.test("PNG bytes are detected regardless of extension", () => {
  assertEquals(mediaTypeForVision(PNG, "u/s/label.jpg"), "image/png");
});

Deno.test("matching bytes/extension are unchanged", () => {
  assertEquals(mediaTypeForVision(JPEG, "u/s/front.jpg"), "image/jpeg");
  assertEquals(mediaTypeForVision(webp(), "u/s/front.webp"), "image/webp");
});

Deno.test("unrecognized bytes fall back to the extension", () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assertEquals(mediaTypeForVision(junk, "u/s/x.png"), "image/png");
  assertEquals(mediaTypeForVision(junk, "u/s/x.gif"), "image/gif");
  assertEquals(mediaTypeForVision(junk, "u/s/x.unknown"), "image/jpeg");
});

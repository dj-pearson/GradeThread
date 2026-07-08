// Resilient image transport for the AI extract pipeline: the edge fetches each
// photo itself and inlines the bytes as base64 instead of handing Anthropic the
// raw URLs. A single unreachable/expired/non-image URL must be SKIPPED, not sink
// the whole call (previously one bad photo → 400 "Unable to download" → 502).
//   deno test src/tests/ai-extract-photos_test.ts
import { assertEquals } from "@std/assert";
import type { safeFetch } from "../lib/ssrf.ts";

// ai-extract.ts now imports the brand-knowledge resolver (US-1713), which pulls
// in the service-role supabase client at load, so set dummy env BEFORE the
// dynamic import (same pattern as canonical-attributes_test / research-
// identification_test).
Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildPhotoContent } = await import("../lib/ai-extract.ts");

// Minimal valid magic-byte headers.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

// buildPhotoContent fetches via the SSRF-safe `safeFetch` (resolves DNS + refuses
// private ranges), which ignores a stubbed `globalThis.fetch`. So inject a stub
// fetcher matching safeFetch's `{ status, bytes, contentType }` contract instead.
function fetcherReturning(
  handler: (url: string) => { status: number; bytes: Uint8Array },
): typeof safeFetch {
  return ((url: string) => {
    const { status, bytes } = handler(String(url));
    return Promise.resolve({ status, bytes, contentType: null });
  }) as typeof safeFetch;
}

Deno.test("buildPhotoContent skips an unreachable image and inlines the rest", async () => {
  const fetcher = fetcherReturning((url) =>
    url.includes("bad")
      ? { status: 404, bytes: new Uint8Array() }
      : { status: 200, bytes: JPEG }
  );
  const content = await buildPhotoContent([
    { url: "https://x/good.jpg", type: "front" },
    { url: "https://x/bad.jpg", type: "tag" },
  ], fetcher);
  // good → caption + image (2 blocks); bad → dropped entirely.
  assertEquals(content.length, 2);
  assertEquals(content[0].type, "text");
  assertEquals(content[1].type, "image");
  const img = content[1] as {
    source: { type: string; media_type: string; data: string };
  };
  assertEquals(img.source.type, "base64");
  assertEquals(img.source.media_type, "image/jpeg"); // sniffed, not header-trusted
  assertEquals(img.source.data.length > 0, true);
});

Deno.test("buildPhotoContent drops a non-image payload (sniff fails)", async () => {
  const fetcher = fetcherReturning(() => ({
    status: 200,
    bytes: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
  }));
  const content = await buildPhotoContent([{ url: "https://x/x.bin", type: "front" }], fetcher);
  assertEquals(content.length, 0);
});

Deno.test("buildPhotoContent returns empty when every image fails (no throw)", async () => {
  const fetcher = fetcherReturning(() => ({ status: 500, bytes: new Uint8Array() }));
  const content = await buildPhotoContent([
    { url: "https://x/a.jpg", type: "front" },
    { url: "https://x/b.jpg", type: "back" },
  ], fetcher);
  assertEquals(content.length, 0); // caller proceeds (text-only) instead of 502
});

// Resilient image transport for the AI extract pipeline: the edge fetches each
// photo itself and inlines the bytes as base64 instead of handing Anthropic the
// raw URLs. A single unreachable/expired/non-image URL must be SKIPPED, not sink
// the whole call (previously one bad photo → 400 "Unable to download" → 502).
//   deno test src/tests/ai-extract-photos_test.ts
import { assertEquals } from "@std/assert";
import { buildPhotoContent } from "../lib/ai-extract.ts";

// Minimal valid magic-byte headers.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function stubFetch(handler: (url: string) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(handler(String(input)))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("buildPhotoContent skips an unreachable image and inlines the rest", async () => {
  const restore = stubFetch((url) =>
    url.includes("bad")
      ? new Response("nope", { status: 404 })
      : new Response(JPEG, { status: 200 })
  );
  try {
    const content = await buildPhotoContent([
      { url: "https://x/good.jpg", type: "front" },
      { url: "https://x/bad.jpg", type: "tag" },
    ]);
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
  } finally {
    restore();
  }
});

Deno.test("buildPhotoContent drops a non-image payload (sniff fails)", async () => {
  const restore = stubFetch(() =>
    new Response(new Uint8Array([0x01, 0x02, 0x03, 0x04]), { status: 200 })
  );
  try {
    const content = await buildPhotoContent([{ url: "https://x/x.bin", type: "front" }]);
    assertEquals(content.length, 0);
  } finally {
    restore();
  }
});

Deno.test("buildPhotoContent returns empty when every image fails (no throw)", async () => {
  const restore = stubFetch(() => new Response("err", { status: 500 }));
  try {
    const content = await buildPhotoContent([
      { url: "https://x/a.jpg", type: "front" },
      { url: "https://x/b.jpg", type: "back" },
    ]);
    assertEquals(content.length, 0); // caller proceeds (text-only) instead of 502
  } finally {
    restore();
  }
});

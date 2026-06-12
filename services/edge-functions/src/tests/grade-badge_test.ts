import { assert, assertEquals } from "@std/assert";
import { Image } from "imagescript";
import { compositeGradeBadge } from "../lib/grade-badge.ts";

// Build a plain grey JPEG to badge.
async function sampleJpeg(w: number, h: number): Promise<Uint8Array> {
  const img = new Image(w, h);
  img.fill(0x808080ff);
  return await img.encodeJPEG(90);
}

Deno.test("compositeGradeBadge preserves dimensions and returns a valid JPEG", async () => {
  const src = await sampleJpeg(1200, 1600);
  const out = await compositeGradeBadge(src, 8.5, "EXCELLENT");

  assert(out.byteLength > 0, "expected non-empty output");
  // JPEG SOI marker.
  assertEquals(out[0], 0xff);
  assertEquals(out[1], 0xd8);

  const decoded = await Image.decode(out);
  assertEquals(decoded.width, 1200);
  assertEquals(decoded.height, 1600);
});

Deno.test("compositeGradeBadge works without a tier label", async () => {
  const src = await sampleJpeg(800, 800);
  const out = await compositeGradeBadge(src, 10, null);
  const decoded = await Image.decode(out);
  assertEquals(decoded.width, 800);
  assertEquals(decoded.height, 800);
});

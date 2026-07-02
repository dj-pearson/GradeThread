import { assertEquals } from "@std/assert";
import { Image } from "imagescript";
import {
  generateThumbnail,
  THUMBNAIL_MAX_EDGE,
  thumbnailStoragePath,
} from "../lib/thumbnail.ts";

// Build a solid-color test image of a given size, encoded as PNG bytes.
async function makeImage(w: number, h: number): Promise<Uint8Array> {
  const img = new Image(w, h);
  img.fill(0xff8800ff); // opaque orange
  return await img.encode(); // PNG
}

Deno.test("generateThumbnail caps the LONGEST edge (landscape)", async () => {
  const src = await makeImage(1600, 900);
  const t = await generateThumbnail(src);
  assertEquals(t.width, THUMBNAIL_MAX_EDGE); // 320
  assertEquals(t.height, 180); // aspect preserved (900/1600*320)
  // Re-decode to prove it's a valid JPEG far smaller than the source.
  const decoded = await Image.decode(t.bytes);
  assertEquals(decoded.width, 320);
});

Deno.test("generateThumbnail caps the LONGEST edge (portrait)", async () => {
  const src = await makeImage(900, 1600);
  const t = await generateThumbnail(src);
  assertEquals(t.height, THUMBNAIL_MAX_EDGE); // 320
  assertEquals(t.width, 180);
});

Deno.test("generateThumbnail does not upscale a small image", async () => {
  const src = await makeImage(120, 80);
  const t = await generateThumbnail(src);
  assertEquals(t.width, 120);
  assertEquals(t.height, 80);
});

Deno.test("thumbnailStoragePath inserts thumbs/ and forces .jpg, preserving owner folder", () => {
  assertEquals(
    thumbnailStoragePath("user123/item456/front_1720000000.png"),
    "user123/item456/thumbs/front_1720000000.jpg",
  );
  assertEquals(
    thumbnailStoragePath("a/b/c/back_1.webp"),
    "a/b/c/thumbs/back_1.jpg",
  );
  // No directory → still namespaced under thumbs/
  assertEquals(thumbnailStoragePath("lonely.jpg"), "thumbs/lonely.jpg");
});

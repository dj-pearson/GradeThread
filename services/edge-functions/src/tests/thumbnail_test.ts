import { assertEquals } from "@std/assert";
import { Image } from "imagescript";
import {
  bustedThumbnailUrl,
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

// US-2836: the regenerated thumbnail lands on the SAME deterministic storage
// path every time, so its public URL never changes even though its bytes do.
// Supabase serves public objects with `cache-control: max-age=14400`, so after a
// seller rotates or crops a photo the browser (and the Cloudflare edge) keep
// serving the PRE-EDIT thumbnail for four hours — the grid and the listing
// preview show the original while the full-size view, which reads the
// `?v=`-busted photo_url, shows the edit.
Deno.test("bustedThumbnailUrl makes a re-uploaded thumbnail a new URL", () => {
  const base =
    "https://api.gradethread.com/storage/v1/object/public/item-photos/u/i/thumbs/front_1.jpg";
  assertEquals(bustedThumbnailUrl(base, 1700000000000), `${base}?v=1700000000000`);
  // Two generations of the same object must not collide.
  assertEquals(
    bustedThumbnailUrl(base, 1) === bustedThumbnailUrl(base, 2),
    false,
  );
});

Deno.test("bustedThumbnailUrl keeps an existing query string intact", () => {
  assertEquals(
    bustedThumbnailUrl("https://x/y.jpg?token=abc", 9),
    "https://x/y.jpg?token=abc&v=9",
  );
});

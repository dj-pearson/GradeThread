// US-1413: the public certificate endpoint must serve the FULL photo gallery
// (signed URLs) to anonymous buyers. These tests pin the pure assembly contract
// the SPA relies on — ordering, null-url filtering, and hero selection — so we
// can't regress to the old owner-only anon reads that left logged-out viewers
// with no photos or title.

import { assertEquals } from "@std/assert";
import {
  buildCertGallery,
  galleryRowAt,
  selectHeroUrl,
  type SubmissionImageRow,
} from "../lib/certificate-gallery.ts";

const rows: SubmissionImageRow[] = [
  { id: "b", storage_path: "u/s/back.jpg", image_type: "back", display_order: 1 },
  { id: "f", storage_path: "u/s/front.jpg", image_type: "front", display_order: 0 },
  { id: "l", storage_path: "u/s/label.jpg", image_type: "label", display_order: 2 },
];

const okSigner = (path: string) => Promise.resolve(`https://signed/${path}?t=1`);

Deno.test("buildCertGallery signs every image and returns ascending display_order", async () => {
  const gallery = await buildCertGallery(rows, okSigner);
  assertEquals(gallery.map((g) => g.id), ["f", "b", "l"]);
  assertEquals(gallery.map((g) => g.display_order), [0, 1, 2]);
  // Every entry carries a usable url + type — this is what the SPA grid renders.
  assertEquals(
    gallery.every((g) => g.url.startsWith("https://signed/") && g.image_type),
    true,
  );
});

Deno.test("buildCertGallery drops images whose signed URL fails", async () => {
  // The 'back' image fails to sign → it must be excluded, not rendered broken.
  const flakySigner = (path: string) =>
    Promise.resolve(path.includes("back") ? null : `https://signed/${path}`);
  const gallery = await buildCertGallery(rows, flakySigner);
  assertEquals(gallery.map((g) => g.id), ["f", "l"]);
});

Deno.test("buildCertGallery returns empty for no images (no crash)", async () => {
  assertEquals(await buildCertGallery([], okSigner), []);
});

Deno.test("selectHeroUrl prefers the front photo", async () => {
  const gallery = await buildCertGallery(rows, okSigner);
  assertEquals(selectHeroUrl(rows, gallery), "https://signed/u/s/front.jpg?t=1");
});

Deno.test("selectHeroUrl falls back to the first row when there is no front", async () => {
  const noFront: SubmissionImageRow[] = [
    { id: "d", storage_path: "u/s/detail.jpg", image_type: "detail", display_order: 0 },
    { id: "l", storage_path: "u/s/label.jpg", image_type: "label", display_order: 1 },
  ];
  const gallery = await buildCertGallery(noFront, okSigner);
  assertEquals(selectHeroUrl(noFront, gallery), "https://signed/u/s/detail.jpg?t=1");
});

Deno.test("selectHeroUrl is null when there are no images", () => {
  assertEquals(selectHeroUrl([], []), null);
});

// ── US-2206: the stable-URL position lookup ────────────────────────────────
//
// /cert-photo/<certId>/<n> is a PUBLIC, non-expiring url that appears in the
// Product JSON-LD, so `n` has to resolve to the same photo the page shows,
// forever. A position that quietly addresses the wrong photo would publish one
// garment's picture under another's certificate — the failure worth testing.

Deno.test("galleryRowAt resolves a position in display_order, not row order", () => {
  // `rows` is deliberately NOT in display_order (back=1 comes first).
  assertEquals(galleryRowAt(rows, 0)?.image_type, "front");
  assertEquals(galleryRowAt(rows, 1)?.image_type, "back");
  assertEquals(galleryRowAt(rows, 2)?.image_type, "label");
});

Deno.test("galleryRowAt agrees with the gallery the endpoint serves", async () => {
  // The JSON-LD indexes into the SAME ordering the gallery renders, so index i
  // of the built gallery and position i here must be the same photo.
  const gallery = await buildCertGallery(rows, okSigner);
  for (let i = 0; i < gallery.length; i++) {
    assertEquals(galleryRowAt(rows, i)?.id, gallery[i].id);
  }
});

Deno.test("galleryRowAt refuses out-of-range and non-integer positions", () => {
  // Each of these must be null so the endpoint serves its fallback rather than
  // throwing or wrapping around to a different garment's photo.
  assertEquals(galleryRowAt(rows, 3), null);
  assertEquals(galleryRowAt(rows, -1), null);
  assertEquals(galleryRowAt(rows, 1.5), null);
  assertEquals(galleryRowAt(rows, Number.NaN), null);
  assertEquals(galleryRowAt([], 0), null);
});

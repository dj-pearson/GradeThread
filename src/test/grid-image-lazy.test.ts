import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { itemPhotoThumb } from "@/lib/images";

// US-413: list/grid/card views must not download full-resolution originals for
// off-screen cards. Cloudflare Image Resizing is disabled on the zone, so we
// can't lean on a /cdn-cgi/image srcset; the guarantee instead is:
//   (a) photo grids served from item_photos use the stored thumbnail_url, and
//   (b) every grid/card <img> carries loading="lazy" so the browser skips
//       fetching off-screen cards until they scroll near the viewport.
//
// This is a source-scan regression guard (same style as responsive-images.test.ts):
// for each known multi-image grid view, locate the grid's data-driven <img> by
// its dynamic `src` expression and assert it lazy-loads. Single hero images,
// full-screen lightboxes, and in-memory client previews are intentionally NOT
// listed here — they are not off-screen grid cards.

/** Read a source file and return the full `<img ... />` tag whose attributes
 * contain `srcNeedle`. Throws if no such tag is found (keeps the guard honest:
 * a rename that drops the src will fail loudly rather than silently pass). */
function imgTagWithSrc(relPath: string, srcNeedle: string): string {
  const full = readFileSync(resolve(process.cwd(), relPath), "utf8");
  for (const match of full.matchAll(/<img\b[\s\S]*?\/>/g)) {
    if (match[0].includes(srcNeedle)) return match[0];
  }
  throw new Error(`No <img> with src \`${srcNeedle}\` found in ${relPath}`);
}

// Each entry: [file, the dynamic src expression that identifies the grid img].
const GRID_IMAGES: ReadonlyArray<readonly [string, string]> = [
  // item_photos grids — render via itemPhotoThumb(), which prefers thumbnail_url
  // and falls back to photo_url (the fallback is asserted on the helper below).
  ["src/components/flipdesk/photo-manager.tsx", "itemPhotoThumb(photo)"],
  ["src/components/flipdesk/photo-uploader.tsx", "itemPhotoThumb(first)"],
  ["src/pages/flipdesk/listings.tsx", "itemPhotoThumb(cover)"],
  // AutoLister grids render through the StagedThumb retry wrapper — the actual
  // <img> lives inside it, fed the itemPhotoThumb-resolved `url`.
  ["src/pages/flipdesk/autolister.tsx", "src={url}"],
  // Storefront cards — the edge serves thumbnail_url in this field (content-public.ts).
  ["src/pages/verified-seller.tsx", "listing.photo_url"],
  ["src/components/verified/graded-photo-panel.tsx", "src={url}"],
  // eBay comps gallery — external thumbnails.
  ["src/components/flipdesk/ebay-comps-panel.tsx", "c.imageUrl"],
  // Grading/submission image grids (submission-images bucket has no thumbnails,
  // so these are full-res signed URLs — lazy loading is what bounds their weight).
  ["src/pages/submission-detail.tsx", "imageUrls[img.id]"],
  ["src/pages/certificate.tsx", "imageUrls[img.id]"],
  ["src/pages/admin/disputes.tsx", "photoUrls[img.id]"],
  ["src/pages/admin/moderation.tsx", "src={img.url}"],
  ["src/pages/admin/reviews.tsx", "img.signed_url"],
];

describe("grid/card images lazy-load (US-413)", () => {
  for (const [file, src] of GRID_IMAGES) {
    it(`${file}: grid <img> for \`${src}\` sets loading="lazy"`, () => {
      const tag = imgTagWithSrc(file, src);
      expect(tag).toContain('loading="lazy"');
    });
  }
});

describe("item_photos grids prefer the stored thumbnail (US-413)", () => {
  // These three render from item_photos, which carries a generated thumbnail_url
  // (migration 00035). The thumbnail-first fallback (thumbnail_url ?? photo_url)
  // is centralized in itemPhotoThumb() (src/lib/images.ts); assert each grid
  // reaches for that helper rather than inlining the full-res original.
  const USES_THUMB_HELPER: ReadonlyArray<readonly [string, string]> = [
    ["src/components/flipdesk/photo-manager.tsx", "itemPhotoThumb(photo)"],
    ["src/components/flipdesk/photo-uploader.tsx", "itemPhotoThumb(first)"],
    ["src/pages/flipdesk/listings.tsx", "itemPhotoThumb(cover)"],
  ];
  for (const [file, expr] of USES_THUMB_HELPER) {
    it(`${file}: grid <img> renders via itemPhotoThumb`, () => {
      const tag = imgTagWithSrc(file, expr);
      expect(tag).toContain("itemPhotoThumb");
    });
  }

  it("autolister grids resolve thumbnails via itemPhotoThumb into StagedThumb", () => {
    // The AutoLister <img> lives inside the StagedThumb retry wrapper, so the
    // thumbnail-first resolution happens at its call sites — assert every
    // StagedThumb src goes through itemPhotoThumb with the stored thumbnail.
    const full = readFileSync(
      resolve(process.cwd(), "src/pages/flipdesk/autolister.tsx"),
      "utf8",
    );
    const usages = [...full.matchAll(/<StagedThumb\b[\s\S]*?\/>/g)];
    expect(usages.length).toBeGreaterThan(0);
    for (const usage of usages) {
      expect(usage[0]).toContain("itemPhotoThumb");
      expect(usage[0]).toContain("thumbnail_url");
    }
  });

  it("itemPhotoThumb() prefers thumbnail_url, then falls back to photo_url", () => {
    expect(itemPhotoThumb({ thumbnail_url: "t.jpg", photo_url: "p.jpg" })).toBe("t.jpg");
    expect(itemPhotoThumb({ thumbnail_url: null, photo_url: "p.jpg" })).toContain("p.jpg");
    expect(itemPhotoThumb({ thumbnail_url: null, photo_url: null })).toBe("");
  });
});

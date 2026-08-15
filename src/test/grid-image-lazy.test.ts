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

/** Read a source file and return the full `<Tag ... />` element whose attributes
 * contain `needle`. Throws if no such tag is found (keeps the guard honest:
 * a rename that drops the src will fail loudly rather than silently pass). */
function tagWith(relPath: string, tagName: string, needle: string): string {
  const full = readFileSync(resolve(process.cwd(), relPath), "utf8");
  const open = new RegExp(`<${tagName}\\b[\\s\\S]*?\\/>`, "g");
  for (const match of full.matchAll(open)) {
    if (match[0].includes(needle)) return match[0];
  }
  throw new Error(`No <${tagName}> with \`${needle}\` found in ${relPath}`);
}

const imgTagWithSrc = (relPath: string, srcNeedle: string) =>
  tagWith(relPath, "img", srcNeedle);

// item_photos grids render through <ItemPhotoImg> (US-2273), which resolves the
// display URL via itemPhotoThumb() for public photos and mints a short-lived
// signed URL for the private-bucket iOS cases. It spreads the remaining props
// onto its inner <img>, so loading="lazy" set here reaches the DOM.
// Each entry: [file, the `photo={…}` expression that identifies the GRID usage].
// Full-screen viewers pass `full` and are deliberately not lazy — matching on the
// grid's own photo expression keeps them out of this list.
const ITEM_PHOTO_GRIDS: ReadonlyArray<readonly [string, string]> = [
  ["src/components/flipdesk/photo-manager.tsx", "photo={photo}"],
  ["src/components/flipdesk/photo-uploader.tsx", "photo={first}"],
  // US-2173: the listings table moved into its own component; the cover
  // thumbnail moved with it.
  ["src/pages/flipdesk/listings-table.tsx", "photo={cover}"],
];

// Each entry: [file, the dynamic src expression that identifies the grid img].
const GRID_IMAGES: ReadonlyArray<readonly [string, string]> = [
  // AutoLister grids render through the StagedThumb retry wrapper — the actual
  // <img> lives inside it, fed the itemPhotoThumb-resolved `url`. StagedThumb
  // moved to autolister/photo-drag-tiles.tsx with the rest of the tile-level
  // pieces (US-2520 ratchet); the call sites that feed it are still in the page,
  // which is what the itemPhotoThumb assertion below checks.
  ["src/pages/flipdesk/autolister/photo-drag-tiles.tsx", "src={url}"],
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
];

describe("grid/card images lazy-load (US-413)", () => {
  for (const [file, src] of GRID_IMAGES) {
    it(`${file}: grid <img> for \`${src}\` sets loading="lazy"`, () => {
      const tag = imgTagWithSrc(file, src);
      expect(tag).toContain('loading="lazy"');
    });
  }

  for (const [file, expr] of ITEM_PHOTO_GRIDS) {
    it(`${file}: grid <ItemPhotoImg> for \`${expr}\` sets loading="lazy"`, () => {
      const tag = tagWith(file, "ItemPhotoImg", expr);
      expect(tag).toContain('loading="lazy"');
    });
  }

  it("ItemPhotoImg forwards loading/decoding through to its <img>", () => {
    // The lazy attribute above is only real if the component spreads it on.
    const src = readFileSync(
      resolve(process.cwd(), "src/components/flipdesk/item-photo-img.tsx"),
      "utf8",
    );
    const tag = tagWith("src/components/flipdesk/item-photo-img.tsx", "img", "src={url}");
    expect(tag).toContain("{...imgProps}");
    // …and only after `src` is pulled out of the props, so it cannot be overridden.
    expect(src).toContain('Omit<ImgHTMLAttributes<HTMLImageElement>, "src">');
  });
});

describe("item_photos grids prefer the stored thumbnail (US-413)", () => {
  // These three render from item_photos, which carries a generated thumbnail_url
  // (migration 00035). The thumbnail-first fallback (thumbnail_url ?? photo_url)
  // is centralized in itemPhotoThumb() (src/lib/images.ts). Since US-2273 the
  // grids no longer call it directly — they render <ItemPhotoImg>, which routes
  // the non-`full` path through the same helper. So assert the two halves:
  // the grids use the component, and the component reaches for the helper.
  for (const [file, expr] of ITEM_PHOTO_GRIDS) {
    it(`${file}: grid renders via <ItemPhotoImg>, not a raw full-res <img>`, () => {
      const tag = tagWith(file, "ItemPhotoImg", expr);
      // `full` serves photo_url instead of the thumbnail — never right for a grid.
      expect(tag).not.toMatch(/(^|\s)full(\s|=|\/|>)/);
    });
  }

  it("ItemPhotoImg resolves non-full photos through itemPhotoThumb", () => {
    for (const path of ["src/hooks/use-item-photo-url.ts", "src/lib/item-photo-url.ts"]) {
      const src = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(src).toContain("itemPhotoThumb");
      // The full-res original is reachable only behind the explicit `full` opt-in.
      expect(src).toMatch(/full\s*\?\s*\(?photo\.photo_url/);
    }
  });

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

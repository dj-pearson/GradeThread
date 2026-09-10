import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROUTE_OG_IMAGES,
  DEFAULT_OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  ogImageForRoute,
  getRouteMeta,
  PUBLIC_ROUTES,
  SITE_URL,
} from "../public-routes";

// US-427: guard the per-route social images. Every og:image we advertise must
// resolve to a real 1200×630 PNG on disk so unfurls (X card / Slack) never hit a
// 404 and always get the dimensions declared in og:image:width/height.

/** width/height from a PNG's IHDR chunk (bytes 16–23, big-endian). */
function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const publicDir = resolve(process.cwd(), "public");

const allImagePaths = [
  DEFAULT_OG_IMAGE_PATH,
  ...Object.values(ROUTE_OG_IMAGES).map((e) => e.file),
];

describe("OG social images (US-427)", () => {
  it.each(allImagePaths)("%s exists and is 1200×630 PNG", (file) => {
    const abs = resolve(publicDir, file.replace(/^\//, ""));
    expect(existsSync(abs)).toBe(true);
    const { w, h } = pngSize(readFileSync(abs));
    expect(w).toBe(OG_IMAGE_WIDTH);
    expect(h).toBe(OG_IMAGE_HEIGHT);
  });

  it("serves per-route images from /social/ (never the Functions-routed /og/)", () => {
    for (const { file } of Object.values(ROUTE_OG_IMAGES)) {
      expect(file.startsWith("/social/")).toBe(true);
    }
  });

  it("gives every registered route a card that names it, not the shared default", () => {
    // 268 of the 276 routes had no bespoke image and fell to /og-image.png, so
    // a share of a fee calculator and a share of the pricing page unfurled as
    // the same picture. Each now gets a branded card rendered from its title.
    const shared = `${SITE_URL}${DEFAULT_OG_IMAGE_PATH}`;
    const cards = PUBLIC_ROUTES.map((r) => ogImageForRoute(r.path));
    expect(cards.filter((c) => c.url === shared)).toEqual([]);
    // And the cards are distinct, which is the whole point of having them.
    expect(new Set(cards.map((c) => c.url)).size).toBe(PUBLIC_ROUTES.length);
    for (const c of cards) expect(c.alt.length).toBeGreaterThan(0);
  });

  it("renders the card at the ratio whose size matches the declared dimensions", () => {
    // og:image:width/height are emitted as constants, so the card has to be the
    // landscape ratio (1200x630) or every unfurl is told the wrong size.
    expect(OG_IMAGE_WIDTH).toBe(1200);
    expect(OG_IMAGE_HEIGHT).toBe(630);
    const url = new URL(ogImageForRoute("/tools/ebay-fee-calculator").url);
    expect(url.pathname).toBe("/og/social/card");
    expect(url.searchParams.get("ratio")).toBe("landscape");
    expect(url.searchParams.get("text")).toBe(
      getRouteMeta("/tools/ebay-fee-calculator")!.title,
    );
  });

  it("puts the FlipDesk mark on FlipDesk pages only", () => {
    const product = (p: string) =>
      new URL(ogImageForRoute(p).url).searchParams.get("product");
    expect(product("/flipdesk/comps")).toBe("flipdesk");
    expect(product("/tools/ebay-fee-calculator")).toBe("gradethread");
  });

  it("keeps the social card OUT of the image sitemap's registry", () => {
    // ROUTE_OG_IMAGES feeds the seo-manifest `image` field and from there
    // sitemap-images.xml, which is for pictures a page is ABOUT. A social card
    // is a picture OF the page, so the fallback must not land in here.
    for (const { file } of Object.values(ROUTE_OG_IMAGES)) {
      expect(file).not.toContain("/og/social/card");
    }
  });

  it("ogImageForRoute returns the route image, else the site default", () => {
    expect(ogImageForRoute("/pricing").url).toBe(`${SITE_URL}/social/pricing.png`);
    // trailing slash normalizes to the same per-route image
    expect(ogImageForRoute("/pricing/").url).toBe(`${SITE_URL}/social/pricing.png`);
    expect(ogImageForRoute("/some-unmapped-route").url).toBe(
      `${SITE_URL}${DEFAULT_OG_IMAGE_PATH}`,
    );
    expect(ogImageForRoute("/pricing").alt.length).toBeGreaterThan(0);
  });
});

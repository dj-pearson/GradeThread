import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROUTE_OG_IMAGES,
  DEFAULT_OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  ogImageForRoute,
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

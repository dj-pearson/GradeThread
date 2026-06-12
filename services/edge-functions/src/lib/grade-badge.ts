// Server-side compositing of a GradeThread grade badge onto a listing photo.
//
// This is the Deno/edge counterpart of the browser-side compositor in
// src/lib/grade-badge.ts. It runs at PUBLISH time (assemblePublishContext in
// routes/flipdesk-ebay.ts) so the badge reaches eBay for EVERY publish path —
// manual, AutoLister, scheduled, bulk — not just when a human opens the
// composer. The visual mirrors the client badge: an Obsidian-Navy card in the
// bottom-right with a Crimson accent stripe and white "GRADETHREAD VERIFIED /
// {grade} / 10 / {tier}" text.
//
// Text is rasterized with Roboto-Bold (Apache-2.0, see assets/Roboto-LICENSE.txt)
// because ImageScript's renderText needs a font buffer — there is no built-in
// default. The font is bundled in assets/ and COPYed into the container image.

import { Image } from "imagescript";

// Refreshed media-kit palette (design.md §2A). RGBA ints (0xRRGGBBAA) to match
// the client tokens in src/index.css / src/lib/grade-badge.ts.
const NAVY = 0x0c1e36ff;
const RED = 0xf03d5fff;
const WHITE = 0xffffffff;

let fontCache: Uint8Array | null = null;
async function loadFont(): Promise<Uint8Array> {
  if (!fontCache) {
    fontCache = await Deno.readFile(
      new URL("../../assets/Roboto-Bold.ttf", import.meta.url),
    );
  }
  return fontCache;
}

/**
 * Burns a grade badge into the bottom-right corner of a JPEG/PNG and returns
 * the result as JPEG bytes. Dimensions are preserved. Throws on a decode/encode
 * failure so the caller can fall back to the original image (publish must never
 * be blocked by a badge failure).
 */
export async function compositeGradeBadge(
  imageBytes: Uint8Array,
  grade: number,
  label: string | null,
): Promise<Uint8Array> {
  const font = await loadFont();
  const image = await Image.decode(imageBytes);

  const W = image.width;
  const H = image.height;

  // Size the badge relative to the shorter edge so it scales across photos.
  const unit = Math.min(W, H);
  const pad = Math.round(unit * 0.04);
  const badgeW = Math.round(unit * 0.4);
  const badgeH = Math.round(badgeW * 0.46);
  // ImageScript pixel ops are 1-indexed (top-left pixel is (1,1)).
  const bx = Math.max(1, W - badgeW - pad);
  const by = Math.max(1, H - badgeH - pad);

  // Navy card + red accent stripe down the left edge.
  image.drawBox(bx, by, badgeW, badgeH, NAVY);
  image.drawBox(bx, by, Math.max(2, Math.round(badgeW * 0.07)), badgeH, RED);

  // Text column starts just past the accent stripe. composite() takes a 0-based
  // offset, so subtract 1 from the 1-based card coordinates.
  const textX = bx - 1 + Math.round(badgeW * 0.16);
  const top = by - 1;

  const titleImg = await Image.renderText(
    font,
    Math.max(8, Math.round(badgeH * 0.13)),
    "GRADETHREAD VERIFIED",
    WHITE,
  );
  image.composite(titleImg, textX, top + Math.round(badgeH * 0.14));

  const gradeImg = await Image.renderText(
    font,
    Math.max(12, Math.round(badgeH * 0.36)),
    `${grade.toFixed(1)} / 10`,
    WHITE,
  );
  image.composite(gradeImg, textX, top + Math.round(badgeH * 0.34));

  if (label && label.trim()) {
    const labelImg = await Image.renderText(
      font,
      Math.max(7, Math.round(badgeH * 0.14)),
      label.toUpperCase(),
      WHITE,
    );
    image.composite(labelImg, textX, top + Math.round(badgeH * 0.78));
  }

  return await image.encodeJPEG(90);
}

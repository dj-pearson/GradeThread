// Server-side perceptual hashing for photo-reuse detection (US-480).
//
// Reuse detection (US-337) compares 64-bit dHashes (16 hex chars) with a small
// Hamming threshold. Originally the hash was computed in the browser and sent
// with the upload — a value fraud could simply forge to dodge a match against a
// stolen/stock photo already on file. This module recomputes the dHash on the
// server from the actual validated upload bytes, so the hash reuse detection
// runs on can never be influenced by the client.
//
// The algorithm mirrors the browser dHash in src/lib/image-utils.ts exactly so
// server-computed hashes stay comparable to the client-computed hashes already
// stored: downscale to 9x8, grayscale via Rec.601 luma, emit one bit per
// horizontal-neighbor comparison (left > right), MSB-first, as 16 hex chars.
//
// Decoding is shared with the colour measurement in image-decode.ts (US-2975);
// it used to live here, which was the only copy. Any decode/hash
// failure returns null — exactly like the browser's "" fallback — so hashing
// can never block an upload; reuse detection simply skips that image.

import { decodeToRgba } from "./image-decode.ts";
import type { ImageFormat } from "./upload-validation.ts";

const W = 9;
const H = 8;

/**
 * Compute the 64-bit dHash (16 hex chars) from a row-major RGBA pixel buffer.
 *
 * Area-averages the source into a 9x8 grid (the closest deterministic analogue
 * to the browser canvas's downscale), greyscales each cell with the same
 * 0.299/0.587/0.114 weights as the client, then compares horizontal neighbours.
 * Pure + deterministic → identical bytes always yield the identical hash, which
 * is what makes cross-account reuse detectable regardless of any client value.
 *
 * Returns null for an empty/degenerate buffer so a bad decode can't fabricate a
 * hash (and therefore can't fabricate a match).
 */
export function dHashFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (width <= 0 || height <= 0) return null;
  if (rgba.length < width * height * 4) return null;

  // Greyscale value of the area-averaged RGB for each of the 72 grid cells.
  const grid = new Float64Array(W * H);
  for (let ty = 0; ty < H; ty++) {
    const sy0 = Math.floor((ty * height) / H);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * height) / H));
    for (let tx = 0; tx < W; tx++) {
      const sx0 = Math.floor((tx * width) / W);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * width) / W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < width; sx++) {
          const i = (sy * width + sx) * 4;
          r += rgba[i] ?? 0;
          g += rgba[i + 1] ?? 0;
          b += rgba[i + 2] ?? 0;
          n++;
        }
      }
      if (n === 0) n = 1;
      grid[ty * W + tx] = 0.299 * (r / n) + 0.587 * (g / n) + 0.114 * (b / n);
    }
  }

  let bits = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const left = grid[y * W + x] ?? 0;
      const right = grid[y * W + x + 1] ?? 0;
      bits += left > right ? "1" : "0";
    }
  }
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}

/**
 * Recompute the perceptual hash server-side from validated upload bytes.
 * Returns the 16-hex dHash, or null if the image can't be decoded/hashed
 * (in which case the caller stores null and reuse detection skips the image).
 */
export async function computePhashFromImage(
  bytes: Uint8Array,
  format: ImageFormat,
): Promise<string | null> {
  const decoded = await decodeToRgba(bytes, format);
  if (!decoded) return null;
  return dHashFromRgba(decoded.rgba, decoded.width, decoded.height);
}

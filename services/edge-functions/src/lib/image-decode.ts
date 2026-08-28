// One decoder for every server-side pixel read (US-2975).
//
// Lifted verbatim out of perceptual-hash.ts, which had the only copy, when the
// colour measurement needed the same thing. JPEG/PNG go through imagescript
// (already a dependency); WebP through @jsquash, lazy-loaded so the JPEG/PNG
// path never pays for its wasm. HEIC has no decoder here and returns null.
//
// Every failure is a null, never a throw: a photo that cannot be decoded must
// degrade the feature that wanted the pixels, never break the request.

import { Image } from "imagescript";
import type { ImageFormat } from "./upload-validation.ts";

export interface DecodedImage {
  /** Row-major RGBA, 8 bits per channel. */
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** Media types the edge sniffs from magic bytes, mapped to a decodable format. */
export function formatFromMediaType(mediaType: string): ImageFormat | null {
  switch (mediaType) {
    case "image/jpeg":
      return "jpeg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return null; // gif and anything else: no pixel reader wants it
  }
}

/**
 * Decode image bytes to a row-major RGBA buffer. Returns null when the format
 * isn't decodable here (HEIC, GIF) or the decoder throws on corrupt bytes.
 */
export async function decodeToRgba(
  bytes: Uint8Array,
  format: ImageFormat,
): Promise<DecodedImage | null> {
  try {
    if (format === "jpeg" || format === "png") {
      const img = await Image.decode(bytes);
      // imagescript Image.bitmap is a row-major RGBA Uint8ClampedArray.
      return { rgba: img.bitmap, width: img.width, height: img.height };
    }
    if (format === "webp") {
      const { decode } = await import("@jsquash/webp");
      const data = await decode(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
      // jsquash returns 8-bit RGBA at runtime; the DOM ImageData type now widens
      // `.data` to include Float16Array (HDR), so coerce to the 8-bit view.
      const rgba = data.data as unknown as Uint8ClampedArray;
      return { rgba, width: data.width, height: data.height };
    }
    return null;
  } catch (err) {
    console.error(
      "[image-decode] decode failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

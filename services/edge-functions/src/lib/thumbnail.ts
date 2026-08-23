import { Image } from "imagescript";

// US-1518: server-side thumbnail generation. Decodes an image (JPEG/PNG/WebP —
// whatever ImageScript reads), downscales the LONGEST edge to `maxEdge`, and
// re-encodes as JPEG. Because it re-encodes from decoded pixels, the output
// carries NO EXIF/GPS — it satisfies the US-276 metadata-strip requirement for
// the thumbnail object inherently (no separate strip pass needed).
//
// Used by the thumbnail-backfill cron (jobs-thumbnail-backfill.ts) to populate
// item_photos.thumbnail_url for BOTH existing photos and new iOS uploads (the
// iOS foreground uploader deliberately does ONE PUT per photo against a fragile
// self-hosted storage backend, so a client-side second encode/PUT is avoided —
// AC1's sanctioned "or an edge job" path). The web upload path already generates
// its own client-side thumbnail (photo-uploader.tsx); those rows are skipped.

/** Longest-edge pixel cap for a generated thumbnail. 320px covers 56pt inventory
 * rows and board cards at up to ~3x density with headroom. */
export const THUMBNAIL_MAX_EDGE = 320;

/** JPEG quality (1–100). Perceptual quality is already saturated at this size, so
 * a lower quality keeps the object small (the whole point — pure transfer win). */
export const THUMBNAIL_JPEG_QUALITY = 70;

export interface ThumbnailResult {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * Decode `bytes` and produce a JPEG thumbnail whose longest edge is at most
 * `maxEdge`. An image already at/below `maxEdge` is re-encoded at the thumbnail
 * quality (still a transfer win vs a 1600px original) but not upscaled. Throws
 * if the bytes aren't a decodable image.
 */
export async function generateThumbnail(
  bytes: Uint8Array,
  maxEdge: number = THUMBNAIL_MAX_EDGE,
  quality: number = THUMBNAIL_JPEG_QUALITY,
): Promise<ThumbnailResult> {
  const image = await Image.decode(bytes);
  const longest = Math.max(image.width, image.height);
  if (longest > maxEdge) {
    // Cap the LONGEST edge; ImageScript's RESIZE_AUTO preserves aspect ratio.
    if (image.width >= image.height) {
      image.resize(maxEdge, Image.RESIZE_AUTO);
    } else {
      image.resize(Image.RESIZE_AUTO, maxEdge);
    }
  }
  const out = await image.encodeJPEG(quality);
  return { bytes: out, width: image.width, height: image.height };
}

/**
 * Derive a deterministic thumbnail storage path from a full-image storage path,
 * inserting a `thumbs/` segment before the filename and forcing a `.jpg`
 * extension. Mirrors the web uploader's `{owner}/{item}/thumbs/{name}` layout so
 * the per-user-folder storage RLS (`foldername[1] = auth.uid()`) still passes —
 * the owner segment (folder 1) is preserved.
 *   `a/b/front_123.png` → `a/b/thumbs/front_123.jpg`
 */
export function thumbnailStoragePath(storagePath: string): string {
  const slash = storagePath.lastIndexOf("/");
  const dir = slash >= 0 ? storagePath.slice(0, slash) : "";
  const file = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const dot = file.lastIndexOf(".");
  const stem = dot >= 0 ? file.slice(0, dot) : file;
  return dir ? `${dir}/thumbs/${stem}.jpg` : `thumbs/${stem}.jpg`;
}

/**
 * Append a cache-buster to a regenerated thumbnail's public URL (US-2836).
 *
 * THE BUG THIS FIXES: `thumbnailStoragePath` is deterministic, so every
 * regeneration of a given photo's thumbnail lands on the SAME object key and
 * therefore the same public URL. After a seller rotates or crops a photo,
 * `persistPhotoEdit` nulls `thumbnail_url` and deletes the object; the backfill
 * cron then rebuilds it from the new pixels and wrote back the identical URL.
 * Supabase serves public objects with `cache-control: max-age=14400`, so the
 * browser and the Cloudflare edge kept handing out the PRE-EDIT thumbnail for
 * four hours.
 *
 * The seller saw exactly that split: every surface reading `thumbnail_url` (the
 * composer photo grid, the eBay listing-preview thumb rail, inventory covers)
 * showed the original, while the full-size view and the preview hero — which
 * read `photo_url`, and `persistPhotoEdit` already busts that one with `?v=` —
 * showed the edit. Same convention here, for the same reason.
 */
export function bustedThumbnailUrl(
  publicUrl: string,
  now: number = Date.now(),
): string {
  const sep = publicUrl.includes("?") ? "&" : "?";
  return `${publicUrl}${sep}v=${now}`;
}

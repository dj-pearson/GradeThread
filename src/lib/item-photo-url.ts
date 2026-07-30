// Display-URL resolver for item_photos rows (US-2273).
//
// THE BUG THIS FIXES: a seller catalogs on iPhone and finishes on the laptop.
// iOS uploads Garment Tag / certificate close-ups to the PRIVATE submission-
// images bucket and writes photo_url = "" with no thumbnail_url (they can carry
// PII — serials, receipts, cert numbers — so they must never sit in the public
// item-photos bucket). On the web, itemPhotoThumb() then falls through both its
// branches and returns "", which renders as a broken <img>. The row, its
// storage_path and its bytes are all correct — this is purely a client READ
// path with no display URL for the private bucket.
//
// Resolution:
//   • Sensitive type (tag/tag_2/certificate) with an empty photo_url and a
//     storage_path → mint a SHORT-LIVED signed URL on submission-images, cached
//     per storage_path so a scrolling gallery does not re-sign every frame.
//   • Everything else (front/back, or a web-uploaded tag that already carries a
//     public photo_url) → the existing itemPhotoThumb() path, unchanged.
//
// The signed URL is a DISPLAY artifact only. It is short-lived and must never be
// persisted onto a listing or handed to a public destination (eBay payload,
// share, export) — those paths use itemPhotoPublishUrl() instead, which never
// returns a signed URL.

import { getImageUrl, SIGNED_URL_TTL_SECONDS } from "./storage";
import { isSensitivePhotoType } from "./constants";
import { itemPhotoThumb } from "./images";

// Re-sign this many ms BEFORE the URL actually expires, so a render never hands
// out a URL that dies mid-request. Mirrors iOS PhotoSignedURLProvider.refreshSkew.
export const SIGNED_URL_REFRESH_SKEW_MS = 60_000;

export interface PhotoLike {
  photo_type?: string | null;
  photo_url?: string | null;
  thumbnail_url?: string | null;
  storage_path?: string | null;
}

/**
 * True when the row can only be displayed via a signed private-bucket URL: a
 * sensitive type, no public photo_url, and a storage_path to sign. This is the
 * iOS private-upload shape; a web-uploaded tag that carries a photo_url does not
 * match and keeps its existing (public) display path.
 */
export function needsSignedDisplayUrl(photo: PhotoLike): boolean {
  return (
    isSensitivePhotoType(photo.photo_type) &&
    !(photo.photo_url ?? "") &&
    !!(photo.storage_path ?? "")
  );
}

/**
 * The URL that is safe to PERSIST onto a listing or hand to a PUBLIC destination
 * (eBay image payload, share sheet, export). Deliberately NEVER a signed URL:
 * signed URLs are short-lived, and a sensitive private-bucket photo must not be
 * published at all. Returns the row's persisted public photo_url — which is ""
 * for an iOS private upload, keeping it out of any public payload exactly as it
 * was before US-2273. Publish/export code paths MUST use this, not
 * resolveItemPhotoDisplayUrl().
 */
export function itemPhotoPublishUrl(photo: PhotoLike): string {
  return photo.photo_url ?? "";
}

interface CacheEntry {
  url: string;
  expiresAt: number;
}

// Module-level cache keyed by storage_path. A signed URL for a given object is
// identical regardless of which surface asks for it, so the cache is global.
const signedUrlCache = new Map<string, CacheEntry>();

/** Test seam: drop the cache so cases don't leak signed URLs into each other. */
export function _clearItemPhotoUrlCache(): void {
  signedUrlCache.clear();
}

// Returns a signed submission-images URL, or "" on failure. Reuses storage.ts's
// getImageUrl so the private-bucket bucket name AND the 900s TTL cap live in one
// place (the signed-url-ttl guard already polices that single call site).
export type SignedUrlSigner = (path: string) => Promise<string>;

const defaultSigner: SignedUrlSigner = async (path) => {
  try {
    return await getImageUrl(path);
  } catch {
    return "";
  }
};

export interface ResolveOptions {
  /** Thumbnail render width for the non-signed (public) path. */
  width?: number;
  /**
   * Want the ORIGINAL, not a thumbnail (full-screen viewer / zoom). Only affects
   * the public path — a signed private-bucket URL already points at the original
   * object either way, since sensitive photos have no separate thumbnail.
   */
  full?: boolean;
  /** Injected for tests. */
  sign?: SignedUrlSigner;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * Resolve a display URL for an item photo. Signed (and cached) for the private-
 * bucket sensitive case; the plain itemPhotoThumb() path otherwise. A failed
 * mint returns "" so the caller can render a labelled placeholder rather than a
 * broken image icon.
 */
export async function resolveItemPhotoDisplayUrl(
  photo: PhotoLike,
  opts: ResolveOptions = {},
): Promise<string> {
  if (!needsSignedDisplayUrl(photo)) {
    return opts.full ? (photo.photo_url ?? "") : itemPhotoThumb(photo, opts.width);
  }

  const path = photo.storage_path as string;
  const now = opts.now ?? Date.now;
  const cached = signedUrlCache.get(path);
  if (cached && cached.expiresAt - SIGNED_URL_REFRESH_SKEW_MS > now()) {
    return cached.url;
  }

  const sign = opts.sign ?? defaultSigner;
  const signedUrl = await sign(path);
  if (!signedUrl) {
    // Degrade to a labelled placeholder rather than a broken image icon.
    return "";
  }
  signedUrlCache.set(path, {
    url: signedUrl,
    expiresAt: now() + SIGNED_URL_TTL_SECONDS * 1000,
  });
  return signedUrl;
}

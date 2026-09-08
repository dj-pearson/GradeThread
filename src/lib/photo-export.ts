// US-724: per-platform photo export.
//
// Bundles an item's listing photos into a zip, ordered cover-first then by
// sort_order, capped to the target platform's photo limit (US-719), with names
// that encode the upload order (01_front.jpg, 02_back.jpg, …) so a manual
// lister can drag them straight into Poshmark/Mercari/Grailed/Depop.
//
// EXIF/GPS: item-photos are EXIF-stripped at UPLOAD time (US-276,
// stripImageMetadata in the edge), and the bucket holds only seller-intended
// listing imagery — so the bytes streamed here are already clean. We don't
// re-encode on the way out (that would be lossy for no benefit).

import { downloadZip } from "client-zip";
import { downloadBlob } from "@/lib/download";
import { getMarketplaceSpec, type MarketplacePlatform } from "@/lib/marketplace-specs";
import { isExtensionIneligiblePhotoType } from "@/lib/constants";

export interface ExportablePhoto {
  id: string;
  photo_url: string;
  photo_type: string | null;
  /**
   * US-2462: 'measurement' means two different photos and only the ROLELESS one
   * is the MeasureCard frame. Absent on a caller that has not selected it,
   * which reads as null and therefore as "the card" — the safe side, since the
   * cost of dropping a tape close-up is one missing photo and the cost of
   * keeping the card is a branded foreign object on a live listing.
   */
  photo_role?: string | null;
  sort_order: number;
}

// Cover-first (primary photo), then ascending sort_order, capped to the
// platform's max photo count.
//
// The MeasureCard and its generated render are dropped BEFORE the cap, not
// after: counting a photo that will never be sent against a 12-photo Poshmark
// limit costs the seller a real listing image (owner decision, 2026-09-07 —
// see EXTENSION_INELIGIBLE_PHOTO_TYPES).
export function orderedCappedPhotos(
  photos: ExportablePhoto[],
  primaryId: string | null,
  platform: MarketplacePlatform,
): ExportablePhoto[] {
  const cap = getMarketplaceSpec(platform)?.maxPhotos ?? photos.length;
  const eligible = photos.filter(
    (p) => !isExtensionIneligiblePhotoType(p.photo_type, p.photo_role ?? null),
  );
  const sorted = [...eligible].sort((a, b) => a.sort_order - b.sort_order);
  if (primaryId) {
    const idx = sorted.findIndex((p) => p.id === primaryId);
    if (idx > 0) {
      const cover = sorted.splice(idx, 1)[0];
      if (cover) sorted.unshift(cover);
    }
  }
  return sorted.slice(0, cap);
}

function extFromUrl(url: string): string {
  const path = url.split("?")[0] ?? url;
  const m = path.match(/\.(jpe?g|png|webp|gif|heic)$/i);
  return m?.[1] ? m[1].toLowerCase() : "jpg";
}

export interface PhotoExportResult {
  /** Photos placed in the zip. */
  count: number;
  /** Photos that failed to fetch and were skipped. */
  skipped: number;
}

/**
 * Fetches each photo, zips them in order with index-prefixed names, and
 * triggers a browser download. Returns counts so the caller can warn on any
 * skipped photo (don't silently drop — US guidance).
 */
export async function exportPhotosForPlatform(opts: {
  photos: ExportablePhoto[];
  primaryId: string | null;
  platform: MarketplacePlatform;
  baseName: string;
}): Promise<PhotoExportResult> {
  const list = orderedCappedPhotos(opts.photos, opts.primaryId, opts.platform);
  const files: { name: string; input: Blob }[] = [];
  let skipped = 0;

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p) continue;
    try {
      const resp = await fetch(p.photo_url);
      if (!resp.ok) {
        skipped += 1;
        continue;
      }
      const blob = await resp.blob();
      const n = String(i + 1).padStart(2, "0");
      const role = (p.photo_type ?? "photo").replace(/[^a-z0-9_]+/gi, "") || "photo";
      files.push({ name: `${n}_${role}.${extFromUrl(p.photo_url)}`, input: blob });
    } catch {
      skipped += 1;
    }
  }

  if (files.length === 0) {
    throw new Error("No photos could be downloaded.");
  }

  const safeBase = (opts.baseName || "item").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);
  const blob = await downloadZip(files).blob();
  downloadBlob(blob, `${safeBase}-${opts.platform}-photos.zip`);
  return { count: files.length, skipped };
}

import { supabase } from "@/lib/supabase";
import { compressImage } from "@/lib/image-utils";
import { normalizeToImageFile } from "@/lib/media-intake";
import {
  assessMacroPhoto,
  measureMacroPhoto,
  uploadMaxWidthFor,
  type MacroQualityAssessment,
} from "@/lib/macro-photo-quality";
import type { FlipdeskPhotoType } from "@/types/database";

// The one path a FlipDesk item photo takes: normalize → compress → store →
// thumbnail → insert the row.
//
// It lived inside PhotoUploader until US-2546, when the intake form needed to
// upload staged photos the moment the item row exists. Two copies of this would
// mean two EXIF-orientation stories, two thumbnail sizes and two storage path
// formats, and only one of them getting fixed.

function extOf(file: File): string {
  const m = file.name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1]!.toLowerCase() : "jpg";
}

function extForBlobType(mimeType: string, fallback: string): string {
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return fallback;
}

export interface UploadItemPhotoInput {
  file: File;
  itemId: string;
  /** Storage folder = the WORKSPACE owner, not the acting user. RLS is keyed on it. */
  ownerFolder: string;
  photoType: FlipdeskPhotoType;
  /**
   * Explicit, so a bulk batch can sequence a whole set deterministically
   * without waiting for the query cache to refresh between files.
   */
  sortOrder: number;
  /** The qualifier saying what this photo shows; null for a slot that takes none. */
  photoRole?: string | null;
}

export interface UploadItemPhotoResult {
  originalSize: number;
  storedSize: number;
  macro: MacroQualityAssessment;
}

export async function uploadItemPhoto({
  file: picked,
  itemId,
  ownerFolder,
  photoType,
  sortOrder,
  photoRole,
}: UploadItemPhotoInput): Promise<UploadItemPhotoResult> {
  // US-1300: normalize odd iPhone inputs first — a Live Photo exported as a
  // .mov/.mp4 video becomes a still JPEG frame and HEIC/HEIF becomes JPEG, so
  // the canvas compress/upload path below gets a decodable image.
  const file = await normalizeToImageFile(picked);

  const originalSize = file.size;
  let body: Blob = file;
  let bodyType = file.type;
  let ext = extOf(file);
  let width: number | null = null;
  let height: number | null = null;
  let thumbBlob: Blob | null = null;
  let thumbType = "image/webp";
  try {
    // US-2135: macro slots keep more pixels than a general condition photo.
    // Non-macro slots get the unchanged 2400 default — the increase must NOT be
    // global, because the upload-speed tradeoff that motivated the low cap is
    // real on mobile data.
    const main = await compressImage(
      file,
      uploadMaxWidthFor(photoType, photoRole),
      0.85,
    );
    // Always prefer the canvas-baked output: compressImage applies EXIF
    // orientation to the PIXELS (upright) and strips metadata, so the stored
    // image renders the right way up everywhere — including eBay, which ignores
    // EXIF orientation tags. Falling back to the original to dodge a marginally
    // larger file would re-introduce sideways photos, so correctness wins.
    if (main.blob.size > 0) {
      body = main.blob;
      bodyType = main.blob.type || "image/webp";
      ext = extForBlobType(bodyType, ext);
    }
    width = main.width;
    height = main.height;

    // 320w is the sweet spot for grid views; quality 0.7 because perceptual
    // quality at that size is already saturated.
    try {
      const thumb = await compressImage(file, 320, 0.7);
      if (thumb.blob.size > 0) {
        thumbBlob = thumb.blob;
        thumbType = thumb.blob.type || "image/webp";
      }
    } catch (thumbErr) {
      // US-1487: expected best-effort fallback — not logged in production.
      if (import.meta.env.DEV) {
        console.warn("[item-photo-upload] thumbnail gen failed:", thumbErr);
      }
    }
  } catch (compressErr) {
    if (import.meta.env.DEV) {
      console.warn(
        "[item-photo-upload] compress failed, uploading original:",
        compressErr,
      );
    }
  }

  // Millisecond timestamp alone collides when a bulk batch uploads several
  // files of the SAME assigned type in the same tick; a short random suffix
  // keeps every storage path (and thus the upsert:false insert) unique.
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const path = `${ownerFolder}/${itemId}/${photoType}_${ts}_${rand}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("item-photos")
    .upload(path, body, { upsert: false, contentType: bodyType || undefined });
  if (upErr) throw upErr;

  const { data: pub } = supabase.storage.from("item-photos").getPublicUrl(path);

  // Best-effort thumbnail. If it fails we still have the full image — the
  // frontend falls back via `thumbnail_url ?? photo_url`.
  let thumbnailUrl: string | null = null;
  let thumbnailPath: string | null = null;
  if (thumbBlob) {
    thumbnailPath = `${ownerFolder}/${itemId}/thumbs/${photoType}_${ts}_${rand}.${extForBlobType(thumbType, "webp")}`;
    const { error: thumbUpErr } = await supabase.storage
      .from("item-photos")
      .upload(thumbnailPath, thumbBlob, {
        upsert: false,
        contentType: thumbType,
      });
    if (thumbUpErr) {
      if (import.meta.env.DEV) {
        console.warn(
          "[item-photo-upload] thumbnail upload failed:",
          thumbUpErr.message,
        );
      }
      thumbnailPath = null;
    } else {
      thumbnailUrl = supabase.storage
        .from("item-photos")
        .getPublicUrl(thumbnailPath).data.publicUrl;
    }
  }

  const { error: insErr } = await supabase.from("item_photos").insert({
    inventory_item_id: itemId,
    photo_url: pub.publicUrl,
    storage_path: path,
    photo_type: photoType,
    // US-2462: the qualifier saying what this photo shows. NULL for a slot that
    // takes none — see src/lib/photo-roles.ts.
    photo_role: photoRole ?? null,
    // Canonical default order: Front → Back → Tag → Detail … so the listing's
    // photo order (and eBay cover) is sensible without any manual drag. A later
    // reorder densifies sort_order and wins.
    sort_order: sortOrder,
    thumbnail_url: thumbnailUrl,
    thumbnail_storage_path: thumbnailPath,
    width,
    height,
    bytes: body.size,
  } as never);
  if (insErr) throw insErr;

  // US-2136: assess the macro slots (tag, serial, marking, surface, …) on the
  // bytes we actually STORED, not the camera original — compressImage caps at
  // 2400px, so a distant serial shot can arrive fine and be stored soft. The
  // seller is nudged AFTER the upload rather than blocked before it: Claude
  // Vision reads a marginal photo better than any client-side check, and a
  // false "retake this" is what teaches sellers to ignore the nudge.
  const macro = assessMacroPhoto(
    await measureMacroPhoto(body, photoType, photoRole),
  );

  return { originalSize, storedSize: body.size, macro };
}

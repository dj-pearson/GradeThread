import { supabase } from "@/lib/supabase";
import { compressImage } from "@/lib/image-utils";
import { normalizeToImageFile } from "@/lib/media-intake";
import {
  assessMacroPhoto,
  measureMacroPhoto,
  isMacroPhotoType,
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

// Storage answers an upsert:false upload onto an existing path with 409
// "The resource already exists". Both halves are required: a bare 409, or a
// message that merely says "duplicate", is some other refusal and must not be
// taken as proof that an earlier attempt stored this object.
function isAlreadyStored(err: unknown): boolean {
  const e = err as { statusCode?: unknown; status?: unknown; message?: unknown };
  const is409 = String(e.statusCode) === "409" || e.status === 409;
  return is409 && typeof e.message === "string" && /already exists/i.test(e.message);
}

/**
 * The photo could not be turned into something uploadable on THIS device:
 * HEIC or video conversion failed, or the canvas re-encode did. Nothing was
 * sent, so the server has not judged it, and retrying the same bytes on the
 * same device will fail the same way. The message is written for the seller.
 */
export class PhotoPrepError extends Error {
  readonly cause: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PhotoPrepError";
    this.cause = options?.cause;
  }
}

// A unique violation on the row id or on (item, storage_path): either way the
// row for this photoId is already there.
function isPhotoRowDuplicate(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === "23505" &&
    typeof e.message === "string" &&
    /item_photos_pkey|item_photos_item_storage_path_uniq/.test(e.message)
  );
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
  /**
   * A caller-chosen id that makes a retry idempotent. The offline intake queue
   * reuses one per staged photo across flushes: the storage path and the
   * item_photos row id both derive from it, so an upload whose response was
   * lost finds its own object and row on the next try instead of adding a
   * second copy. Omit it for a one-shot upload.
   */
  photoId?: string;
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
  photoId,
}: UploadItemPhotoInput): Promise<UploadItemPhotoResult> {
  // US-1300: normalize odd iPhone inputs first — a Live Photo exported as a
  // .mov/.mp4 video becomes a still JPEG frame and HEIC/HEIF becomes JPEG, so
  // the canvas compress/upload path below gets a decodable image.
  let file: File;
  try {
    file = await normalizeToImageFile(picked);
  } catch (normErr) {
    // Keep the conversion's own message (it says what to do), but mark it as
    // a local failure so a retrying caller does not count it against the server.
    throw new PhotoPrepError(
      normErr instanceof Error && normErr.message
        ? normErr.message
        : `Couldn't convert ${picked.name || "this photo"}. Take it again or pick a different photo.`,
      { cause: normErr },
    );
  }

  const originalSize = file.size;
  // item-photos is the one PUBLIC bucket and the browser writes to it directly,
  // so the server's stripImageMetadata never runs on this path. The canvas pass
  // in compressImage is the only thing that drops EXIF/GPS. There is therefore
  // no fallback to the picked file: if it cannot be re-encoded, the upload
  // fails instead of publishing the camera original.
  let body: Blob;
  let bodyType: string;
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
    // A macro slot caps the LONG edge: a width-only cap let a tall tag shot
    // through at full size, which iOS canvas cannot draw above ~16.7 MP.
    const main = await compressImage(
      file,
      isMacroPhotoType(photoType, photoRole)
        ? { maxEdge: uploadMaxWidthFor(photoType, photoRole) }
        : uploadMaxWidthFor(photoType, photoRole),
      0.85,
    );
    // Always prefer the canvas-baked output: compressImage applies EXIF
    // orientation to the PIXELS (upright) and strips metadata, so the stored
    // image renders the right way up everywhere — including eBay, which ignores
    // EXIF orientation tags. Falling back to the original to dodge a marginally
    // larger file would re-introduce sideways photos, so correctness wins.
    if (!(main.blob.size > 0)) {
      throw new Error("compressImage returned an empty image");
    }
    body = main.blob;
    bodyType = main.blob.type || "image/webp";
    ext = extForBlobType(bodyType, ext);
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
      console.warn("[item-photo-upload] compress failed:", compressErr);
    }
    throw new PhotoPrepError(
      `Couldn't prepare ${file.name || "this photo"} for upload. Take it again or pick a different photo.`,
      { cause: compressErr },
    );
  }

  // Millisecond timestamp alone collides when a bulk batch uploads several
  // files of the SAME assigned type in the same tick; a short random suffix
  // keeps every storage path (and thus the upsert:false insert) unique.
  // With a photoId the name is fixed instead, so a retry lands on the same
  // path and an object left by an earlier attempt counts as uploaded.
  const stem = photoId
    ? `${photoType}_${photoId}`
    : `${photoType}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const path = `${ownerFolder}/${itemId}/${stem}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("item-photos")
    .upload(path, body, { upsert: false, contentType: bodyType || undefined });
  if (upErr && !(photoId && isAlreadyStored(upErr))) throw upErr;
  // A 409 taken as success means the object is an EARLIER attempt's upload,
  // which a row from that attempt may already point at. Only objects this call
  // created are ours to clean up.
  const createdPaths: string[] = upErr ? [] : [path];

  const { data: pub } = supabase.storage.from("item-photos").getPublicUrl(path);

  // Best-effort thumbnail. If it fails we still have the full image — the
  // frontend falls back via `thumbnail_url ?? photo_url`.
  let thumbnailUrl: string | null = null;
  let thumbnailPath: string | null = null;
  if (thumbBlob) {
    thumbnailPath = `${ownerFolder}/${itemId}/thumbs/${stem}.${extForBlobType(thumbType, "webp")}`;
    const { error: thumbUpErr } = await supabase.storage
      .from("item-photos")
      .upload(thumbnailPath, thumbBlob, {
        upsert: false,
        contentType: thumbType,
      });
    if (thumbUpErr && !(photoId && isAlreadyStored(thumbUpErr))) {
      if (import.meta.env.DEV) {
        console.warn(
          "[item-photo-upload] thumbnail upload failed:",
          thumbUpErr.message,
        );
      }
      thumbnailPath = null;
    } else {
      if (!thumbUpErr) createdPaths.push(thumbnailPath);
      thumbnailUrl = supabase.storage
        .from("item-photos")
        .getPublicUrl(thumbnailPath).data.publicUrl;
    }
  }

  const { error: insErr } = await supabase.from("item_photos").insert({
    ...(photoId ? { id: photoId } : {}),
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
  // The row an earlier attempt already wrote. It points at these very objects,
  // so they must not be cleaned up as orphans.
  const alreadyRecorded = Boolean(photoId && insErr && isPhotoRowDuplicate(insErr));
  if (insErr && !alreadyRecorded) {
    // No row points at the objects this call uploaded, so nothing would ever
    // list or delete them. Remove them before reporting; a failed cleanup must
    // not hide the insert error the caller needs to see. An object found
    // already stored (409) is left alone: it may be the one an earlier,
    // successful attempt's row points at.
    if (createdPaths.length > 0) {
      try {
        await supabase.storage.from("item-photos").remove(createdPaths);
      } catch (cleanupErr) {
        if (import.meta.env.DEV) {
          console.warn("[item-photo-upload] orphan cleanup failed:", cleanupErr);
        }
      }
    }
    throw insErr;
  }

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

export type BatchOutcome<T, R> =
  | { task: T; ok: true; result: R }
  | { task: T; ok: false; error: unknown };

/**
 * Run uploads a few at a time, retrying each failure once. A photo the device
 * cannot prepare (PhotoPrepError) is not retried: the same bytes fail the
 * same way. Outcomes come back in task order.
 */
export async function uploadInPool<T, R>(
  tasks: readonly T[],
  run: (task: T) => Promise<R>,
  { concurrency = 3, retries = 1 }: { concurrency?: number; retries?: number } = {},
): Promise<BatchOutcome<T, R>[]> {
  const out: BatchOutcome<T, R>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i]!;
      let attempt = 0;
      for (;;) {
        try {
          out[i] = { task, ok: true, result: await run(task) };
          break;
        } catch (error) {
          if (attempt >= retries || error instanceof PhotoPrepError) {
            out[i] = { task, ok: false, error };
            break;
          }
          attempt++;
        }
      }
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  );
  return out;
}

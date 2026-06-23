import { supabaseAdmin } from "./supabase.ts";

// US-979: sensitive close-ups (size/care labels, second tags, grading
// certificates) are uploaded to the PRIVATE `submission-images` bucket;
// everything else (listing imagery) to the public `item-photos` bucket. The web
// historically uploaded EVERY item photo to `item-photos`, while iOS routes the
// sensitive types to `submission-images`. Mirror of iOS
// `PhotoStorageBucket.sensitiveServerTypes`.
export const SENSITIVE_ITEM_PHOTO_TYPES = new Set<string>([
  "tag",
  "tag_2",
  "certificate",
]);

export const ITEM_PHOTOS_BUCKET = "item-photos";
export const SUBMISSION_IMAGES_BUCKET = "submission-images";

/** The bucket an `item_photos` row is expected to live in, by its photo_type. */
export function bucketForItemPhoto(photoType?: string | null): string {
  return SENSITIVE_ITEM_PHOTO_TYPES.has(photoType ?? "")
    ? SUBMISSION_IMAGES_BUCKET
    : ITEM_PHOTOS_BUCKET;
}

/**
 * Download an `item_photos` object by its `storage_path`, looking in BOTH
 * buckets. Because the web and iOS disagree on where sensitive photos live
 * (US-979), reading from a single hardcoded bucket fails with "object not
 * found" for a photo uploaded by the other client. This tries the bucket the
 * `photoType` implies, then falls back to the other, so a photo captured on
 * either platform is found regardless of which client wrote it.
 *
 * ANY edge code that downloads an item photo by storage_path MUST use this —
 * never `supabaseAdmin.storage.from("item-photos").download(...)` directly (a
 * source-guard test enforces this). `getPublicUrl` is a separate concern and is
 * gated elsewhere (see `ebayPublicPhotoUrl`).
 */
export async function downloadItemPhoto(
  storagePath: string,
  photoType?: string | null,
): Promise<{ blob: Blob; bucket: string } | { error: string }> {
  const primary = bucketForItemPhoto(photoType);
  const fallback = primary === ITEM_PHOTOS_BUCKET
    ? SUBMISSION_IMAGES_BUCKET
    : ITEM_PHOTOS_BUCKET;
  let lastErr = "no body";
  for (const bucket of [primary, fallback]) {
    const { data: blob, error } = await supabaseAdmin.storage
      .from(bucket)
      .download(storagePath);
    if (!error && blob) return { blob, bucket };
    lastErr = error?.message ?? lastErr;
  }
  return { error: lastErr };
}

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

// US-1549: seller-reference photos (e.g. the price tag showing what they
// paid). They stay on the item and render in-app, but are NEVER sent to eBay,
// NEVER fed to AI passes, and NEVER shown on public surfaces. Enforced in code
// via filterListablePhotos at every such selection site — the blob itself
// stays wherever it was uploaded.
export function isInternalItemPhoto(photoType?: string | null): boolean {
  return (photoType ?? "") === "internal";
}

// US-1571: photo types that never leave GradeThread. 'measurement' is the
// MeasureCard calibration frame (garment flat with the fiducial card beside
// it) — the measurement pipeline reads it EXPLICITLY by type; every listing /
// generation-AI / public selection drops it, exactly like 'internal' (the
// card is a branded foreign object in a listing photo). Mirror of the web's
// NON_LISTABLE_PHOTO_TYPES in src/lib/constants.ts.
export const NON_LISTABLE_PHOTO_TYPES = new Set<string>([
  "internal",
  "measurement",
]);

// US-2462. 'measurement' now covers two different photos and only one of them
// is unlistable, so the rule had to learn about the role qualifier.
//
//   measurement + NULL role  = the MeasureCard calibration frame. The card is a
//                              branded foreign object; it never lists. This is
//                              also what every pre-00587 row looks like, so the
//                              NULL case preserves history exactly.
//   measurement + a role     = a tape close-up ("Measure: Chest"). These used to
//                              be stored as `measurement_chest` and friends,
//                              which were LISTABLE and which sellers publish on
//                              purpose.
//
// Migration 00587 rewrites measurement_chest → (measurement, 'chest'), so
// WITHOUT this branch that backfill would have quietly pulled tape photos out
// of every live listing.
export function isNonListableItemPhoto(
  photoType?: string | null,
  photoRole?: string | null,
): boolean {
  if ((photoType ?? "") === "measurement") return !photoRole;
  return NON_LISTABLE_PHOTO_TYPES.has(photoType ?? "");
}

/**
 * Drop 'internal' + the MeasureCard frame from a selection headed to eBay, an
 * AI pass, or a public surface. Pure; rows without a photo_type pass through
 * unchanged.
 */
export function filterListablePhotos<
  T extends { photo_type?: string | null; photo_role?: string | null },
>(rows: T[]): T[] {
  return rows.filter((r) => !isNonListableItemPhoto(r.photo_type, r.photo_role));
}

// US-2625: eBay's picture policy bans added text, graphics and borders on
// listing images, and 'measurement_overlay' is nothing BUT added graphics —
// measurement lines and inch labels burned into the pixels. Sellers hit this as
// a publish rejection, which is the worst place to find out.
//
// Scoped to eBay on purpose rather than added to NON_LISTABLE_PHOTO_TYPES: a
// measurements graphic is welcome on Poshmark, Depop and Mercari, where it is
// close to expected. The render stays listable everywhere else.
export const EBAY_INELIGIBLE_PHOTO_TYPES = new Set<string>([
  "measurement_overlay",
]);

export function isEbayIneligiblePhoto(photoType?: string | null): boolean {
  return EBAY_INELIGIBLE_PHOTO_TYPES.has(photoType ?? "");
}

/**
 * The photo set for an eBay listing: listable (US-1549) AND allowed by eBay's
 * picture policy. Every eBay image selection must go through this rather than
 * filterListablePhotos, or the annotated render reaches publish and is rejected.
 */
export function filterEbayPhotos<
  T extends { photo_type?: string | null; photo_role?: string | null },
>(rows: T[]): T[] {
  return filterListablePhotos(rows).filter(
    (r) => !isEbayIneligiblePhoto(r.photo_type),
  );
}

export const ITEM_PHOTOS_BUCKET = "item-photos";
export const SUBMISSION_IMAGES_BUCKET = "submission-images";

/** The bucket an `item_photos` row is expected to live in, by its photo_type. */
export function bucketForItemPhoto(photoType?: string | null): string {
  return SENSITIVE_ITEM_PHOTO_TYPES.has(photoType ?? "")
    ? SUBMISSION_IMAGES_BUCKET
    : ITEM_PHOTOS_BUCKET;
}

/**
 * The bucket a stored item photo must be READ from — trusting where the bytes
 * ACTUALLY are, not just what the type implies. Mirror of iOS
 * `PhotoStorageBucket.readBucket(forServerType:photoURL:)`.
 *
 * `item_photos.photo_url` is NOT NULL (migration 00008) and iOS writes it as the
 * EMPTY STRING for exactly the private-bucket uploads (`PhotoUploadService
 * .insertPhotoRow`), so a POPULATED photo_url means the object sits in the
 * public bucket even for a nominally-sensitive type: the web uploads every type
 * to `item-photos`, and so did pre-US-979 iOS builds. Keying on the stored URL
 * costs no round trip and is right for both clients.
 *
 * US-2407: the photo TYPE no longer takes part. It used to decide the
 * empty-photo_url case, which meant a seller changing the type dropdown changed
 * where the edge looked for bytes that had not moved: retag a phone-captured
 * Garment Tag to "Front" and every reader started resolving it against the
 * public bucket, where it has never been. Empty photo_url ⇒ private is sound in
 * the other direction too — every writer that puts an object in `item-photos`
 * stores its public URL on the row in the same insert — and `itemPhotoAiUrl`'s
 * public fallback still covers a legacy row that guesses wrong.
 * (`bucketForItemPhoto` remains the WRITE-time router, keyed on the type.)
 */
export function readBucketForItemPhoto(photoUrl?: string | null): string {
  return (photoUrl ?? "").trim() === ""
    ? SUBMISSION_IMAGES_BUCKET
    : ITEM_PHOTOS_BUCKET;
}

/**
 * Signed-URL lifetime for a private-bucket photo handed to an AI pass. Long
 * enough for the edge (or the model, on a `type:"url"` image block) to fetch,
 * short enough to self-expire. The 900s ceiling is the storage rule in
 * CLAUDE.md; 600s matches the iOS `PhotoStorageBucket.signedURLTTLSeconds`.
 */
export const AI_PHOTO_SIGNED_URL_TTL_SECONDS = 600;

/** The subset of an `item_photos` row needed to resolve a fetchable URL. */
export interface ItemPhotoUrlRow {
  storage_path?: string | null;
  photo_type?: string | null;
  // US-2462. Every query feeding filterListablePhotos MUST select this: an
  // absent field reads as NULL, and a NULL role on a 'measurement' row means
  // "the MeasureCard frame", so forgetting it silently drops the seller's tape
  // photos from a listing instead of raising anything.
  photo_role?: string | null;
  photo_url?: string | null;
}

/**
 * The two storage operations the URL resolver needs, as plain functions.
 * Injectable so tests can assert the bucket + signing decisions without a live
 * storage API (same pattern as `buildPhotoContent`'s `fetcher` in ai-extract.ts).
 *
 * Deliberately NOT shaped as a mini Storage client, and `signUrl` takes no TTL:
 * the US-276 guard in `tests/private-bucket-access_test.ts` fails closed on any
 * signing call whose TTL argument it can't resolve to a literal or a same-file
 * const, and it fails closed on interface declarations too (it reads source, not
 * types). One module-level TTL, referenced directly at the one real call site,
 * keeps that guard able to check us — which is the point of a fail-closed guard.
 */
export interface ItemPhotoStorageApi {
  publicUrl(bucket: string, path: string): string;
  /**
   * A signed URL valid for ``AI_PHOTO_SIGNED_URL_TTL_SECONDS``, or null when the
   * object isn't in `bucket`.
   */
  signUrl(bucket: string, path: string): Promise<string | null>;
}

/** The production resolver, backed by the service-role storage client. */
export const defaultItemPhotoStorage: ItemPhotoStorageApi = {
  publicUrl(bucket, path) {
    return supabaseAdmin.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  },
  async signUrl(bucket, path) {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(path, AI_PHOTO_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      console.warn(
        `[item-photo-storage] sign failed in ${bucket}: ` +
          `${error?.message ?? "no url"}`,
      );
      return null;
    }
    return data.signedUrl;
  },
};

/**
 * A URL an AI pass can actually FETCH for one `item_photos` row.
 *
 * The bug this exists to kill: every AI photo loader built
 * `from("item-photos").getPublicUrl(storage_path)` for EVERY row. For an
 * iOS-captured item the tag / tag_2 / certificate objects live in the PRIVATE
 * `submission-images` bucket, so that URL 404s — and `buildPhotoContent` skips a
 * non-2xx photo with nothing but a `console.warn`. The result was a silent
 * accuracy loss: Size AI, listing generation and the tag-OCR pass all ran
 * WITHOUT the single most informative photo (the care/size label) on every
 * iOS-sourced item, while the same item captured on web kept it.
 *
 * ANY edge code that builds an item-photo URL for an AI pass MUST use this —
 * never `.from("item-photos").getPublicUrl(...)` directly (a source-guard test
 * in `tests/item-photo-storage_test.ts` enforces it). Returns null when the row
 * has no storage_path, or when a private object can't be signed.
 *
 * Callers must select `photo_url` alongside `storage_path`/`photo_type`: without
 * it every row looks private and the public photos take a needless sign call.
 */
export async function itemPhotoAiUrl(
  row: ItemPhotoUrlRow,
  storage: ItemPhotoStorageApi = defaultItemPhotoStorage,
): Promise<string | null> {
  const path = (row.storage_path ?? "").trim();
  if (!path) return null;

  if (readBucketForItemPhoto(row.photo_url) === ITEM_PHOTOS_BUCKET) {
    return storage.publicUrl(ITEM_PHOTOS_BUCKET, path);
  }

  const signed = await storage.signUrl(SUBMISSION_IMAGES_BUCKET, path);
  if (signed) return signed;

  // The row looked private but the object isn't in the private bucket — a
  // sensitive type whose blob was written to `item-photos` by a client that
  // predates US-979, or a type reclassified to tag/certificate after capture.
  // Fall back to the public URL: same behaviour as before this helper existed,
  // so a fallback miss degrades to today's skip rather than a hard failure.
  console.warn(
    `[item-photo-storage] no private object for a ${row.photo_type ?? "untyped"} ` +
      `photo — falling back to the public URL`,
  );
  return storage.publicUrl(ITEM_PHOTOS_BUCKET, path);
}

/**
 * The PUBLIC URL a marketplace should fetch for an `item_photos` row, or null
 * when the photo can't (and must not) be exposed publicly.
 *
 * This is the counterpart to `itemPhotoAiUrl`: a marketplace can't fetch a
 * short-TTL signed URL, so a private-bucket photo simply isn't pushed rather
 * than being turned into an `item-photos` public URL that 404s. A row that
 * already carries a public `photo_url` keeps working — web has always uploaded
 * every type to the public bucket, and live listings depend on those URLs.
 *
 * Callers MUST still run `filterListablePhotos` first: 'internal' (price tags,
 * receipts) and 'measurement' (the MeasureCard frame) are excluded by SELECTION,
 * not by bucket (US-1549 / US-1571).
 */
export function publicItemPhotoUrl(p: ItemPhotoUrlRow): string | null {
  const stored = (p.photo_url ?? "").trim();
  if (stored !== "") return stored;
  // US-2407: an empty photo_url means the bytes are in the PRIVATE bucket, full
  // stop — the type is not consulted, because a seller can change the type and
  // cannot change where the bytes are. This used to refuse only the SENSITIVE
  // types, so retagging a phone-captured Garment Tag to "Front" turned it into a
  // public item-photos URL for an object that has never been in that bucket:
  // pushed to eBay it is a 404 in the buyer's gallery, and the retag that
  // produced it was itself a workaround for the photo being uneditable.
  //
  // Nothing legitimate is lost: every writer that puts an object in the public
  // bucket stores its URL on the row in the same insert, so "empty photo_url +
  // public bytes" is not a shape this codebase produces.
  return null;
}

/**
 * ``itemPhotoAiUrl`` over a list, in parallel, dropping rows whose URL couldn't
 * be resolved. Order is preserved — several AI passes rely on `sort_order`
 * position (the cover photo, the role budget in `selectListingPhotos`).
 */
export async function itemPhotoAiUrls<T extends ItemPhotoUrlRow>(
  rows: T[],
  storage: ItemPhotoStorageApi = defaultItemPhotoStorage,
): Promise<Array<{ row: T; url: string }>> {
  const resolved = await Promise.all(
    rows.map(async (row) => ({ row, url: await itemPhotoAiUrl(row, storage) })),
  );
  return resolved.filter((r): r is { row: T; url: string } => r.url !== null);
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
 * source-guard test enforces this). URL building is the parallel concern —
 * see `itemPhotoAiUrl` above.
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

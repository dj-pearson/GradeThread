import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import {
  downloadItemPhoto,
  readBucketForItemPhoto,
  ITEM_PHOTOS_BUCKET,
  SENSITIVE_ITEM_PHOTO_TYPES,
  SUBMISSION_IMAGES_BUCKET,
} from "../lib/item-photo-storage.ts";
import {
  headR2Object,
  isR2Configured,
  putR2Object,
  r2PublicUrl,
} from "../lib/r2-client.ts";
import { readImageDimensions, validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import { safeFetch } from "../lib/ssrf.ts";
import { isEbayPhotoUrl } from "../lib/ebay-photo-mirror.ts";

// Image processing pipeline (client-side, see PhotoUploader) and
// cold-storage archival to Cloudflare R2.
//
// Required env for /archive: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL.

type ImagesEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

export const flipdeskImageRoutes = new Hono<ImagesEnv>();

// US-1114: capability probe so the UI only offers server-backed image tools
// that are actually configured (avoids a control that 503s on click). Exposes
// no secret — only whether an optional integration is wired. remove_bg reflects
// REMOVE_BG_API_KEY presence (the /remove-bg route 503s without it).
flipdeskImageRoutes.get("/capabilities", (c) => {
  return c.json({ remove_bg: !!Deno.env.get("REMOVE_BG_API_KEY") });
});

// /process and /remove-bg are intentionally stubbed — we generate
// thumbnails + strip EXIF client-side in PhotoUploader instead, which is
// faster, free, and works offline. Re-enable if you need server-side
// processing (watermarks, retroactive resizes, background removal).
flipdeskImageRoutes.post("/process", (c) => {
  return c.json({ error: "Not implemented (handled client-side)" }, 501);
});

// Generates a background-removed variant of a photo via the remove.bg API.
// The new image is saved as a separate item_photo row tagged `flatlay` —
// the original stays untouched. Body: { item_photo_id: string }.
//
// Optional env: REMOVE_BG_API_KEY. Returns 503 when not configured.
flipdeskImageRoutes.post("/remove-bg", async (c) => {
  const apiKey = Deno.env.get("REMOVE_BG_API_KEY");
  if (!apiKey) {
    return c.json(
      {
        error:
          "Background removal is not configured on this server (REMOVE_BG_API_KEY missing).",
      },
      503,
    );
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_photo_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const photoId =
    typeof body.item_photo_id === "string" ? body.item_photo_id : null;
  if (!photoId) {
    return c.json({ error: "item_photo_id is required" }, 400);
  }

  // Load + ownership-check
  const { data: row, error: loadErr } = await supabaseAdmin
    .from("item_photos")
    .select(
      "id, inventory_item_id, photo_type, storage_path, photo_url, sort_order, inventory_items!inner(user_id)",
    )
    .eq("id", photoId)
    .maybeSingle();
  if (loadErr || !row) {
    return c.json({ error: "Photo not found" }, 404);
  }
  const photo = row as unknown as {
    id: string;
    inventory_item_id: string;
    photo_type: string | null;
    storage_path: string | null;
    photo_url: string;
    sort_order: number;
    inventory_items: { user_id: string };
  };
  if (photo.inventory_items.user_id !== userId) {
    return c.json({ error: "Photo not found" }, 404);
  }
  // US-1638: never run a SENSITIVE close-up (size/care label, second tag,
  // grading certificate — US-979) through remove-bg. Its source lives in the
  // PRIVATE bucket, but the background-removed derivative is written to the
  // PUBLIC item-photos bucket with a public URL — which would expose PII
  // (serials, receipts, certificate numbers) that must never be public.
  //
  // US-2407: the same refusal by BUCKET, not only by type. The type is the
  // seller's dropdown; retagging a phone-captured tag to "Front" cleared the
  // check above while the bytes stayed private, and this handler would then have
  // published a derivative of them. Where the bytes are is what matters.
  if (
    SENSITIVE_ITEM_PHOTO_TYPES.has(photo.photo_type ?? "") ||
    readBucketForItemPhoto(photo.photo_url) === SUBMISSION_IMAGES_BUCKET
  ) {
    return c.json(
      {
        error:
          "Background removal isn't available for label, tag, or certificate photos.",
      },
      422,
    );
  }
  if (!photo.storage_path) {
    return c.json(
      { error: "Source photo has no storage path; can't fetch for processing." },
      400,
    );
  }

  // Download original from Supabase Storage so we hit remove.bg with a
  // direct blob upload (faster + works even if the public URL isn't
  // reachable from remove.bg's IP block). Resolve across both buckets — a
  // sensitive photo (US-979) lives in the private bucket on iOS.
  const dl = await downloadItemPhoto(photo.storage_path, photo.photo_type);
  const srcBlob = "error" in dl ? null : dl.blob;
  const dlErr = "error" in dl ? { message: dl.error } : null;
  if (dlErr || !srcBlob) {
    return c.json(
      {
        error: "Failed to fetch source photo",
        detail: dlErr?.message ?? "no body",
      },
      502,
    );
  }

  // Call remove.bg. Their `image_file` param accepts multipart-form bodies.
  // size=auto → returns the largest variant your plan allows; we pass
  // through as PNG so transparency is preserved.
  const form = new FormData();
  form.append("size", "auto");
  form.append("format", "png");
  form.append("image_file", srcBlob, "source");
  const bgRes = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": apiKey },
    body: form,
  });
  if (!bgRes.ok) {
    const text = await bgRes.text().catch(() => "");
    return c.json(
      {
        error: "remove.bg rejected the request.",
        detail: text.slice(0, 500),
      },
      bgRes.status === 402 ? 402 : 502,
    );
  }
  const outputArrayBuf = await bgRes.arrayBuffer();

  // Save the new variant under a `bg-removed/` subfolder so it's easy to
  // distinguish from organic flatlay uploads when browsing storage. Tag
  // the row as `flatlay` so it sorts cleanly in the photo manager.
  const ts = Date.now();
  const newPath = `${userId}/${photo.inventory_item_id}/bg-removed/${ts}.png`;
  const { error: upErr } = await supabaseAdmin.storage
    .from("item-photos")
    .upload(newPath, new Uint8Array(outputArrayBuf), {
      upsert: false,
      contentType: "image/png",
    });
  if (upErr) {
    return failSafe(c, 500, "Failed to save processed photo", upErr, "flipdesk-images.bg-remove.upload");
  }
  // item-photo-url-ok: `newPath` is the background-removed PNG this handler just
  // uploaded to the public bucket, not an item_photos row — there is no private
  // variant to resolve. (bg-remove already refuses the sensitive types upstream.)
  const { data: pub } = supabaseAdmin.storage
    .from("item-photos")
    .getPublicUrl(newPath);

  // Insert as a new photo row (don't overwrite the original). sort_order
  // = (max existing) + 1 so it lands at the end of the strip.
  const { data: maxSort } = await supabaseAdmin
    .from("item_photos")
    .select("sort_order")
    .eq("inventory_item_id", photo.inventory_item_id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort =
    typeof (maxSort as { sort_order?: number } | null)?.sort_order === "number"
      ? ((maxSort as { sort_order: number }).sort_order ?? 0) + 1
      : photo.sort_order + 1;

  // US-1896: record the processed image's dimensions so the picture-standards
  // preflight can evaluate this flatlay (a GOOD_HERO type a seller may promote
  // to the search thumbnail) for the 500px floor / 1600px zoom threshold.
  const bgDims = readImageDimensions(new Uint8Array(outputArrayBuf));
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("item_photos")
    .insert({
      inventory_item_id: photo.inventory_item_id,
      photo_url: pub.publicUrl,
      storage_path: newPath,
      photo_type: "flatlay",
      sort_order: nextSort,
      bytes: outputArrayBuf.byteLength,
      width: bgDims?.width ?? null,
      height: bgDims?.height ?? null,
    })
    .select("id")
    .maybeSingle();
  if (insErr) {
    return failSafe(c, 500, "Failed to record new photo", insErr, "flipdesk-images.bg-remove.insert");
  }

  return c.json({
    ok: true,
    new_photo_id: (inserted as { id?: string } | null)?.id ?? null,
    photo_url: pub.publicUrl,
    storage_path: newPath,
    bytes: outputArrayBuf.byteLength,
  });
});

// ── Archive ────────────────────────────────────────────────────────
// How many photos to sweep per request. Caps run-time + R2 PUT cost; the
// caller can re-invoke if more remain (response includes `remaining`).
const ARCHIVE_BATCH = 50;
// Age threshold: only archive photos whose item entered a terminal state
// at least this long ago. Tight enough to free space, loose enough to
// avoid archiving items still in the active flow.
const ARCHIVE_MIN_AGE_DAYS = 30;
const ARCHIVAL_STATUSES = ["sold", "shipped", "completed", "returned", "archived"];

interface PhotoToArchive {
  id: string;
  inventory_item_id: string;
  photo_type: string | null;
  photo_url: string;
  storage_path: string | null;
  bytes: number | null;
}

export interface PhotoArchiveResult {
  archived: number;
  freed_bytes: number;
  errors: Array<{ photo_id: string; message: string }>;
  remaining: number | "unknown";
}

type EligiblePhotoRow = PhotoToArchive & {
  inventory_items: { user_id: string; status: string; updated_at: string };
};

/**
 * THE ONE PLACE the archival eligibility predicate is written (US-2617).
 *
 * Two callers need it and they must never drift: the seller's own /archive
 * route, and the fleet cron that walks every owner. Writing it twice is how the
 * cron ends up archiving a photo the route would have refused — and the refusal
 * that matters here is the PII one below, not a performance filter.
 *
 * `ownerId === null` is the FLEET read and is reachable only from the job-secret
 * cron, which then re-enters {@link archiveOwnerPhotos} per owner — so every
 * write is still tenant-scoped. It is not exported; the cron goes through
 * {@link listOwnersWithArchivablePhotos}, which cannot be mistaken for a
 * seller-facing read at a call site.
 */
async function loadArchivablePhotos(ownerId: string | null, limit: number) {
  const cutoffIso = new Date(
    Date.now() - ARCHIVE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  let q = supabaseAdmin
    .from("item_photos")
    .select(
      "id, inventory_item_id, photo_type, photo_url, storage_path, bytes, inventory_items!inner(user_id, status, updated_at)",
    )
    .eq("archived_to_r2", false);
  if (ownerId !== null) q = q.eq("inventory_items.user_id", ownerId);
  const { data, error } = await q
    .in("inventory_items.status", ARCHIVAL_STATUSES)
    .lt("inventory_items.updated_at", cutoffIso)
    .not("storage_path", "is", null)
    .not("photo_type", "in", `(${[...SENSITIVE_ITEM_PHOTO_TYPES].join(",")})`)
    .limit(limit);

  return { rows: (data ?? []) as unknown as EligiblePhotoRow[], error };
}

/**
 * Owners with at least one archivable photo, oldest-eligible first by virtue of
 * the shared predicate. Used only by the photo-archive cron.
 */
export async function listOwnersWithArchivablePhotos(
  scanLimit: number,
): Promise<{ owners: string[]; error: unknown }> {
  const { rows, error } = await loadArchivablePhotos(null, scanLimit);
  if (error) return { owners: [], error };
  const seen = new Set<string>();
  for (const r of rows) {
    const owner = r.inventory_items?.user_id;
    if (owner) seen.add(owner);
  }
  return { owners: [...seen], error: null };
}

/**
 * Archive one owner's eligible photos to R2. Tenant-scoped by construction:
 * every read goes through {@link loadArchivablePhotos} with the owner id, and
 * every write is keyed on a photo row that read returned.
 */
export async function archiveOwnerPhotos(
  ownerId: string,
): Promise<{ ok: true; result: PhotoArchiveResult } | { ok: false; error: unknown }> {
  const { rows: eligible, error } = await loadArchivablePhotos(ownerId, ARCHIVE_BATCH);
  if (error) return { ok: false, error };
  if (eligible.length === 0) {
    return { ok: true, result: { archived: 0, freed_bytes: 0, errors: [], remaining: 0 } };
  }

  const errors: Array<{ photo_id: string; message: string }> = [];
  let archived = 0;
  let freedBytes = 0;

  for (const p of eligible) {
    try {
      // Defence in depth: the query above already excludes these, but this loop
      // is what actually publishes to a public URL. A future edit to the filter
      // must not be able to leak PII silently, so re-check at the point of harm
      // — a NULL photo_type is also treated as unsafe rather than assumed fine.
      if (SENSITIVE_ITEM_PHOTO_TYPES.has(p.photo_type ?? "")) continue;
      const storagePath = p.storage_path!;
      // 1. Download original from Supabase Storage (resolves across both
      //    buckets — a sensitive photo lives in the private bucket, US-979).
      const dl = await downloadItemPhoto(storagePath, p.photo_type);
      if ("error" in dl) {
        throw new Error(`Supabase download failed: ${dl.error}`);
      }
      const blob = dl.blob;
      const arrayBuf = await blob.arrayBuffer();
      const contentType = blob.type || "application/octet-stream";

      // 2. PUT to R2 under the same path so we can reconstruct keys later.
      const r2Key = `item-photos/${storagePath}`;
      await putR2Object(r2Key, arrayBuf, contentType);

      // 3. HEAD-verify the upload landed before we touch Supabase.
      const head = await headR2Object(r2Key);
      if (!head || head.size !== arrayBuf.byteLength) {
        throw new Error(
          `R2 verify failed (got ${head?.size ?? "missing"}, expected ${arrayBuf.byteLength})`,
        );
      }

      // 4. Update DB to point at R2 + mark archived. We do this BEFORE the
      //    Supabase delete so a half-failed run still leaves the photo
      //    viewable (just with old + new URLs both alive briefly).
      const newUrl = r2PublicUrl(r2Key);
      const { error: updErr } = await supabaseAdmin
        .from("item_photos")
        .update({
          photo_url: newUrl,
          archived_to_r2: true,
          bytes: arrayBuf.byteLength,
        })
        .eq("id", p.id);
      if (updErr) {
        throw new Error(`DB update failed: ${updErr.message}`);
      }

      // 5. Delete the Supabase original to actually free the space.
      const { error: rmErr } = await supabaseAdmin.storage
        .from("item-photos")
        .remove([storagePath]);
      if (rmErr) {
        // Non-fatal — the DB already points at R2 and the photo is fine.
        // Logged so a follow-up sweep can mop these up.
        console.warn(
          "[archive] Supabase delete failed for",
          storagePath,
          ":",
          rmErr.message,
        );
      }

      archived++;
      freedBytes += arrayBuf.byteLength;
    } catch (err) {
      errors.push({
        photo_id: p.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    result: {
      archived,
      freed_bytes: freedBytes,
      errors,
      remaining: eligible.length === ARCHIVE_BATCH ? "unknown" : 0,
    },
  };
}

flipdeskImageRoutes.post("/archive", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  if (!isR2Configured()) {
    return c.json({ error: "R2 is not configured on this server." }, 503);
  }

  const out = await archiveOwnerPhotos(userId);
  if (!out.ok) {
    return failSafe(c, 500, "Failed to load eligible photos", out.error, "flipdesk-images.archive.list");
  }
  return c.json(out.result);
});


// ── US-3196: adopt an item's eBay-hosted photos ────────────────────────────
//
// POST /adopt-remote  { item_id }
//
// The eBay sync mirrors a listing's pictures onto the item BY REFERENCE:
// photo_url points at i.ebayimg.com, storage_path is NULL, remote_source is
// 'ebay' (see lib/ebay-photo-mirror.ts for why). That is enough to look at and
// not enough to work with — a referenced photo cannot be cropped or tone
// matched, cannot be sent to a marketplace, and dies when the seller ends the
// eBay listing it was borrowed from.
//
// This is the one action that reverses all three, for one item, when the seller
// asks. It downloads each picture through the same pipeline every other server
// upload uses (US-276: safeFetch, then validateImageUpload, then
// stripImageMetadata, then storage.upload), and repoints the row at our copy.
//
// remote_source_url is deliberately KEPT while remote_source is cleared. The
// first is the dedupe key the next sync compares against, so losing it would
// re-add every adopted photo as a fresh reference; the second is what marks the
// row unlistable, so keeping it would leave a photo we now own unpublishable.

/** Ceiling per photo. Matches the closet import; eBay's own limit is smaller. */
const ADOPT_PHOTO_MAX_BYTES = 12 * 1024 * 1024;

/**
 * A render below this on the long side is refused.
 *
 * eBay serves the same picture at a dozen sizes and the mirror upgrades every
 * URL to the largest before storing it. If that rewrite ever stops matching a
 * URL shape, the adopt would silently save 140px thumbnails over what the
 * seller believes are their photos, and nothing else would go red. This is the
 * floor that makes that failure visible instead.
 */
const ADOPT_MIN_DIMENSION = 500;

interface RemotePhotoRow {
  id: string;
  photo_url: string;
  photo_type: string | null;
  sort_order: number;
  remote_source_url: string | null;
}

flipdeskImageRoutes.post("/adopt-remote", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id.trim() : "";
  if (!itemId) return c.json({ error: "item_id is required" }, 400);

  // US-268: the item id is request input. Establish ownership FIRST, then key
  // every read and write below on the id this query cleared, never on the id
  // that arrived in the body.
  const { data: itemRow, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (itemErr) {
    return failSafe(c, 500, "Failed to load item", itemErr, "flipdesk-images.adopt.item");
  }
  if (!itemRow) return c.json({ error: "Item not found" }, 404);
  const ownedItemId = (itemRow as { id: string }).id;

  const { data: photoRows, error: photosErr } = await supabaseAdmin
    .from("item_photos")
    .select("id, photo_url, photo_type, sort_order, remote_source_url")
    .eq("inventory_item_id", ownedItemId)
    .not("remote_source", "is", null)
    .order("sort_order", { ascending: true });
  if (photosErr) {
    return failSafe(c, 500, "Failed to load photos", photosErr, "flipdesk-images.adopt.photos");
  }
  const photos = (photoRows ?? []) as unknown as RemotePhotoRow[];
  if (photos.length === 0) {
    return c.json({
      adopted: 0,
      failures: [],
      message: "No eBay-hosted photos on this item.",
    });
  }

  const failures: Array<{ photo_id: string; message: string }> = [];
  let adopted = 0;

  for (const photo of photos) {
    const source = (photo.remote_source_url ?? photo.photo_url ?? "").trim();
    try {
      // Host allowlist on top of safeFetch's private-range refusal. safeFetch
      // stops the edge reaching our own network; this stops it fetching from an
      // arbitrary public site if a row's URL is ever not what we wrote.
      if (!isEbayPhotoUrl(source)) {
        failures.push({ photo_id: photo.id, message: "Not an eBay image URL." });
        continue;
      }
      const res = await safeFetch(source, {
        maxBytes: ADOPT_PHOTO_MAX_BYTES,
        timeoutMs: 12_000,
      });
      if (res.status !== 200) {
        // The overwhelmingly likely cause, and worth saying plainly: eBay
        // purges a listing's images once the seller ends it.
        failures.push({
          photo_id: photo.id,
          message: res.status === 404
            ? "eBay no longer has this image (the listing was probably ended)."
            : `eBay answered ${res.status}.`,
        });
        continue;
      }

      const check = validateImageUpload(res.bytes, {
        allow: ["jpeg", "png", "webp"],
        minDimension: ADOPT_MIN_DIMENSION,
      });
      if (!check.ok) {
        failures.push({ photo_id: photo.id, message: check.reason });
        continue;
      }
      const stripped = stripImageMetadata(res.bytes, check.format).bytes;
      const dims = readImageDimensions(stripped) ??
        (check.width && check.height
          ? { width: check.width, height: check.height }
          : null);

      const path =
        `${ownerId}/${ownedItemId}/ebay_${photo.sort_order}_${Date.now()}.${check.ext}`;
      const { error: upErr } = await supabaseAdmin.storage
        .from(ITEM_PHOTOS_BUCKET)
        .upload(path, stripped, { contentType: check.contentType, upsert: false });
      if (upErr) {
        failures.push({
          photo_id: photo.id,
          message: `Could not store: ${upErr.message}`,
        });
        continue;
      }
      // item-photo-url-ok: a just-uploaded object in the public listing bucket.
      const publicUrl = supabaseAdmin.storage
        .from(ITEM_PHOTOS_BUCKET)
        .getPublicUrl(path).data.publicUrl;

      const { error: updErr } = await supabaseAdmin
        .from("item_photos")
        .update({
          storage_path: path,
          photo_url: publicUrl,
          // Cleared: the bytes are ours now, so the row is listable again.
          remote_source: null,
          // Kept: this is what stops the next sync re-adding the picture.
          remote_source_url: source,
          width: dims?.width ?? null,
          height: dims?.height ?? null,
          bytes: stripped.length,
        } as never)
        .eq("id", photo.id)
        .eq("inventory_item_id", ownedItemId);
      if (updErr) {
        // Roll the object back rather than leaving a paid-for orphan nothing
        // points at. Best effort: a failed cleanup is not worth failing on.
        await supabaseAdmin.storage
          .from(ITEM_PHOTOS_BUCKET)
          .remove([path])
          .then(() => {}, () => {});
        failures.push({
          photo_id: photo.id,
          message: `Could not record: ${updErr.message}`,
        });
        continue;
      }
      adopted += 1;
    } catch (err) {
      // One bad picture must not lose the others. Every photo reports its own
      // outcome and the caller decides what to say about a partial run.
      failures.push({
        photo_id: photo.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({ adopted, failures });
});

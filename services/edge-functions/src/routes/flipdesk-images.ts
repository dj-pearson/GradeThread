import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import {
  downloadItemPhoto,
  SENSITIVE_ITEM_PHOTO_TYPES,
} from "../lib/item-photo-storage.ts";
import {
  headR2Object,
  isR2Configured,
  putR2Object,
  r2PublicUrl,
} from "../lib/r2-client.ts";
import { readImageDimensions } from "../lib/upload-validation.ts";

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
  if (SENSITIVE_ITEM_PHOTO_TYPES.has(photo.photo_type ?? "")) {
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

flipdeskImageRoutes.post("/archive", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  if (!isR2Configured()) {
    return c.json({ error: "R2 is not configured on this server." }, 503);
  }

  const cutoffIso = new Date(
    Date.now() - ARCHIVE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Eligible: photo's item belongs to user, item is in a terminal status,
  // item.updated_at is older than the cutoff, and photo is not yet archived.
  // We require storage_path so we know what to delete on the Supabase side.
  //
  // 🔒 SENSITIVE TYPES ARE EXCLUDED. A tag / tag_2 / certificate close-up lives
  // in the PRIVATE submission-images bucket (US-979), and downloadItemPhoto
  // below deliberately resolves across BOTH buckets — so without this filter
  // archival would fetch the private original and rewrite photo_url to
  // r2PublicUrl(), an UNAUTHENTICATED public URL. That publishes exactly the
  // PII (serials, receipts, certificate numbers) the rest of the codebase is
  // careful to keep private: bg-remove refuses these types (US-1638, above),
  // the eBay push filters them (flipdesk-ebay.ts), and so does the thumbnail
  // backfill. Archival was the one path that didn't.
  const { data: rows, error } = await supabaseAdmin
    .from("item_photos")
    .select(
      "id, inventory_item_id, photo_type, photo_url, storage_path, bytes, inventory_items!inner(user_id, status, updated_at)",
    )
    .eq("archived_to_r2", false)
    .eq("inventory_items.user_id", userId)
    .in("inventory_items.status", ARCHIVAL_STATUSES)
    .lt("inventory_items.updated_at", cutoffIso)
    .not("storage_path", "is", null)
    .not(
      "photo_type",
      "in",
      `(${[...SENSITIVE_ITEM_PHOTO_TYPES].join(",")})`,
    )
    .limit(ARCHIVE_BATCH);

  if (error) {
    return failSafe(c, 500, "Failed to load eligible photos", error, "flipdesk-images.archive.list");
  }
  const eligible = (rows ?? []) as unknown as Array<
    PhotoToArchive & {
      inventory_items: { user_id: string; status: string; updated_at: string };
    }
  >;

  if (eligible.length === 0) {
    return c.json({ archived: 0, freed_bytes: 0, errors: [], remaining: 0 });
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

  return c.json({
    archived,
    freed_bytes: freedBytes,
    errors,
    remaining: eligible.length === ARCHIVE_BATCH ? "unknown" : 0,
  });
});

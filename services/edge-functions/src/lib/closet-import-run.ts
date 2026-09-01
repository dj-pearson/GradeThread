// US-9201 — the worker half of the closet import.
//
// A run row in flipdesk_import_runs with origin 'poshmark' or 'mercari' holds
// the rows the extension read (lib/closet-import.ts decided their shape). This
// module turns them into inventory items, listings and photos, one effect row
// per change, under the same claim / heartbeat / reclaim contract as the CSV
// worker in routes/flipdesk-import.ts (the durable-jobs skill). It is a lib
// rather than part of that route file so the reclaim cron can resume either
// kind of run without the two workers importing each other.
//
// TENANCY (US-268). The service-role client bypasses RLS. Every read and write
// below is scoped to run.user_id, which came off the run row the caller's token
// created, never off the payload: a platform_listing_id in the payload is
// attacker-controlled and only ever matches rows that ALSO carry the owner.
//
// PHOTOS follow the CLAUDE.md storage rules to the letter: fetched through
// safeFetch (private ranges refused, redirects re-validated), host-restricted to
// the marketplace's own CDN, sniffed by magic bytes, stripped of EXIF, and only
// then written to item-photos. A marketplace URL is never stored as photo_url.

import { supabaseAdmin } from "./supabase.ts";
import { safeFetch } from "./ssrf.ts";
import { readImageDimensions, validateImageUpload } from "./upload-validation.ts";
import { stripImageMetadata } from "./image-metadata.ts";
import { ITEM_PHOTOS_BUCKET } from "./item-photo-storage.ts";
import { MAX_RUN_ATTEMPTS } from "./inventory-import.ts";
import {
  type ClosetImportRow,
  closetFillPatch,
  closetImportProvenance,
  closetListingPatch,
  isClosetImportPlatform,
  itemFieldsForRow,
  photoHostAllowed,
  photoTypeForIndex,
} from "./closet-import.ts";

/** Progress is flushed to the run row every this many processed rows. */
const HEARTBEAT_EVERY = 5;

/**
 * Photos below this on the long side are refused. The extension upgrades
 * thumbnail URLs to the full render before posting; if that rule ever stops
 * matching (the exact failure vault/10-ops/extension-adapter-verification.md
 * documents), the copies would be thumbnails and nothing would go red. This is
 * the server-side floor that makes that failure visible: a 200px "s_" render
 * is refused and the row reports it, rather than a thumbnail passing as a
 * photo.
 */
export const CLOSET_PHOTO_MIN_DIMENSION = 500;

/** Per-photo fetch bound. A listing render is well under this. */
const PHOTO_MAX_BYTES = 12 * 1024 * 1024;

interface RunRow {
  id: string;
  user_id: string;
  status: string;
  origin: string;
  payload: unknown;
  attempts: number;
}

interface ExistingListing {
  id: string;
  inventory_item_id: string;
  listing_price: number | null;
  listing_url: string | null;
  listing_title: string | null;
  listing_description: string | null;
  is_active: boolean;
  inventory_items: {
    id: string;
    user_id: string;
    description: string | null;
    brand: string | null;
    size: string | null;
    condition_notes: string | null;
  };
}

export interface PhotoCopyResult {
  copied: number;
  /** One line per photo that was refused or could not be fetched. */
  failures: string[];
}

/**
 * Copy a listing's photos into item-photos.
 *
 * Failures are per photo and never abort the row: an item with two of its six
 * photos is worth more than no item, and the seller's error list says which
 * ones did not make it. Only the FIRST photo is the cover ('front').
 */
export async function copyClosetPhotos(
  ownerId: string,
  itemId: string,
  row: ClosetImportRow,
  deps: { fetch: typeof safeFetch } = { fetch: safeFetch },
): Promise<PhotoCopyResult> {
  const failures: string[] = [];
  let copied = 0;
  for (let i = 0; i < row.photo_urls.length; i++) {
    const url = row.photo_urls[i]!;
    if (!photoHostAllowed(row.platform, url)) {
      failures.push(`photo ${i + 1}: not a ${row.platform} image host`);
      continue;
    }
    let bytes: Uint8Array;
    try {
      const res = await deps.fetch(url, { maxBytes: PHOTO_MAX_BYTES, timeoutMs: 12_000 });
      if (res.status !== 200) {
        failures.push(`photo ${i + 1}: marketplace answered ${res.status}`);
        continue;
      }
      bytes = res.bytes;
    } catch (err) {
      failures.push(`photo ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const check = validateImageUpload(bytes, {
      allow: ["jpeg", "png", "webp"],
      minDimension: CLOSET_PHOTO_MIN_DIMENSION,
    });
    if (!check.ok) {
      failures.push(`photo ${i + 1}: ${check.reason}`);
      continue;
    }
    const stripped = stripImageMetadata(bytes, check.format).bytes;
    const dims = readImageDimensions(stripped) ??
      (check.width && check.height ? { width: check.width, height: check.height } : null);

    const path = `${ownerId}/${itemId}/import_${row.platform}_${i}_${Date.now()}.${check.ext}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(ITEM_PHOTOS_BUCKET)
      .upload(path, stripped, { contentType: check.contentType, upsert: false });
    if (upErr) {
      failures.push(`photo ${i + 1}: could not store (${upErr.message})`);
      continue;
    }
    // item-photo-url-ok: a just-uploaded object in the public listing bucket.
    const publicUrl = supabaseAdmin.storage.from(ITEM_PHOTOS_BUCKET).getPublicUrl(path)
      .data.publicUrl;
    const { error: insErr } = await supabaseAdmin.from("item_photos").insert({
      inventory_item_id: itemId,
      photo_type: photoTypeForIndex(copied),
      storage_path: path,
      photo_url: publicUrl,
      sort_order: copied,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    });
    if (insErr) {
      await supabaseAdmin.storage.from(ITEM_PHOTOS_BUCKET).remove([path]).then(() => {}, () => {});
      failures.push(`photo ${i + 1}: could not record (${insErr.message})`);
      continue;
    }
    copied++;
  }
  return { copied, failures };
}

async function itemPhotoCount(ownerId: string, itemId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("item_photos")
    .select("id, inventory_items!inner(user_id)", { count: "exact", head: true })
    .eq("inventory_item_id", itemId)
    .eq("inventory_items.user_id", ownerId);
  return count ?? 0;
}

async function bumpProgress(
  runId: string,
  processed: number,
  inserted: number,
  updated: number,
  skipped: number,
  errors: Array<{ row: number; message: string }>,
): Promise<void> {
  await supabaseAdmin
    .from("flipdesk_import_runs")
    .update({
      processed_rows: processed,
      inserted_count: inserted,
      updated_count: updated,
      skipped_count: skipped,
      failed_count: errors.length,
      errors: errors.slice(0, 200),
    })
    .eq("id", runId);
}

/**
 * Process one closet import run to completion.
 *
 * Safe to call twice: the claim is a conditional UPDATE, and rows already
 * recorded by an effect row are skipped, so a run resumed by the reclaim cron
 * continues from where the dead worker stopped instead of re-inserting.
 */
export async function processClosetImportRun(runId: string): Promise<void> {
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("flipdesk_import_runs")
    .update({ status: "running", error: null })
    .eq("id", runId)
    .eq("status", "pending")
    .select("id, user_id, status, origin, payload, attempts")
    .maybeSingle();
  if (claimErr) {
    console.error("[closet-import] claim failed:", claimErr.message);
    return;
  }
  if (!claimed) return; // another worker has it

  const run = claimed as RunRow;
  const ownerId = run.user_id;
  const attempts = (run.attempts ?? 0) + 1;
  await supabaseAdmin.from("flipdesk_import_runs").update({ attempts }).eq("id", runId);

  if (attempts > MAX_RUN_ATTEMPTS) {
    await supabaseAdmin
      .from("flipdesk_import_runs")
      .update({ status: "failed", error: `Gave up after ${MAX_RUN_ATTEMPTS} attempts.` })
      .eq("id", runId);
    return;
  }

  if (!isClosetImportPlatform(run.origin)) {
    await supabaseAdmin
      .from("flipdesk_import_runs")
      .update({ status: "failed", error: `Not a closet import run (origin ${run.origin}).` })
      .eq("id", runId);
    return;
  }

  const rows = Array.isArray(run.payload) ? (run.payload as ClosetImportRow[]) : [];
  const errors: Array<{ row: number; message: string }> = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const { data: doneRows } = await supabaseAdmin
    .from("flipdesk_import_effects")
    .select("row_number")
    .eq("run_id", runId)
    .eq("user_id", ownerId);
  const alreadyDone = new Set<number>();
  for (const d of (doneRows ?? []) as Array<{ row_number: number | null }>) {
    if (typeof d.row_number === "number") alreadyDone.add(d.row_number);
  }

  const nowIso = new Date().toISOString();

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNumber = typeof row.row === "number" ? row.row : i + 1;
      if (alreadyDone.has(rowNumber)) continue;

      try {
        // Dedupe key: (platform, platform_listing_id), owner-scoped. A listing
        // of B's with the same marketplace id is a different row and never
        // matches here.
        const { data: found, error: findErr } = await supabaseAdmin
          .from("listings")
          .select(
            "id, inventory_item_id, listing_price, listing_url, listing_title, listing_description, is_active, " +
              "inventory_items!inner(id, user_id, description, brand, size, condition_notes)",
          )
          .eq("platform", row.platform)
          .eq("platform_listing_id", row.platform_listing_id)
          .eq("user_id", ownerId)
          .limit(1)
          .maybeSingle();
        if (findErr) throw new Error(findErr.message);
        const existing = found as unknown as ExistingListing | null;

        if (existing && existing.inventory_items.user_id === ownerId) {
          const itemId = existing.inventory_item_id;
          const item = existing.inventory_items as unknown as Record<string, unknown>;
          const itemPatch = closetFillPatch(item, row);
          const { patch: listingPatch, previous: listingPrevious } = closetListingPatch(
            existing as unknown as Record<string, unknown>,
            row,
          );

          const previous: Record<string, unknown> = {};
          for (const key of Object.keys(itemPatch)) previous[key] = item[key] ?? null;
          if (Object.keys(listingPatch).length > 0) previous._listing = listingPrevious;

          if (Object.keys(itemPatch).length > 0) {
            const { error: upErr } = await supabaseAdmin
              .from("inventory_items")
              .update(itemPatch)
              .eq("id", itemId)
              .eq("user_id", ownerId);
            if (upErr) throw new Error(upErr.message);
          }
          if (Object.keys(listingPatch).length > 0) {
            const { error: lErr } = await supabaseAdmin
              .from("listings")
              .update(listingPatch)
              .eq("id", existing.id)
              .eq("user_id", ownerId);
            if (lErr) throw new Error(lErr.message);
          }

          // Photos only when the item has none: a second read must never
          // duplicate a gallery the first one already copied.
          let photos: PhotoCopyResult = { copied: 0, failures: [] };
          if (row.photo_urls.length > 0 && (await itemPhotoCount(ownerId, itemId)) === 0) {
            photos = await copyClosetPhotos(ownerId, itemId, row);
          }
          for (const f of photos.failures) errors.push({ row: rowNumber, message: f });

          const changed = Object.keys(itemPatch).length > 0 ||
            Object.keys(listingPatch).length > 0 || photos.copied > 0;
          if (!changed) {
            skipped++;
          } else {
            await supabaseAdmin.from("flipdesk_import_effects").insert({
              run_id: runId,
              user_id: ownerId,
              row_number: rowNumber,
              action: "filled",
              inventory_item_id: itemId,
              listing_id: existing.id,
              previous,
            });
            updated++;
          }
        } else {
          const { data: itemRow, error: itemErr } = await supabaseAdmin
            .from("inventory_items")
            .insert({
              user_id: ownerId,
              title: row.title,
              item_category: "clothing",
              // A closet listing is live on the marketplace, so the item is
              // 'listed' and occupies an active-listing slot exactly as a
              // pulled eBay listing does (the gate ran before the run was
              // created, in routes/flipdesk-closet-import.ts).
              status: "listed",
              ...itemFieldsForRow(row),
            })
            .select("id")
            .single();
          if (itemErr) throw new Error(itemErr.message);
          const itemId = (itemRow as { id: string }).id;

          const { data: lRow, error: lErr } = await supabaseAdmin
            .from("listings")
            .insert({
              inventory_item_id: itemId,
              platform: row.platform,
              platform_listing_id: row.platform_listing_id,
              listing_url: row.listing_url,
              listing_title: row.title,
              listing_description: row.description,
              listing_price: row.price ?? 0,
              listing_status: "active",
              is_active: true,
              listed_at: nowIso,
              // The enum has 'gradethread' and 'ebay' only, and a switcher
              // wants the row editable here; provenance lives in platform_fields
              // (lib/closet-import.ts closetImportProvenance).
              listing_origin: "gradethread",
              platform_fields: { closet_import: closetImportProvenance(row, runId, nowIso) },
            })
            .select("id")
            .single();
          if (lErr) {
            // Undo the half-made item rather than leave an orphan the effect
            // rows do not know about.
            await supabaseAdmin.from("inventory_items").delete().eq("id", itemId).eq("user_id", ownerId);
            throw new Error(lErr.message);
          }
          const listingId = (lRow as { id: string }).id;

          const photos = await copyClosetPhotos(ownerId, itemId, row);
          for (const f of photos.failures) errors.push({ row: rowNumber, message: f });

          await supabaseAdmin.from("flipdesk_import_effects").insert({
            run_id: runId,
            user_id: ownerId,
            row_number: rowNumber,
            action: "inserted",
            inventory_item_id: itemId,
            listing_id: listingId,
          });
          inserted++;
        }
      } catch (err) {
        errors.push({
          row: rowNumber,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if ((i + 1) % HEARTBEAT_EVERY === 0) {
        await bumpProgress(runId, i + 1, inserted, updated, skipped, errors);
      }
    }

    await supabaseAdmin
      .from("flipdesk_import_runs")
      .update({
        status: "completed",
        processed_rows: rows.length,
        inserted_count: inserted,
        updated_count: updated,
        skipped_count: skipped,
        failed_count: errors.length,
        errors: errors.slice(0, 200),
      })
      .eq("id", runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[closet-import] run failed:", message);
    await supabaseAdmin
      .from("flipdesk_import_runs")
      .update({
        status: "failed",
        error: message,
        inserted_count: inserted,
        updated_count: updated,
        skipped_count: skipped,
        failed_count: errors.length,
        errors: errors.slice(0, 200),
      })
      .eq("id", runId);
  }
}

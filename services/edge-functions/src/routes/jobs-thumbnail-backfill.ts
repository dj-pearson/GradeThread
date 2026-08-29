// US-1518: thumbnail backfill cron.
//
// InventoryRow / board cards load `thumbnail_url ?? photo_url`, but only the web
// upload path (photo-uploader.tsx, client-side) and the AutoLister ever WRITE
// thumbnail_url. Normal iOS uploads leave it null, so every 56pt cell downloads
// the full ~450–500KB 1600px JPEG — a 300-item scroll can transfer >100MB against
// a ~700KB/s self-hosted backend with Cloudflare Image Resizing disabled.
//
// This job generates a 320px JPEG thumbnail server-side for item_photos rows that
// lack one, and writes thumbnail_url + thumbnail_storage_path. It covers BOTH the
// one-time backfill of existing photos AND new iOS uploads (AC1's sanctioned "or
// an edge job" alternative — the iOS foreground uploader is deliberately ONE PUT
// per photo against fragile storage, so we don't add a second client PUT).
//
// SENSITIVE photos (tag/tag_2/certificate — private submission-images bucket,
// empty photo_url) are SKIPPED: their thumbnails must not become public objects
// (AC3 keeps private-bucket rules intact), and the inventory row never shows them
// via photo_url anyway.
//
// US-2836 AC3: ROWS WRITTEN BEFORE THE CACHE-BUSTER ARE NOT REPAIRED, and that
// is a decision rather than an oversight.
//
// This job only ever touches rows where thumbnail_url IS NULL (the .is() filter
// below), so a row that already carries an un-busted URL is never revisited. Its
// stored bytes are already correct - persistPhotoEdit deleted the old object and
// this job regenerated it - so the only thing stale is what a browser or the
// Cloudflare edge is still holding, and Supabase advertises max-age=14400. Those
// copies expire within four hours and the row is then correct everywhere with no
// write at all.
//
// The alternative was a one-off sweep appending ?v= to every existing
// thumbnail_url. That is a write across every photo row in the product to fix a
// display that fixes itself before most sellers notice, and it would invalidate
// every correctly-cached thumbnail at the same time - making the median seller's
// grid slower to fix the tail. Not worth it. Recorded here so the next person
// reading a four-hour-old complaint knows it is expected and self-resolving
// rather than a fix that did not take.
//
// Idempotent (only NULL-thumbnail rows), bounded per run, overlap-locked. Mounted
// in main.ts as POST /api/jobs/thumbnail-backfill, gated by X-Internal-Job-Secret.
// Run it on a Coolify scheduled task (e.g. every 5 min):
//   curl -fsS -X POST https://functions.gradethread.com/api/jobs/thumbnail-backfill \
//     -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET"
// Returns { processed, failed, remaining } — schedule until `remaining` hits 0 for
// the initial backfill; steady-state it keeps new iOS photos covered.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  downloadItemPhoto,
  ITEM_PHOTOS_BUCKET,
  SENSITIVE_ITEM_PHOTO_TYPES,
} from "../lib/item-photo-storage.ts";
import {
  bustedThumbnailUrl,
  generateThumbnail,
  thumbnailStoragePath,
} from "../lib/thumbnail.ts";

// Bounded so one run is a short, predictable unit of work (each row = a full-image
// download + decode + resize + thumb upload). The scheduler drains the backlog
// across runs; `remaining` tells it when to stop.
const BATCH_LIMIT = 100;

interface PhotoRow {
  id: string;
  storage_path: string | null;
  photo_type: string | null;
}

export async function handleThumbnailBackfillCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // US-2311: lease is 2x the */5 schedule interval. At <= 1x, a run
  // that overruns by a second is displaced by the very next tick.
  const lock = await acquireJobLock("thumbnail-backfill", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const sensitive = [...SENSITIVE_ITEM_PHOTO_TYPES];
    // Non-sensitive, public-bucket photos still missing a thumbnail. photo_url
    // must be non-empty (sensitive photos carry ""), and photo_type excludes the
    // private slots explicitly (defense in depth).
    const { data, error } = await supabaseAdmin
      .from("item_photos")
      .select("id, storage_path, photo_type")
      .is("thumbnail_url", null)
      .neq("photo_url", "")
      // A photo archived to R2 (flipdesk-images.ts) has its Supabase object
      // deleted, so downloadItemPhoto would 404 forever — its bytes live on R2.
      // Skip it: terminal-status items don't need a Supabase-sourced thumbnail.
      .eq("archived_to_r2", false)
      // US-1518 follow-up: skip rows already found to have a permanently-missing
      // source object (marked below), so a dead pointer is not retried forever.
      .is("thumbnail_backfill_failed_at", null)
      .not("photo_type", "in", `(${sensitive.join(",")})`)
      .not("storage_path", "is", null)
      .limit(BATCH_LIMIT);

    if (error) {
      console.error("[jobs-thumbnail-backfill] query failed:", error.message);
      return c.json({ error: "Query failed" }, 500);
    }
    const rows = (data ?? []) as PhotoRow[];

    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      if (!row.storage_path) continue;
      try {
        const dl = await downloadItemPhoto(row.storage_path, row.photo_type);
        if ("error" in dl) {
          // US-1518 follow-up: distinguish a PERMANENTLY missing object (404 in
          // both buckets — deleted out-of-band or never landed) from a transient
          // error. A permanent miss is stamped terminal so the query above skips
          // it on future runs instead of retrying it forever; transient errors
          // (network / 5xx) are left unmarked and retry as before. Best-effort —
          // a failed stamp just means we retry once more next run, not a crash.
          if (/not\s*found/i.test(dl.error)) {
            await supabaseAdmin
              .from("item_photos")
              .update({ thumbnail_backfill_failed_at: new Date().toISOString() })
              .eq("id", row.id);
            console.warn(
              `[jobs-thumbnail-backfill] source object missing for ${row.id} ` +
                `(${dl.error}) — marked terminal, will not retry`,
            );
          } else {
            console.warn(
              `[jobs-thumbnail-backfill] download failed for ${row.id}: ${dl.error}`,
            );
          }
          failed++;
          continue;
        }
        const srcBytes = new Uint8Array(await dl.blob.arrayBuffer());
        const thumb = await generateThumbnail(srcBytes);

        const thumbPath = thumbnailStoragePath(row.storage_path);
        const { error: upErr } = await supabaseAdmin.storage
          .from(ITEM_PHOTOS_BUCKET)
          .upload(thumbPath, thumb.bytes, {
            upsert: true,
            contentType: "image/jpeg",
          });
        if (upErr) {
          console.warn(
            `[jobs-thumbnail-backfill] thumb upload failed for ${row.id}: ${upErr.message}`,
          );
          failed++;
          continue;
        }
        // US-2836: the path is deterministic, so a REGENERATED thumbnail reuses
        // the same public URL and every cached copy of the pre-edit image keeps
        // winning for the four hours Supabase advertises. Bust it, the same way
        // persistPhotoEdit already busts photo_url.
        const thumbUrl = bustedThumbnailUrl(
          supabaseAdmin.storage.from(ITEM_PHOTOS_BUCKET).getPublicUrl(thumbPath)
            .data.publicUrl,
        );

        const { error: updErr } = await supabaseAdmin
          .from("item_photos")
          .update({
            thumbnail_url: thumbUrl,
            thumbnail_storage_path: thumbPath,
          })
          .eq("id", row.id);
        if (updErr) {
          console.warn(
            `[jobs-thumbnail-backfill] row update failed for ${row.id}: ${updErr.message}`,
          );
          failed++;
          continue;
        }
        processed++;
      } catch (err) {
        console.warn(
          `[jobs-thumbnail-backfill] unexpected error for ${row.id}:`,
          err instanceof Error ? err.message : String(err),
        );
        failed++;
      }
    }

    // `remaining` is only known to be >0 when we filled the batch; a short batch
    // means we drained the current backlog. (An exact count would need a second
    // COUNT query every run — not worth it for a drain-to-zero scheduler.)
    const remaining = rows.length >= BATCH_LIMIT ? "more" : 0;
    return c.json({ ok: true, processed, failed, remaining });
  } finally {
    await lock.release();
  }
}

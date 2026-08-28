// US-2890 AC2/AC5: the pass that actually rewrites the stored photo.
//
// measure-auto-upright.ts holds the decisions and the pixel math and touches
// no storage, so its cases run without a bucket. This is the half that talks to
// Supabase, and it is deliberately small: read, decide, preserve, write,
// record.
//
// US-268. item_photos carries NO user_id - ownership runs entirely through
// inventory_item_id - so this is the ownership-via-verified-parent shape: the
// inventory_items row is loaded with .eq("user_id", ownerId) FIRST, and the
// photo query is keyed on the id that verification returned. An itemId reaching
// here from a request body is attacker-controlled until that select comes back
// non-empty.
//
// EVERY FAILURE LEAVES THE PHOTO ALONE. There is no half-rotated state to
// recover from, because the order is: copy the original aside, rotate in
// memory, write the new bytes, then update the row. A failure at any step
// before the row update leaves a photo whose bytes and whose calibration still
// agree with each other.

import { supabaseAdmin } from "./supabase.ts";
import { downloadItemPhoto, readBucketForItemPhoto } from "./item-photo-storage.ts";
import { getSetting } from "./system-settings.ts";
import type { StoredCalibration } from "./measure-calibrate.ts";
import {
  AUTO_UPRIGHT_SETTING_KEY,
  decideUpright,
  rotateImageBytes,
  uprightCalibration,
  uprightMessage,
  uprightRecipe,
  type UprightPhotoRow,
  type UprightSkipReason,
} from "./measure-auto-upright.ts";
import { rotatedDims } from "./measure-quarter-turn.ts";

/** `ai_field_sources` key holding the last upright pass's outcome (AC5). */
export const UPRIGHT_PASS_KEY = "measurements._upright";

export interface UprightPassResult {
  /** Photos whose stored bytes were rewritten. */
  rotated: Array<{ photoId: string; turns: number; message: string }>;
  /** Why each untouched photo was untouched, for the operator log. */
  skipped: Array<{ photoId: string; reason: UprightSkipReason | string }>;
  /** True when the setting is off, so a caller can say "nothing ran" honestly. */
  disabled: boolean;
}

/** The original's home, mirroring the browser editor's originalPathFor. */
export function originalPathFor(storagePath: string): string {
  const cut = storagePath.lastIndexOf("/");
  if (cut < 0) return `originals/${storagePath}`;
  return `${storagePath.slice(0, cut)}/originals/${storagePath.slice(cut + 1)}`;
}

interface UprightRow extends UprightPhotoRow {
  photo_url: string | null;
  measure_calibration: StoredCalibration | null;
}

/**
 * Turn every eligible photo on one item upright.
 *
 * Returns what happened rather than throwing: this runs inside the intake pass,
 * which fails softly by design because a bad card photo must never block a
 * listing. A rotation that could not happen is not a reason to lose the
 * measurements that already did.
 */
export async function autoUprightItemPhotos(
  itemId: string,
  ownerId: string,
): Promise<UprightPassResult> {
  const enabled = await getSetting<boolean>(AUTO_UPRIGHT_SETTING_KEY, false);
  if (enabled !== true) return { rotated: [], skipped: [], disabled: true };

  // US-268 rule 2. Nothing below runs unless this row belongs to ownerId.
  const { data: owned, error: ownErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (ownErr || !owned) return { rotated: [], skipped: [], disabled: false };

  const { data: rows } = await supabaseAdmin
    .from("item_photos")
    .select(
      "id, storage_path, photo_type, photo_url, used_for_grading, original_storage_path, edit_recipe, width, height, measure_calibration",
    )
    .eq("inventory_item_id", (owned as { id: string }).id);

  const out: UprightPassResult = { rotated: [], skipped: [], disabled: false };

  for (const row of (rows ?? []) as UprightRow[]) {
    const calibration = row.measure_calibration;
    const decision = decideUpright(row, calibration?.uprightTurns ?? null, true);
    if (!decision.rotate) {
      out.skipped.push({ photoId: row.id, reason: decision.reason ?? "already_upright" });
      continue;
    }

    const path = row.storage_path!;

    const dl = await downloadItemPhoto(path, row.photo_type);
    if ("error" in dl) {
      out.skipped.push({ photoId: row.id, reason: `download_failed: ${dl.error}` });
      continue;
    }
    const srcBytes = new Uint8Array(await dl.blob.arrayBuffer());

    // THE READ BUCKET, and this is the third answer rather than the second.
    //
    // bucketForItemPhoto(photo_type) is the WRITE-time router for a NEW object
    // and is wrong here: US-2407 already fought this exact battle, where the
    // type deciding the bucket meant a seller changing the type dropdown
    // changed where the edge looked for bytes that had not moved.
    //
    // dl.bucket is better - downloadItemPhoto searches both and reports which
    // one answered - but it is a SEARCH RESULT, and a row whose bytes exist in
    // both buckets (a legacy copy, a half-finished migration) would have this
    // pass writing to whichever the search happened to hit first.
    //
    // readBucketForItemPhoto(photo_url) is the canonical answer, mirrored on
    // the web as bucketForItemPhotoRow (src/lib/item-photo-url.ts) and on iOS
    // as PhotoStorageBucket.readBucket. That mirroring is the whole point for
    // AC2: revertPhotoEdit resolves the bucket with the web's copy, so an
    // original preserved anywhere else cannot be found and the undo this
    // feature rests on fails silently.
    const bucket = readBucketForItemPhoto(row.photo_url);
    if (bucket !== dl.bucket) {
      // Not fatal, and not silent. The bytes were found somewhere other than
      // where all three clients agree they live, which means this row's
      // photo_url and its object have drifted apart. Rotating it would write
      // the new bytes to the canonical bucket and leave the old ones being
      // served from the other, so it is left alone.
      out.skipped.push({
        photoId: row.id,
        reason: `bucket_mismatch: row says ${bucket}, bytes found in ${dl.bucket}`,
      });
      continue;
    }

    // The original is copied aside exactly ONCE, on the first edit, and
    // original_storage_path is what records that it happened. A photo the
    // seller has already edited by hand keeps ITS original, not this one -
    // otherwise "revert" would return them to their own last edit rather than
    // to the picture they uploaded.
    let originalPath = row.original_storage_path ?? null;
    if (!originalPath) {
      const candidate = originalPathFor(path);
      const { error: upErr } = await supabaseAdmin.storage
        .from(bucket)
        .upload(candidate, srcBytes, { contentType: "image/png", upsert: true });
      if (upErr) {
        // AC2 says the original is preserved and revertible. If it cannot be,
        // the rotation does not happen - an automatic rewrite with no way back
        // is the one outcome this feature must never produce.
        out.skipped.push({ photoId: row.id, reason: `original_copy_failed: ${upErr.message}` });
        continue;
      }
      originalPath = candidate;
    }

    let rotatedBytes;
    try {
      rotatedBytes = await rotateImageBytes(srcBytes, decision.turns);
    } catch (err) {
      out.skipped.push({
        photoId: row.id,
        reason: `rotate_failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const { error: writeErr } = await supabaseAdmin.storage
      .from(bucket)
      .upload(path, rotatedBytes.bytes, { contentType: "image/png", upsert: true });
    if (writeErr) {
      out.skipped.push({ photoId: row.id, reason: `write_failed: ${writeErr.message}` });
      continue;
    }

    // The pre-rotation dimensions are what the stored geometry is expressed in,
    // so they are what the carry is given. Preferring the row's own columns
    // over the decoder keeps this correct even if the two ever disagree, and
    // falling back to the decoder keeps it working on the rows written before
    // US-2888 started populating width/height at all.
    const [sw, sh] = row.width && row.height
      ? [row.width, row.height]
      : rotatedDims(rotatedBytes.width, rotatedBytes.height, decision.turns);

    const patch: Record<string, unknown> = {
      original_storage_path: originalPath,
      edit_recipe: uprightRecipe(row.edit_recipe, decision.turns, new Date().toISOString()),
      width: rotatedBytes.width,
      height: rotatedBytes.height,
    };
    if (calibration) {
      patch.measure_calibration = uprightCalibration(calibration, decision.turns, sw, sh);
    }

    const { error: rowErr } = await supabaseAdmin
      .from("item_photos")
      .update(patch as never)
      .eq("id", row.id)
      .eq("inventory_item_id", (owned as { id: string }).id);
    if (rowErr) {
      // The bytes are rotated and the row is not. Say so loudly: this is the
      // one state in this function where the pixels and the calibration
      // disagree, and it needs a human rather than a retry.
      console.error(
        `[measure-upright] photo ${row.id}: bytes rotated but the row update failed (${rowErr.message}) — ` +
          "calibration now describes the pre-rotation pixels",
      );
      out.skipped.push({ photoId: row.id, reason: `row_update_failed: ${rowErr.message}` });
      continue;
    }

    out.rotated.push({
      photoId: row.id,
      turns: decision.turns,
      message: uprightMessage(decision.turns),
    });
  }

  return out;
}

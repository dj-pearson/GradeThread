// US-3187 AC2/AC3/AC5: which item_photos rows point at a file that is gone.
//
// THE INVERSE OF diagnose-staged-orphans.ts, and the two must not be confused.
// That one asks which OBJECTS no row references. This asks which ROWS no object
// backs. The failure modes are opposite: a mistake there deletes a live photo,
// a mistake here deletes a row whose photo was only briefly unreadable.
//
// CONFIRMED IN PRODUCTION 2026-09-08 from a console 400. The row exists and
// yields a valid public URL; the object behind it does not.
//
// IT READS AND NOTHING ELSE. There is no --apply, no delete, no write path in
// this file. AC4 says the second mode comes only after a human has read this
// report, and that is a separate risk from producing it.
//
// A ROW IS ONLY DEAD WHEN A LISTING THAT FINISHED DID NOT CONTAIN IT. A 403, a
// timeout and a truncated page all look exactly like "not there". So every
// incomplete read is counted, and one is enough to refuse the whole
// classification and exit 2 -- an under-read presented as a list of dead rows
// is how a seller's photograph gets deleted.
//
//   deno run --allow-net --allow-env scripts/diagnose-missing-photo-objects.ts
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import {
  classifyMissingPhotoObjects,
  type DeadShape,
  type MissingKind,
  normalizePhotoPath,
  type PhotoRow,
} from "../src/lib/missing-photo-objects.ts";

const BUCKET = "item-photos";
const PAGE = 1000;
/** `{owner}/{item}/{file}` is the format; one more level than that is the cap. */
const MAX_DEPTH = 3;
/** Row pages. Kept below PostgREST's own ceiling so a page is never truncated. */
const ROW_PAGE = 1000;

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error(
    "[missing-photos] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. " +
      "This is a read; it deletes nothing.",
  );
  Deno.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

let incomplete = 0;
function report(what: string): void {
  incomplete++;
  console.error(`  ! ${what}`);
}

/** Every object path in the bucket, normalised. */
async function listObjects(prefix = "", depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) {
    report(`depth cap reached at ${BUCKET}/${prefix} - objects below it are UNCOUNTED`);
    return [];
  }
  const out: string[] = [];
  for (let page = 0;; page++) {
    const { data, error } = await db.storage.from(BUCKET).list(prefix, {
      limit: PAGE,
      offset: page * PAGE,
    });
    // list() RESOLVES with an error rather than throwing, so an unchecked call
    // here turns "we could not read it" into "it is not there".
    if (error) {
      report(`list failed at ${BUCKET}/${prefix}: ${error.message}`);
      return out;
    }
    const batch = data ?? [];
    for (const entry of batch) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A folder has no id in the storage listing; that is the only signal.
      if (!entry.id) {
        out.push(...await listObjects(path, depth + 1));
        continue;
      }
      out.push(normalizePhotoPath(path, BUCKET));
    }
    if (batch.length < PAGE) break;
  }
  return out;
}

/** Every item_photos row, with the owner resolved through its item. */
async function allRows(): Promise<PhotoRow[]> {
  const rows: PhotoRow[] = [];
  for (let from = 0;; from += ROW_PAGE) {
    const { data, error } = await db
      .from("item_photos")
      .select("id, inventory_item_id, storage_path, thumbnail_storage_path, created_at")
      .order("id", { ascending: true })
      .range(from, from + ROW_PAGE - 1);
    if (error) {
      report(`item_photos read failed at offset ${from}: ${error.message}`);
      return rows;
    }
    const batch = (data ?? []) as {
      id: string;
      inventory_item_id: string;
      storage_path: string | null;
      thumbnail_storage_path: string | null;
      created_at: string | null;
    }[];
    for (const r of batch) {
      rows.push({
        id: r.id,
        inventoryItemId: r.inventory_item_id,
        // Filled below from the items read, so one missing item cannot silently
        // make a row ownerless and change its shape.
        ownerUserId: null,
        storagePath: r.storage_path,
        thumbnailStoragePath: r.thumbnail_storage_path,
        createdAt: r.created_at,
      });
    }
    if (batch.length < ROW_PAGE) break;
  }
  return rows;
}

/** item id -> owner, for the shape rules that ask "is this all one seller". */
async function ownersByItem(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)];
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const { data, error } = await db
      .from("inventory_items")
      .select("id, user_id")
      .in("id", slice);
    if (error) {
      report(`inventory_items read failed for ${slice.length} id(s): ${error.message}`);
      continue;
    }
    for (const r of (data ?? []) as { id: string; user_id: string }[]) {
      out.set(r.id, r.user_id);
    }
  }
  return out;
}

const objects = await listObjects();
const rows = await allRows();
const owners = await ownersByItem(rows.map((r) => r.inventoryItemId));
for (const r of rows) r.ownerUserId = owners.get(r.inventoryItemId) ?? null;

const result = classifyMissingPhotoObjects({
  rows,
  presentPaths: new Set(objects),
  listingComplete: incomplete === 0,
  bucket: BUCKET,
});

console.log(`\n[missing-photos] ${rows.length} item_photos row(s), ${objects.length} object(s) in ${BUCKET}`);

if (result.refusal || result.dead === null) {
  console.error(
    `\n[missing-photos] REFUSED: ${result.refusal ?? "classification unavailable"}\n` +
      `  ${incomplete} read(s) did not finish. Fix those and run it again; a partial\n` +
      `  listing reported as dead rows is how a live photograph gets deleted.`,
  );
  Deno.exit(2);
}

const dead = result.dead;
console.log(`[missing-photos] ${dead.length} row(s) point at an object that is not there`);
console.log(`[missing-photos] ${result.withoutPath} row(s) record no storage path at all\n`);

if (dead.length === 0) {
  console.log("Nothing to do. Every row's file is present.");
  Deno.exit(0);
}

const KIND_LABEL: Record<MissingKind, string> = {
  both_gone: "nothing left (photo and thumbnail both absent, or the only path it had)",
  photo_gone_thumb_alive: "RECOVERABLE: full size gone, thumbnail present",
  thumb_gone_photo_alive: "RECOVERABLE: thumbnail gone, full size present",
  no_path_recorded: "no storage path on the row",
};

console.log("By what is missing");
for (const [kind, n] of Object.entries(result.countsByKind)) {
  if (n > 0) console.log(`  ${String(n).padStart(6)}  ${KIND_LABEL[kind as MissingKind]}`);
}

console.log("\nBy shape, which is the closest a join gets to a cause");
const shapes = new Map<DeadShape, string>();
for (const d of dead) shapes.set(d.shape, d.causeHint);
for (const [shape, n] of Object.entries(result.countsByShape)) {
  if (n > 0) console.log(`  ${String(n).padStart(6)}  ${shape} - ${shapes.get(shape as DeadShape)}`);
}

console.log(`\nOwners affected: ${result.owners.length}`);
if (result.span) console.log(`Rows created between ${result.span.oldest} and ${result.span.newest}`);

console.log("\nFirst 20 rows, for a spot check against the bucket");
for (const d of dead.slice(0, 20)) {
  console.log(`  ${d.row.id}  ${d.kind.padEnd(24)} ${d.row.storagePath ?? "(no path)"}`);
}
if (dead.length > 20) console.log(`  ... and ${dead.length - 20} more`);

console.log(
  "\nNOTHING WAS CHANGED. AC4: a delete or re-flag mode comes only after a\n" +
    "human has read this, and it must never touch a row whose object merely\n" +
    "403s or times out - that is availability, and the file is still there.",
);

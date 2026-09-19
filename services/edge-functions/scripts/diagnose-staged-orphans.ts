// US-3391 AC1, the half that needed a join: how many staged objects are
// ORPHANS, per bucket, by age, and how many belong to accounts already told
// their data was erased.
//
// WHY THIS EXISTS RATHER THAN THE SWEEP AC3 ASKS FOR. US-3391 measured 3,557
// objects and 2.21 GB under `{owner}/_staging/` in prod `item-photos` and said
// plainly that the figure is staged OBJECTS, not confirmed orphans:
// generation does not copy a photo out of `_staging/`, it points
// `item_photos.storage_path` straight back into it, so an adopted photo is a
// live listing image at a staging path and eBay is serving some of them right
// now. A sweep written against the 3,557 deletes listing photos. The orphan
// count needs a join, nobody had run it, and the sweep was correctly left
// unbuilt. This runs the join.
//
// IT READS AND NOTHING ELSE. There is no --apply, no delete, no write path in
// this file. The classification is src/lib/staged-orphans.ts and it is unit
// tested; what is here is the fetching and the printing.
//
// THE ORPHAN NUMBER IS DELIBERATELY UNDER-REPORTED WHEN IN DOUBT. Anything
// this cannot classify counts as referenced, because the only consumer of the
// number is a deletion and the safe error is to leave an object alone.
//
//   deno run --allow-net --allow-env scripts/diagnose-staged-orphans.ts
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Storage listing and the
// row reads both go through the service-role client, which is what the
// erasure path uses.

import { createClient } from "@supabase/supabase-js";
import {
  type BucketOrphanReport,
  classifyStagedObjects,
  normalizeStoragePath,
  STAGED_BUCKETS,
  STAGED_REFERENCE_SOURCES,
  type StagedObject,
  STAGING_SEGMENT,
} from "../src/lib/staged-orphans.ts";

const PAGE = 1000;
/** Matches the erasure walk's own bound, so the two see the same tree. */
const MAX_DEPTH = 3;

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error(
    "[staged-orphans] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. " +
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

/** Every object under one prefix, depth-bounded, reporting rather than truncating. */
async function walk(
  bucket: string,
  prefix: string,
  depth = 0,
): Promise<StagedObject[]> {
  if (depth > MAX_DEPTH) {
    report(`depth cap reached at ${bucket}/${prefix} - objects below it are UNCOUNTED`);
    return [];
  }
  const out: StagedObject[] = [];
  for (let page = 0;; page++) {
    const { data, error } = await db.storage.from(bucket).list(prefix, {
      limit: PAGE,
      offset: page * PAGE,
    });
    // list() RESOLVES with an error rather than throwing. An unreported error
    // here is an undercount presented as a count.
    if (error) {
      report(`list failed at ${bucket}/${prefix}: ${error.message}`);
      return out;
    }
    const batch = data ?? [];
    for (const entry of batch) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A folder has no id in the storage listing. That is the only signal
      // available and it is the one the erasure walk uses too.
      if (!entry.id) {
        out.push(...await walk(bucket, path, depth + 1));
        continue;
      }
      out.push({
        path,
        updatedAt: entry.updated_at ?? entry.created_at ?? null,
        bytes: typeof entry.metadata?.size === "number" ? entry.metadata.size : null,
      });
    }
    if (batch.length < PAGE) break;
  }
  return out;
}

/** The owner folders that have a staging tree in this bucket. */
async function ownersWithStaging(bucket: string): Promise<string[]> {
  const owners: string[] = [];
  for (let page = 0;; page++) {
    const { data, error } = await db.storage.from(bucket).list("", {
      limit: PAGE,
      offset: page * PAGE,
    });
    if (error) {
      report(`root list failed on ${bucket}: ${error.message}`);
      return owners;
    }
    const batch = data ?? [];
    for (const entry of batch) if (!entry.id) owners.push(entry.name);
    if (batch.length < PAGE) break;
  }
  return owners;
}

/** Every path any row points at, normalised, for the buckets we are counting. */
async function referencedPaths(): Promise<Map<string, Set<string>>> {
  const byBucket = new Map<string, Set<string>>();
  for (const bucket of STAGED_BUCKETS) byBucket.set(bucket, new Set());
  for (const src of STAGED_REFERENCE_SOURCES) {
    const target = byBucket.get(src.bucket);
    if (!target) continue;
    for (let from = 0;; from += PAGE) {
      const { data, error } = await db
        .from(src.table)
        .select(src.column)
        .not(src.column, "is", null)
        .range(from, from + PAGE - 1);
      if (error) {
        // A failed reference read makes live photos look orphaned, which is
        // the one error that must never be quiet.
        report(
          `REFERENCE READ FAILED on ${src.table}.${src.column}: ${error.message}. ` +
            `The orphan count below is NOT SAFE to act on.`,
        );
        break;
      }
      const rows = data ?? [];
      for (const row of rows) {
        const raw = (row as Record<string, unknown>)[src.column];
        if (typeof raw !== "string" || !raw) continue;
        target.add(normalizeStoragePath(raw, src.bucket));
      }
      if (rows.length < PAGE) break;
    }
  }
  return byBucket;
}

/**
 * The accounts already told their data was erased.
 *
 * The column is `deleted_user_id`, not `user_id`. Written as the latter first
 * and caught by running it against a local Postgres carrying every migration
 * -- which is the same 42703 shape as US-3162's `item_photos.item_id` and
 * US-2736's `inventory_items.list_price`. A column name read off neighbouring
 * code is not evidence that this table has it.
 */
async function deletedOwners(): Promise<Set<string>> {
  const out = new Set<string>();
  const { data, error } = await db
    .from("account_deletion_log")
    .select("deleted_user_id");
  if (error) {
    report(`deleted-account read failed: ${error.message}`);
    return out;
  }
  for (const row of data ?? []) {
    const id = (row as { deleted_user_id?: unknown }).deleted_user_id;
    if (typeof id === "string" && id) out.add(id);
  }
  return out;
}

function print(r: BucketOrphanReport): void {
  const gb = (n: number) => (n / 1_000_000_000).toFixed(3);
  console.log(`\n  ${r.bucket}`);
  console.log(`    staged objects        ${r.staged}  (${gb(r.stagedBytes)} GB)`);
  console.log(`    referenced by a row   ${r.referenced}`);
  console.log(`    ORPHANS               ${r.orphans}  (${gb(r.orphanBytes)} GB)`);
  console.log(`    owners with orphans   ${r.ownersWithOrphans}`);
  console.log(`    orphans for accounts already marked deleted   ${r.orphansForDeletedAccounts}`);
  console.log(`    orphans by age:`);
  for (const [label, n] of Object.entries(r.orphansByAge)) {
    if (n > 0) console.log(`      ${label.padEnd(14)} ${n}`);
  }
}

const references = await referencedPaths();
const deleted = await deletedOwners();
console.log("[staged-orphans] US-3391 AC1: staged objects nothing references\n");
console.log(`  reference columns read: ${
  STAGED_REFERENCE_SOURCES.map((s) => `${s.table}.${s.column}`).join(", ")
}`);
console.log(`  accounts marked deleted: ${deleted.size}`);

for (const bucket of STAGED_BUCKETS) {
  const objects: StagedObject[] = [];
  for (const owner of await ownersWithStaging(bucket)) {
    objects.push(...await walk(bucket, `${owner}/${STAGING_SEGMENT}`, 1));
  }
  print(classifyStagedObjects({
    bucket,
    objects,
    referenced: references.get(bucket) ?? new Set(),
    deletedOwners: deleted,
  }));
}

if (incomplete > 0) {
  console.error(
    `\n  ${incomplete} problem(s) above. The counts are a FLOOR, not a total, ` +
      `and must not be used to size a deletion until they are clean.`,
  );
  Deno.exit(2);
}
console.log(
  "\n  Clean read. An orphan here is an object no row points at; it is still " +
    "not a deletion until US-3391 AC3 is designed against these numbers.",
);

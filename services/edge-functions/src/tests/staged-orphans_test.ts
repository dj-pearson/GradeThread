// US-3391 AC1's join: which staged objects nothing references.
//
// EVERY CASE HERE IS ABOUT NOT DELETING A LIVE PHOTO. The story's headline
// number, 3,557 staged objects, is not an orphan count: generation leaves
// item_photos.storage_path pointing INTO _staging/, so an adopted photo is a
// live listing image at a staging path and eBay is serving some of them. A
// classifier that gets one of these wrong, in a sweep built on it, deletes a
// seller's listing photo.

import { assert, assertEquals } from "@std/assert";
import {
  AGE_BANDS,
  ageBandFor,
  classifyStagedObjects,
  isStagedPath,
  normalizeStoragePath,
  STAGED_BUCKETS,
  STAGED_REFERENCE_SOURCES,
  stagedOwner,
  UNKNOWN_AGE_LABEL,
} from "../lib/staged-orphans.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 19);

function obj(path: string, daysOld: number | null, bytes = 1000) {
  return {
    path,
    updatedAt: daysOld === null ? null : new Date(NOW - daysOld * DAY).toISOString(),
    bytes,
  };
}

Deno.test("an adopted photo is REFERENCED even though it sits in _staging", () => {
  // The whole reason age cannot be the gate.
  const report = classifyStagedObjects({
    bucket: "item-photos",
    objects: [obj(`${OWNER}/_staging/gphotos/live.jpg`, 120)],
    referenced: new Set([`${OWNER}/_staging/gphotos/live.jpg`]),
    nowMs: NOW,
  });
  assertEquals(report.staged, 1);
  assertEquals(report.referenced, 1);
  assertEquals(report.orphans, 0);
});

Deno.test("referenced wins over age, however old the object is", () => {
  const report = classifyStagedObjects({
    bucket: "item-photos",
    objects: [obj(`${OWNER}/_staging/a.jpg`, 3650)],
    referenced: new Set([`${OWNER}/_staging/a.jpg`]),
    nowMs: NOW,
  });
  assertEquals(report.orphans, 0);
});

Deno.test("an unreferenced staged object is an orphan and carries its bytes", () => {
  const report = classifyStagedObjects({
    bucket: "item-photos",
    objects: [obj(`${OWNER}/_staging/gphotos/dead.jpg`, 45, 2048)],
    referenced: new Set(),
    nowMs: NOW,
  });
  assertEquals(report.orphans, 1);
  assertEquals(report.orphanBytes, 2048);
  assertEquals(report.orphansByAge["30-90 days"], 1);
});

Deno.test("a path outside a staging tree is not counted at all", () => {
  // `{owner}/{submissionId}/front.jpg` is a final path. Counting it would put
  // every live photo in the orphan column.
  const report = classifyStagedObjects({
    bucket: "item-photos",
    objects: [
      obj(`${OWNER}/2222/front.jpg`, 200),
      obj(`${OWNER}/_staging/x.jpg`, 200),
    ],
    referenced: new Set(),
    nowMs: NOW,
  });
  assertEquals(report.staged, 1);
  assertEquals(report.orphans, 1);
});

Deno.test("a stored path that differs only cosmetically still counts as a reference", () => {
  // The failure that would turn a live photo into an orphan: a leading slash,
  // a bucket prefix somebody included, or a percent-encoded space.
  for (
    const stored of [
      `/${OWNER}/_staging/a b.jpg`,
      `item-photos/${OWNER}/_staging/a b.jpg`,
      `${OWNER}/_staging/a%20b.jpg`,
    ]
  ) {
    const report = classifyStagedObjects({
      bucket: "item-photos",
      objects: [obj(`${OWNER}/_staging/a b.jpg`, 90)],
      referenced: new Set([normalizeStoragePath(stored, "item-photos")]),
      nowMs: NOW,
    });
    assertEquals(report.orphans, 0, `"${stored}" did not match`);
  }
});

Deno.test("normalising cannot merge two different objects", () => {
  // Generosity in the comparison is only safe while it cannot make two
  // distinct paths equal. An encoded slash is refused for that reason.
  assert(
    normalizeStoragePath(`${OWNER}/_staging/a%2Fb.jpg`) !==
      normalizeStoragePath(`${OWNER}/_staging/a/b.jpg`),
  );
});

Deno.test("an object with no timestamp is unknown-age, never old", () => {
  // A sweep reads these bands. Defaulting an unknown to "over 90 days" would
  // make the oldest bucket the dumping ground for anything unparseable.
  assertEquals(ageBandFor(null, NOW), UNKNOWN_AGE_LABEL);
  assertEquals(ageBandFor("not a date", NOW), UNKNOWN_AGE_LABEL);
  const report = classifyStagedObjects({
    bucket: "item-photos",
    objects: [obj(`${OWNER}/_staging/a.jpg`, null)],
    referenced: new Set(),
    nowMs: NOW,
  });
  assertEquals(report.orphansByAge[UNKNOWN_AGE_LABEL], 1);
  assertEquals(report.orphansByAge["over 90 days"], 0);
});

Deno.test("a future timestamp lands in the youngest band, which nothing sweeps", () => {
  assertEquals(ageBandFor(new Date(NOW + 5 * DAY).toISOString(), NOW), AGE_BANDS[0].label);
});

Deno.test("the band edges are half-open, so nothing is counted twice", () => {
  assertEquals(ageBandFor(new Date(NOW - 1 * DAY - 1000).toISOString(), NOW), "1-7 days");
  assertEquals(ageBandFor(new Date(NOW - 7 * DAY - 1000).toISOString(), NOW), "7-30 days");
  assertEquals(ageBandFor(new Date(NOW - 30 * DAY - 1000).toISOString(), NOW), "30-90 days");
  assertEquals(ageBandFor(new Date(NOW - 90 * DAY - 1000).toISOString(), NOW), "over 90 days");
  const total = AGE_BANDS.length;
  assertEquals(total, 5);
});

Deno.test("orphans are attributed to their owner, and deleted accounts are singled out", () => {
  // The question the story says needs asking: how many images are still served
  // for accounts already told their data was erased.
  const report = classifyStagedObjects({
    bucket: "item-photos",
    objects: [
      obj(`${OWNER}/_staging/a.jpg`, 10),
      obj(`${OWNER}/_staging/b.jpg`, 10),
      obj(`${OTHER}/_staging/c.jpg`, 10),
    ],
    referenced: new Set(),
    deletedOwners: new Set([OTHER]),
    nowMs: NOW,
  });
  assertEquals(report.orphans, 3);
  assertEquals(report.ownersWithOrphans, 2);
  assertEquals(report.orphansForDeletedAccounts, 1);
});

Deno.test("the reference set names the thumbnail column the row-following purge omits", () => {
  // collectOwnedStorageObjects selects item_photos.storage_path alone. That is
  // not an erasure hole, because erasure also walks the whole folder -- but it
  // WOULD be an orphan-counting hole, and a sweep built on the wrong count
  // deletes a live thumbnail.
  const cols = STAGED_REFERENCE_SOURCES.map((s) => `${s.table}.${s.column}`);
  assert(cols.includes("item_photos.thumbnail_storage_path"), cols.join(", "));
  assert(cols.includes("item_photos.storage_path"));
  assert(cols.includes("phone_capture_photos.storage_path"));
  assert(cols.includes("flipdesk_expenses.receipt_path"));
});

Deno.test("every reference source names a bucket that actually has a staging tree", () => {
  for (const src of STAGED_REFERENCE_SOURCES) {
    assert(
      STAGED_BUCKETS.includes(src.bucket),
      `${src.table}.${src.column} points at ${src.bucket}, which has no staging tree`,
    );
  }
});

Deno.test("the staged buckets match the erasure path's own list", async () => {
  // Two lists of the same fact drift. This one fails when they do, rather than
  // leaving a bucket uncounted because somebody added it in one place.
  const purge = await Deno.readTextFile(
    new URL("../lib/account-storage-purge.ts", import.meta.url),
  );
  const block = purge.slice(
    purge.indexOf("export const STAGING_BUCKETS"),
    purge.indexOf("];", purge.indexOf("export const STAGING_BUCKETS")),
  );
  assert(block.length > 0, "STAGING_BUCKETS is gone from account-storage-purge.ts");
  for (const bucket of STAGED_BUCKETS) {
    assert(block.includes(`"${bucket}"`), `${bucket} is not in STAGING_BUCKETS`);
  }
  // And the other direction: a bucket added there and not here is uncounted.
  const theirs = [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assertEquals([...theirs].sort(), [...STAGED_BUCKETS].sort());
});

Deno.test("the owner segment is read, and a non-staged path yields none", () => {
  assertEquals(stagedOwner(`${OWNER}/_staging/x/y.jpg`), OWNER);
  assertEquals(stagedOwner(`${OWNER}/2222/front.jpg`), null);
  assertEquals(stagedOwner("_staging/x.jpg"), null);
  assertEquals(isStagedPath(`${OWNER}/_staging/x.jpg`), true);
  assertEquals(isStagedPath(`${OWNER}/_stagingx/x.jpg`), false);
});

// ── the columns the operator script reads actually exist ───────────
//
// A column name read off neighbouring code is not evidence that THIS table
// has it. `account_deletion_log.user_id` was written here first and the table
// calls it `deleted_user_id`; PostgREST answers 42703 and the script would
// have reported "deleted-account read failed" on every run. Same shape as
// US-3162's `item_photos.item_id` and US-2736's `inventory_items.list_price`,
// both of which reached production.

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

async function schemaText(): Promise<string> {
  let all = "";
  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (entry.isFile && entry.name.endsWith(".sql")) {
      all += await Deno.readTextFile(new URL(entry.name, MIGRATIONS));
    }
  }
  return all.toLowerCase();
}

Deno.test("every table and column the diagnostic reads exists in the migrations", async () => {
  const sql = await schemaText();
  assert(sql.length > 100_000, `the migration corpus did not load (${sql.length} chars)`);

  const script = await Deno.readTextFile(
    new URL("../../scripts/diagnose-staged-orphans.ts", import.meta.url),
  );
  // `.from("table").select("column")` as this script writes it, plus the
  // reference sources it reads through the shared constant.
  const pairs: [string, string][] = [
    ...STAGED_REFERENCE_SOURCES.map((s) => [s.table, s.column] as [string, string]),
  ];
  for (const m of script.matchAll(/\.from\("([a-z_]+)"\)[\s\S]{0,120}?\.select\(\s*"([a-z_]+)"/g)) {
    pairs.push([m[1], m[2]]);
  }
  assert(pairs.length >= 5, `expected to find the reads, saw ${pairs.length}`);

  for (const [table, column] of pairs) {
    assert(
      sql.includes(table.toLowerCase()),
      `no migration mentions the table ${table}`,
    );
    assert(
      sql.includes(column.toLowerCase()),
      `no migration mentions the column ${column} (read from ${table})`,
    );
  }
  // The specific one that was wrong, pinned by name so a rename has to come
  // through here.
  assert(script.includes('.select("deleted_user_id")'));
  assert(!/account_deletion_log[\s\S]{0,80}select\("user_id"\)/.test(script));
});

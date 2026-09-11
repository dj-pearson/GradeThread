// US-3391: a stranded STAGED object has no row, so erasure has to LIST for it.
//
// THE DEFECT, stated as the thing a test has to reproduce. The AutoLister, the
// phone-capture flow, the remote-photo importer and the expense receipt reader
// all write bytes to `{ownerId}/_staging/...` before any row exists. The row is
// written when the seller confirms. If they never confirm -- a closed tab is the
// common case, not the failure case -- the bytes stay and the only pointer they
// ever had was the page's React state.
//
// `collectOwnedStorageObjects` discovered `item-photos` objects through
// `item_photos.storage_path` ROWS. A staged object has no such row. So account
// deletion swept past it, and in `item-photos` -- THE ONE PUBLIC BUCKET -- it
// kept being served from a stable URL after we told the seller their data was
// erased.
//
// SO THE PROOF HAS TO SEED NO ROW. A fixture with an item_photos row proves the
// row-following path works, which was never in doubt and is exactly what made
// this invisible. Every erasure assertion below runs against a dataset whose
// item_photos and flipdesk_expenses tables are EMPTY.
//
// The second half of the file is about the listing being safe. This code deletes
// what it finds, on the service-role client, which bypasses RLS (CLAUDE.md
// US-268). A purge that can be pointed at another tenant's folder would be worse
// than the bug it fixes, so the scoping is proved before the behaviour is.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  collectOwnedStorageObjects,
  listStagedObjects,
  MAX_FOLDERS_PER_WALK,
  MAX_PAGES_PER_FOLDER,
  MAX_STAGING_DEPTH,
  type PurgeDb,
  type PurgeListFailure,
  STAGING_BUCKETS,
} from "../lib/account-storage-purge.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

// ── A storage fake that behaves like the real thing ──────────────────────────
//
// The two behaviours that matter and that a naive fake gets wrong:
//   * `list(prefix)` returns ONE level. A nested object shows up as a FOLDER
//     entry, which supabase-js marks with a literal `id: null`.
//   * it is paginated, by limit + offset, and a full page means "ask again".
// A fake that returns every path flat would make a non-recursive walk pass.

interface FakeBucket {
  objects: Set<string>;
  /** Every prefix `list()` was called with, in order. The tenancy evidence. */
  listed: string[];
  /** Prefixes to answer with an error instead of data. */
  failOn?: (prefix: string) => string | null;
}

function fakeStorage(buckets: Record<string, FakeBucket>) {
  return {
    from(bucket: string) {
      const b = buckets[bucket] ?? { objects: new Set<string>(), listed: [] };
      return {
        list(prefix: string, opts?: { limit?: number; offset?: number }) {
          b.listed.push(prefix);
          const failure = b.failOn?.(prefix) ?? null;
          if (failure) {
            return Promise.resolve({ data: null, error: { message: failure } });
          }
          const head = prefix === "" ? "" : `${prefix}/`;
          const children = new Map<string, boolean>(); // name -> isFolder
          for (const path of b.objects) {
            if (!path.startsWith(head)) continue;
            const rest = path.slice(head.length);
            if (rest.length === 0) continue;
            const cut = rest.indexOf("/");
            if (cut === -1) children.set(rest, false);
            else children.set(rest.slice(0, cut), true);
          }
          const all = [...children.entries()].sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0))
            .map(([name, isFolder]) => ({
              name,
              // supabase-js: a folder carries a literal null id, an object a uuid.
              id: isFolder ? null : `id-${name}`,
            }));
          const offset = opts?.offset ?? 0;
          const limit = opts?.limit ?? 100;
          return Promise.resolve({ data: all.slice(offset, offset + limit), error: null });
        },
      };
    },
  };
}

function fakeDb(
  dataset: Record<string, Record<string, unknown>[]>,
  buckets: Record<string, FakeBucket>,
): PurgeDb {
  return {
    from(table: string) {
      const rows = dataset[table] ?? [];
      return {
        select(columns: string) {
          const wanted = columns.split(",").map((c) => c.trim());
          const project = (r: Record<string, unknown>) =>
            wanted.includes("*")
              ? r
              : Object.fromEntries(wanted.filter((c) => c in r).map((c) => [c, r[c]]));
          return {
            eq: (col: string, val: string) =>
              Promise.resolve({ data: rows.filter((r) => r[col] === val).map(project) }),
            in: (col: string, vals: string[]) =>
              Promise.resolve({
                data: rows.filter((r) => vals.includes(r[col] as string)).map(project),
              }),
          };
        },
      };
    },
    storage: fakeStorage(buckets),
  } as unknown as PurgeDb;
}

function bucket(paths: string[], failOn?: (prefix: string) => string | null): FakeBucket {
  return { objects: new Set(paths), listed: [], failOn };
}

/** An account that owns ONE item and ONE submission, and NO photo rows at all. */
function rowsWithNoPhotoRows(): Record<string, Record<string, unknown>[]> {
  return {
    submissions: [{ id: "s1", user_id: USER }],
    inventory_items: [{ id: "i1", user_id: USER }],
    submission_images: [],
    item_photos: [], // <- the point of the fixture
    disputes: [],
    purchase_arrival_captures: [],
    data_requests: [],
    flipdesk_expenses: [], // <- and again, for the receipt staging area
  };
}

const STRANDED = `${USER}/_staging/sess-a/abandoned.jpg`;
const STRANDED_THUMB = `${USER}/_staging/sess-a/abandoned_thumb.jpg`;
const STRANDED_PHONE = `${USER}/_staging/phone/from-the-phone.jpg`;
const STRANDED_RECEIPT = `${USER}/_staging/receipt_1757000000000.jpg`;
const FOREIGN_STAGED = `${OTHER}/_staging/sess-b/not-ours.jpg`;

// ── AC4: the erasure path removes an object with NO row ──────────────────────

Deno.test("US-3391: a staged object with NO item_photos row is collected for deletion", async () => {
  const photos = bucket([STRANDED, STRANDED_THUMB, STRANDED_PHONE, FOREIGN_STAGED]);
  const owned = await collectOwnedStorageObjects(
    fakeDb(rowsWithNoPhotoRows(), { "item-photos": photos }),
    USER,
    { onListFailure: () => {} },
  );
  assertEquals(owned["item-photos"]!.sort(), [STRANDED, STRANDED_THUMB, STRANDED_PHONE].sort());
});

Deno.test("US-3391: the stranded receipt has no flipdesk_expenses row either", async () => {
  // Private bucket, so not a public URL -- but a receipt carries a card tail and
  // a billing address, and it survived erasure for the same reason.
  const receipts = bucket([STRANDED_RECEIPT]);
  const owned = await collectOwnedStorageObjects(
    fakeDb(rowsWithNoPhotoRows(), { "expense-receipts": receipts }),
    USER,
    { onListFailure: () => {} },
  );
  assertEquals(owned["expense-receipts"], [STRANDED_RECEIPT]);
});

Deno.test("US-3391: running the routes' sweep loop actually removes the row-less object", async () => {
  // Not "it appears in a list" -- the bytes go. This replays what account.ts and
  // admin-compliance.ts do with the collector's output, verbatim:
  //   for (const [bucket, objectPaths] of Object.entries(owned)) removeAll(...)
  const photos = bucket([STRANDED, STRANDED_PHONE, FOREIGN_STAGED]);
  const db = fakeDb(rowsWithNoPhotoRows(), { "item-photos": photos });

  const owned = await collectOwnedStorageObjects(db, USER, { onListFailure: () => {} });
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  for (const [bucketName, objectPaths] of Object.entries(owned)) {
    if (objectPaths.length === 0) continue;
    removed.push({ bucket: bucketName, paths: objectPaths });
    if (bucketName === "item-photos") for (const p of objectPaths) photos.objects.delete(p);
  }

  assert(!photos.objects.has(STRANDED), "the stranded staged photo survived the sweep");
  assert(!photos.objects.has(STRANDED_PHONE), "the stranded phone capture survived the sweep");
  assert(photos.objects.has(FOREIGN_STAGED), "the sweep deleted another tenant's object");
  assertEquals(removed.map((r) => r.bucket), ["item-photos"]);
});

Deno.test("US-3391: following rows alone would have missed it, which is the whole defect", async () => {
  // The counter-test. With the staging listing removed from the picture -- i.e.
  // an empty bucket -- the same dataset yields nothing, so the object the test
  // above deletes can ONLY have come from the folder walk. If this ever starts
  // returning the staged path, the fixture has grown a row and the proof above
  // has quietly stopped proving anything.
  const owned = await collectOwnedStorageObjects(
    fakeDb(rowsWithNoPhotoRows(), { "item-photos": bucket([]) }),
    USER,
    { onListFailure: () => {} },
  );
  assertEquals(owned["item-photos"], []);
});

Deno.test("US-3391: a staged path is unioned into its bucket, not given a key of its own", async () => {
  // Both callers iterate Object.entries(owned) and pass the KEY to
  // storage.from(bucket). A key like "item-photos-staging" would address a
  // bucket that does not exist and delete nothing, silently.
  const owned = await collectOwnedStorageObjects(
    fakeDb(rowsWithNoPhotoRows(), { "item-photos": bucket([STRANDED]) }),
    USER,
    { onListFailure: () => {} },
  );
  assertEquals(
    Object.keys(owned).sort(),
    [
      "avatars",
      "compliance-exports",
      "expense-receipts",
      "item-photos",
      "submission-images",
    ],
  );
});

Deno.test("US-3391: a staged object coexists with real photo rows, both are collected", async () => {
  const rows = rowsWithNoPhotoRows();
  rows.item_photos = [{ inventory_item_id: "i1", storage_path: `${USER}/i1/front.jpg` }];
  const owned = await collectOwnedStorageObjects(
    fakeDb(rows, { "item-photos": bucket([STRANDED]) }),
    USER,
    { onListFailure: () => {} },
  );
  assertEquals(owned["item-photos"]!.sort(), [`${USER}/i1/front.jpg`, STRANDED].sort());
});

// ── Tenancy: prove the scoping before anything else ──────────────────────────

Deno.test("US-3391/US-268: the walk only ever lists prefixes under the target user's folder", async () => {
  const photos = bucket([STRANDED, STRANDED_PHONE, FOREIGN_STAGED]);
  await collectOwnedStorageObjects(
    fakeDb(rowsWithNoPhotoRows(), { "item-photos": photos }),
    USER,
    { onListFailure: () => {} },
  );
  assert(photos.listed.length > 0, "nothing was listed at all");
  for (const prefix of photos.listed) {
    assert(
      prefix === `${USER}/${"_staging"}` || prefix.startsWith(`${USER}/_staging/`),
      `listed a prefix outside the user's staging folder: ${prefix}`,
    );
  }
  // Never the bucket root. That is the one prefix that reaches every tenant.
  assert(!photos.listed.includes(""), "the walk listed the bucket root");
});

Deno.test("US-3391/US-268: another tenant's staged object is never returned", async () => {
  const photos = bucket([FOREIGN_STAGED, `${OTHER}/_staging/x.jpg`, STRANDED]);
  const paths = await listStagedObjects(
    fakeDb({}, { "item-photos": photos }),
    "item-photos",
    USER,
    () => {},
  );
  assertEquals(paths, [STRANDED]);
  for (const p of paths) assert(p.startsWith(`${USER}/`), `leaked ${p}`);
});

Deno.test("US-3391/US-268: a user id that is not a safe path segment lists NOTHING and reports", async () => {
  // The failure mode has to be "delete nothing". An empty id would make the
  // prefix "/_staging"; a traversing one could climb. Neither may become a
  // listing, and neither may pass quietly.
  const hostile = ["", "..", "../..", "a/b", "  ", `${USER}/_staging`, "x".repeat(65)];
  for (const id of hostile) {
    const photos = bucket([STRANDED, FOREIGN_STAGED]);
    const failures: PurgeListFailure[] = [];
    const paths = await listStagedObjects(
      fakeDb({}, { "item-photos": photos }),
      "item-photos",
      id,
      (f) => failures.push(f),
    );
    assertEquals(paths, [], `id ${JSON.stringify(id)} produced paths`);
    assertEquals(photos.listed, [], `id ${JSON.stringify(id)} still issued a list call`);
    assertEquals(failures.length, 1, `id ${JSON.stringify(id)} was refused silently`);
  }
});

// ── Errors: list() resolves with { error }, it does not throw ────────────────

Deno.test("US-3391: a list error is REPORTED, never swallowed", async () => {
  // The defect class this whole area keeps hitting. A swallowed error here means
  // we told a person their data was erased and it was not.
  const photos = bucket([STRANDED], () => "bucket unavailable");
  const failures: PurgeListFailure[] = [];
  const paths = await listStagedObjects(
    fakeDb({}, { "item-photos": photos }),
    "item-photos",
    USER,
    (f) => failures.push(f),
  );
  assertEquals(paths, []);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]!.bucket, "item-photos");
  assert(/bucket unavailable/.test(failures[0]!.reason), failures[0]!.reason);
});

Deno.test("US-3391: a failure deep in the walk does not discard what was already found", async () => {
  // Partial is better than nothing AND is reported. The sibling folder that
  // listed cleanly still gets swept.
  const good = `${USER}/_staging/ok/a.jpg`;
  const photos = bucket(
    [good, `${USER}/_staging/bad/b.jpg`],
    (p) => p.endsWith("/bad") ? "listing blew up" : null,
  );
  const failures: PurgeListFailure[] = [];
  const paths = await listStagedObjects(
    fakeDb({}, { "item-photos": photos }),
    "item-photos",
    USER,
    (f) => failures.push(f),
  );
  assertEquals(paths, [good]);
  assertEquals(failures.length, 1);
});

Deno.test("US-3391: the default sink writes INCOMPLETE ERASURE, in those words", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await listStagedObjects(
      fakeDb({}, { "item-photos": bucket([], () => "nope") }),
      "item-photos",
      USER,
    );
  } finally {
    console.error = original;
  }
  assertEquals(lines.length, 1);
  assert(/INCOMPLETE ERASURE/.test(lines[0]!), lines[0]);
});

// ── Bounds: a paginated list must not become an unbounded loop ───────────────

Deno.test("US-3391: more than one page of staged objects is fully collected", async () => {
  // 1000 is the page size. A single-page listing would silently lose 501 of
  // these, which reads exactly like a folder that had 1000 objects in it.
  const many = Array.from(
    { length: 1501 },
    (_, i) => `${USER}/_staging/sess/${String(i).padStart(5, "0")}.jpg`,
  );
  const photos = bucket(many);
  const paths = await listStagedObjects(
    fakeDb({}, { "item-photos": photos }),
    "item-photos",
    USER,
    () => {},
  );
  assertEquals(paths.length, 1501);
  // Root + the session folder, each paged: 1 + 2 calls.
  assertEquals(photos.listed.length, 3);
});

Deno.test("US-3391: the page loop is capped and says so rather than spinning", async () => {
  // A storage layer that answers every offset with a FULL page -- a bug, or a
  // hostile response -- must terminate the loop, not own the request forever.
  const photos: FakeBucket = { objects: new Set(), listed: [] };
  const db = {
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [] }), in: () => Promise.resolve({ data: [] }) }) }),
    storage: {
      from: () => ({
        list: (prefix: string) => {
          photos.listed.push(prefix);
          return Promise.resolve({
            data: Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}.jpg`, id: `id${i}` })),
            error: null,
          });
        },
      }),
    },
  } as unknown as PurgeDb;
  const failures: PurgeListFailure[] = [];
  const paths = await listStagedObjects(db, "item-photos", USER, (f) => failures.push(f));
  assertEquals(photos.listed.length, MAX_PAGES_PER_FOLDER);
  assertEquals(paths.length, MAX_PAGES_PER_FOLDER * 1000);
  assertEquals(failures.length, 1);
  assert(/were not enumerated/.test(failures[0]!.reason), failures[0]!.reason);
});

Deno.test("US-3391: the folder walk is capped and says so", async () => {
  const sessions = Array.from(
    { length: MAX_FOLDERS_PER_WALK + 20 },
    (_, i) => `${USER}/_staging/s${String(i).padStart(4, "0")}/p.jpg`,
  );
  const photos = bucket(sessions);
  const failures: PurgeListFailure[] = [];
  const paths = await listStagedObjects(
    fakeDb({}, { "item-photos": photos }),
    "item-photos",
    USER,
    (f) => failures.push(f),
  );
  assertEquals(photos.listed.length, MAX_FOLDERS_PER_WALK);
  assertEquals(paths.length, MAX_FOLDERS_PER_WALK - 1); // the root is one of them
  assertEquals(failures.length, 1);
  assert(/folders/.test(failures[0]!.reason), failures[0]!.reason);
});

Deno.test("US-3391: the walk stops at the declared depth and reports what it skipped", async () => {
  const tooDeep = `${USER}/_staging/${"a/".repeat(MAX_STAGING_DEPTH + 1)}deep.jpg`;
  const photos = bucket([STRANDED, tooDeep]);
  const failures: PurgeListFailure[] = [];
  const paths = await listStagedObjects(
    fakeDb({}, { "item-photos": photos }),
    "item-photos",
    USER,
    (f) => failures.push(f),
  );
  assert(paths.includes(STRANDED));
  assert(!paths.includes(tooDeep), "a path below the depth cap was returned anyway");
  assert(failures.some((f) => /deeper than/.test(f.reason)), "the skipped subtree was silent");
});

Deno.test("US-3391: an account with no staging folder costs one list call and returns nothing", async () => {
  const photos = bucket([`${USER}/i1/front.jpg`]);
  const paths = await listStagedObjects(
    fakeDb({}, { "item-photos": photos }),
    "item-photos",
    USER,
    () => {},
  );
  assertEquals(paths, []);
  assertEquals(photos.listed, [`${USER}/_staging`]);
});

// ── Ratchet: a new staging writer in a new bucket must not go unswept ────────

Deno.test("US-3391: every bucket with a _staging writer is in STAGING_BUCKETS", () => {
  // This is the shape that produced the bug: a feature author writes bytes into
  // a bucket and has no reason to open an erasure routine. Derived from the
  // source, not hand-listed, so a new staging area fails here instead of being
  // found by a privacy report.
  const KNOWN_BUCKETS = [
    "submission-images",
    "item-photos",
    "content-images",
    "content-videos",
    "avatars",
    "compliance-exports",
    "cert-assets",
    "authenticity-references",
    "expense-receipts",
  ];
  const roots = ["../routes/", "../lib/"];
  let scanned = 0;
  for (const root of roots) {
    const dir = new URL(root, import.meta.url);
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      // The collector itself names every bucket by design.
      if (entry.name === "account-storage-purge.ts") continue;
      const src = Deno.readTextFileSync(new URL(entry.name, dir));
      if (!src.includes("/_staging/")) continue;
      scanned++;
      for (const b of KNOWN_BUCKETS) {
        if (!src.includes(`"${b}"`)) continue;
        assert(
          STAGING_BUCKETS.includes(b),
          `${entry.name} builds a _staging path and names the "${b}" bucket, but ` +
            `"${b}" is not in STAGING_BUCKETS -- account deletion will not list it`,
        );
      }
    }
  }
  assert(scanned >= 3, `only ${scanned} staging writers found; the scan has stopped working`);
});

Deno.test("US-3391: STAGING_BUCKETS is not empty and every entry is swept by the collector", async () => {
  assert(STAGING_BUCKETS.length >= 2, "STAGING_BUCKETS shrank");
  const buckets: Record<string, FakeBucket> = {};
  const expected: Record<string, string> = {};
  for (const b of STAGING_BUCKETS) {
    const path = `${USER}/_staging/probe/${b}.bin`;
    buckets[b] = bucket([path]);
    expected[b] = path;
  }
  const owned = await collectOwnedStorageObjects(
    fakeDb(rowsWithNoPhotoRows(), buckets),
    USER,
    { onListFailure: () => {} },
  );
  for (const b of STAGING_BUCKETS) {
    assert(
      (owned[b] ?? []).includes(expected[b]!),
      `${b} is declared as a staging bucket but the collector did not return its staged object`,
    );
  }
});

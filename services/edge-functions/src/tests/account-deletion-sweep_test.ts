// Account erasure must remove the BYTES, not just the rows.
//
// HISTORY, because it is the argument for how this file is now written. Five
// separate leaks were found here, each the same shape — a new feature writing
// into a storage bucket, by an author with no reason to open a deletion routine:
//
//   US-1637  the EXIF/GPS-INTACT originals, and dispute evidence
//   US-2645  purchase_arrival_captures, a buyer's photos of an arrival
//   US-2646  the compliance export archive: a whole account in one file
//   US-2647  avatars (a PUBLIC bucket) and expense receipts (card tail,
//            billing address, sometimes a full name)
//   US-2649  ALL of the above missing from the ADMIN erasure path, which also
//            still omitted original_storage_path — the very column US-1637 was
//            written to add
//
// US-2649 removed the cause rather than patching the sixth instance: there were
// TWO hand-written lists, one per erasure path, and the formal path was the
// weaker. lib/account-storage-purge.ts is now the only list, so these tests
// assert against IT, and a route is checked only for whether it calls it.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  collectOwnedStorageObjects,
  type PurgeDb,
} from "../lib/account-storage-purge.ts";

const PURGE_SRC = Deno.readTextFileSync(
  new URL("../lib/account-storage-purge.ts", import.meta.url),
);

/** A tiny supabase stand-in: tables of rows, filtered by eq/in. */
function fakeDb(
  dataset: Record<string, Record<string, unknown>[]>,
  folders: Record<string, string[]> = {},
): PurgeDb {
  return {
    from(table: string) {
      const rows = dataset[table] ?? [];
      return {
        // PROJECTS to the requested columns, which is load-bearing rather than
        // fussiness. A fake that returns whole rows regardless cannot catch a
        // select that stops ASKING for a column — and that is precisely the
        // US-1637 defect (only storage_path, never original_storage_path).
        // Verified: with projection off, deleting original_storage_path from
        // the select left this suite green.
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
    storage: {
      from(bucket: string) {
        return {
          list: () =>
            Promise.resolve({
              data: (folders[bucket] ?? []).map((name) => ({ name })),
              error: null,
            }),
        };
      },
    },
  };
}

const USER = "u1";

function dataset(): Record<string, Record<string, unknown>[]> {
  return {
    submissions: [{ id: "s1", user_id: USER }, { id: "s-other", user_id: "u2" }],
    inventory_items: [{ id: "i1", user_id: USER }],
    submission_images: [
      {
        submission_id: "s1",
        storage_path: "u1/s1/front.jpg",
        original_storage_path: "u1/s1/front.orig.jpg",
      },
      { submission_id: "s-other", storage_path: "u2/s9/front.jpg", original_storage_path: null },
    ],
    item_photos: [{ inventory_item_id: "i1", storage_path: "u1/i1/photo.jpg" }],
    disputes: [{ user_id: USER, evidence_paths: ["u1/d1/evidence.jpg", ""] }],
    purchase_arrival_captures: [{ user_id: USER, storage_path: "u1/p9/arrival_front.jpg" }],
    data_requests: [
      { user_id: USER, file_path: "u1/export-2026.json" },
      { user_id: USER, file_path: null },
    ],
    flipdesk_expenses: [{ user_id: USER, receipt_path: "u1/e1/receipt.pdf" }],
  };
}

Deno.test("every owned object is collected, grouped by its bucket", async () => {
  const owned = await collectOwnedStorageObjects(
    fakeDb(dataset(), { avatars: ["avatar_1.jpg", "avatar_2.jpg"] }),
    USER,
  );
  assertEquals(owned["submission-images"]!.sort(), [
    "u1/d1/evidence.jpg",
    "u1/p9/arrival_front.jpg",
    "u1/s1/front.jpg",
    "u1/s1/front.orig.jpg",
  ]);
  assertEquals(owned["item-photos"], ["u1/i1/photo.jpg"]);
  assertEquals(owned["compliance-exports"], ["u1/export-2026.json"]);
  assertEquals(owned["expense-receipts"], ["u1/e1/receipt.pdf"]);
  assertEquals(owned.avatars!.sort(), ["u1/avatar_1.jpg", "u1/avatar_2.jpg"]);
});

Deno.test("US-1637: the EXIF-intact original is collected, not just the served copy", async () => {
  // Selecting only storage_path left GPS-bearing PII in the bucket after a
  // "completed" deletion. The admin path was still doing exactly that until
  // US-2649.
  const owned = await collectOwnedStorageObjects(fakeDb(dataset()), USER);
  assert(owned["submission-images"]!.includes("u1/s1/front.orig.jpg"));
});

Deno.test("no other tenant's object is ever collected", async () => {
  const owned = await collectOwnedStorageObjects(fakeDb(dataset()), USER);
  for (const paths of Object.values(owned)) {
    for (const p of paths) assert(!p.startsWith("u2/"), `leaked ${p}`);
  }
});

Deno.test("empty and null paths are dropped, not stringified", async () => {
  // A null removed as the literal "null" would 404 harmlessly and report
  // success — a sweep that looks like it worked.
  const owned = await collectOwnedStorageObjects(fakeDb(dataset()), USER);
  for (const paths of Object.values(owned)) {
    for (const p of paths) assert(p && p !== "null" && p !== "undefined", `bad path ${p}`);
  }
  assertEquals(owned["compliance-exports"]!.length, 1, "the null file_path was kept");
});

Deno.test("an account with nothing yields empty lists, not undefined", async () => {
  const owned = await collectOwnedStorageObjects(fakeDb({}), "nobody");
  for (const [bucket, paths] of Object.entries(owned)) {
    assertEquals(paths, [], `${bucket} should be empty`);
  }
});

Deno.test("US-2647: avatars are listed by folder, never read from a column", async () => {
  // settings.tsx uploads to a TIMESTAMPED path, so users.avatar_url names only
  // the CURRENT object. Reading it would erase the latest avatar and leave every
  // superseded one behind — worse than doing nothing, because it looks handled.
  assert(
    /avatars: await listUserFolder\(db, "avatars", userId\)/.test(PURGE_SRC),
    "the avatar source must be a folder listing",
  );
  // Anchored on the SELECT, not on the bare column name: the module's own
  // comment explains why avatar_url must not be used, and a plain
  // `!/avatar_url/` matched that explanation and failed. Third time today a
  // negative assertion has caught its own reasoning instead of the defect.
  assert(
    !/\.select\([^)]*avatar_url/.test(PURGE_SRC),
    "the collector is reading avatar_url, which names only the current object",
  );
  const owned = await collectOwnedStorageObjects(
    fakeDb(dataset(), { avatars: ["avatar_old.jpg", "avatar_new.jpg"] }),
    USER,
  );
  assertEquals(owned.avatars!.length, 2, "a superseded avatar must be collected too");
});

// ── US-2649: both erasure paths use this one list ─────────────────────────────
//
// The two routes had drifted: self-serve swept five buckets from seven sources,
// the admin ANONYMIZE branch swept two from two. The formal path — the one a
// written erasure request goes through — was the weaker of the pair. Neither
// route may rebuild its own list.

Deno.test("US-2649: both erasure paths call the shared collector", () => {
  for (const route of ["../routes/account.ts", "../routes/admin-compliance.ts"]) {
    const src = Deno.readTextFileSync(new URL(route, import.meta.url));
    assert(
      /collectOwnedStorageObjects\(/.test(src),
      `${route} does not use the shared storage collector`,
    );
    assert(
      /for \(const \[bucket, objectPaths\] of Object\.entries\(owned\)\)/.test(src),
      `${route} calls the collector but does not sweep every bucket it returns`,
    );
  }
});

Deno.test("US-2649: neither route rebuilds a storage list of its own", () => {
  // The failure mode was two lists, so the guard is that there is only one. A
  // route selecting a storage-path column directly is how the second list comes
  // back.
  for (const route of ["../routes/account.ts", "../routes/admin-compliance.ts"]) {
    const src = Deno.readTextFileSync(new URL(route, import.meta.url));
    assert(
      !/\.select\("storage_path[^"]*"\)/.test(src),
      `${route} selects storage paths itself instead of using the collector`,
    );
    assert(
      !/\.select\("receipt_path"\)|\.select\("evidence_paths"\)/.test(src),
      `${route} is rebuilding part of the storage list`,
    );
  }
});

Deno.test("US-2647: the bucket list is DERIVED from the migrations, not hand-written", () => {
  // My first version of this named three buckets by reading what the code
  // already swept — the same mistake the code made. It passed while `avatars`
  // leaked, and the derived form found `expense-receipts` on its first run.
  const migrations = new URL("../../../../supabase/migrations/", import.meta.url);
  const buckets = new Set<string>();
  for (const entry of Deno.readDirSync(migrations)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = Deno.readTextFileSync(new URL(entry.name, migrations));
    for (const m of sql.matchAll(/INSERT INTO storage\.buckets[\s\S]{0,300}?'([a-z0-9-]{4,})'/g)) {
      buckets.add(m[1]!);
    }
  }
  assert(buckets.size >= 6, `only ${buckets.size} buckets parsed from the migrations`);

  const OPERATOR_BUCKETS: Record<string, string> = {
    "content-images":
      "Blog and marketing imagery, written by the content module. No user_id in the path and no user-owned objects.",
    "content-videos":
      "Generated social/marketing video, same ownership as content-images.",
    "authenticity-references":
      "The operator's brand-tell reference library (00500). Curated by admins, not uploaded by accounts.",
    "cert-assets":
      "Rendered certificate imagery keyed to a grade_report, which is deliberately RETAINED after erasure as the non-PII product. Deleting these would break public certificates that must stay verifiable.",
  };

  const unswept = [...buckets].filter(
    (b) => !(b in OPERATOR_BUCKETS) && !PURGE_SRC.includes(`"${b}"`),
  );
  assertEquals(
    unswept.sort(),
    [],
    "these buckets exist and the collector never returns them. Either collect " +
      "the bucket, or add it to OPERATOR_BUCKETS with the reason it holds no " +
      "user-owned objects.",
  );

  for (const [bucket, why] of Object.entries(OPERATOR_BUCKETS)) {
    assert(buckets.has(bucket), `${bucket} is exempted but no migration creates it`);
    assert(why.length > 50, `${bucket} needs a real reason, not a label`);
  }
});

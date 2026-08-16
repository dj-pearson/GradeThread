// US-903 AC6: "export of user A contains zero rows belonging to user B."
//
// assembleUserExport() takes an injectable db so we can feed it a dataset that
// mixes two tenants and prove the assembled archive for user A never includes a
// single row (or storage object) belonging to user B. This is the unit-level
// guarantee behind the CLAUDE.md US-268 explicit-scoping rule for the export.
import { assert, assertEquals } from "@std/assert";
import {
  assembleUserExport,
  type ExportDb,
  type ExportFrom,
  type ExportSelect,
} from "../lib/data-export.ts";

type Row = Record<string, unknown>;

// A tiny in-memory supabase stand-in: from(table).select(cols).eq/.in(col, val)
// filters the table's rows by that predicate (exactly what PostgREST would do
// server-side under the service-role query).
function fakeDb(dataset: Record<string, Row[]>): ExportDb {
  return {
    from(table: string): ExportFrom {
      const rows = dataset[table] ?? [];
      return {
        select(_cols: string): ExportSelect {
          return {
            eq(column: string, value: string) {
              return Promise.resolve({
                data: rows.filter((r) => r[column] === value),
              });
            },
            in(column: string, values: string[]) {
              return Promise.resolve({
                data: rows.filter((r) => values.includes(r[column] as string)),
              });
            },
          };
        },
      };
    },
  };
}

const DATASET: Record<string, Row[]> = {
  users: [
    { id: "A", email: "a@example.com" },
    { id: "B", email: "b@example.com" },
  ],
  submissions: [
    { id: "sA", user_id: "A" },
    { id: "sB", user_id: "B" },
  ],
  inventory_items: [
    { id: "iA", user_id: "A" },
    { id: "iB", user_id: "B" },
  ],
  sources: [
    { id: "srcA", user_id: "A" },
    { id: "srcB", user_id: "B" },
  ],
  listings: [
    { id: "lA", user_id: "A" },
    { id: "lB", user_id: "B" },
  ],
  sales: [
    { id: "saleA", user_id: "A" },
    { id: "saleB", user_id: "B" },
  ],
  grade_reports: [
    { id: "gA", submission_id: "sA" },
    { id: "gB", submission_id: "sB" },
  ],
  submission_images: [
    { submission_id: "sA", storage_path: "A/sub/front.jpg" },
    { submission_id: "sB", storage_path: "B/sub/front.jpg" },
  ],
  item_photos: [
    { inventory_item_id: "iA", storage_path: "A/item/front.jpg" },
    { inventory_item_id: "iB", storage_path: "B/item/front.jpg" },
  ],
};

Deno.test("export of user A contains zero rows belonging to user B", async () => {
  const archive = await assembleUserExport(fakeDb(DATASET), "A", "2026-01-01T00:00:00Z");

  assertEquals(archive.user_id, "A");
  assertEquals(archive.profile?.id, "A");

  // Every tenant-keyed collection holds only A's rows.
  assertEquals(archive.submissions.map((r) => r.id), ["sA"]);
  assertEquals(archive.inventory_items.map((r) => r.id), ["iA"]);
  assertEquals(archive.sources.map((r) => r.id), ["srcA"]);
  assertEquals(archive.listings.map((r) => r.id), ["lA"]);
  assertEquals(archive.sales.map((r) => r.id), ["saleA"]);
  // Parent-scoped: only the grade report for A's submission.
  assertEquals(archive.grade_reports.map((r) => r.id), ["gA"]);
  // Storage manifest only references A's objects.
  assertEquals(
    archive.storage_objects.map((o) => o.path).sort(),
    ["A/item/front.jpg", "A/sub/front.jpg"],
  );

  // Belt-and-suspenders: no B-owned identifier appears anywhere in the archive.
  const serialized = JSON.stringify(archive);
  for (const leaked of ["sB", "iB", "srcB", "lB", "saleB", "gB", "b@example.com", "B/"]) {
    assert(
      !serialized.includes(leaked),
      `export archive for A leaked B's data: found "${leaked}"`,
    );
  }
});

// ── US-2648: the two export paths must answer with the same set ───────────────
//
// There are two. GET /api/account/export streams the self-serve download;
// assembleUserExport() builds the archive the admin compliance queue hands to a
// subject. They are the same obligation answered twice, and they had drifted:
// the self-serve route iterates BUYER_PII_TABLES and this module did not, so the
// FORMAL path returned less than the self-serve one — no body measurements, no
// closet, no saved searches, no watchlist, no reward ledger, no guarantee
// claims.
//
// US-1846 built the register so that could not happen, and said so: the export
// route iterates it rather than a document beside the code. Only one of the two
// routes ever did. This is the check that would have caught it, comparing the
// SETS rather than trusting either list.

import { BUYER_PII_TABLES } from "../lib/buyer-pii.ts";
import { SELLER_EXPORT_TABLES } from "../lib/data-export.ts";

/** Tables the self-serve streaming route reaches, read from its source. */
function selfServeTables(): Set<string> {
  const src = Deno.readTextFileSync(new URL("../routes/account.ts", import.meta.url));
  const start = src.indexOf('accountRoutes.get("/export"');
  assert(start > -1, "the self-serve export route was renamed");
  const block = src.slice(start, src.indexOf("accountRoutes.", start + 40));
  const out = new Set<string>();
  for (const m of block.matchAll(/\.from\("([a-z0-9_]+)"\)/g)) out.add(m[1]!);
  for (const m of block.matchAll(/pageOf\("([a-z0-9_]+)"/g)) out.add(m[1]!);
  // Reached through the register rather than named inline.
  if (/BUYER_PII_TABLES/.test(block)) for (const t of BUYER_PII_TABLES) out.add(t.table);
  return out;
}

Deno.test("US-2648: the admin archive covers every registered table", () => {
  const src = Deno.readTextFileSync(new URL("../lib/data-export.ts", import.meta.url));
  assert(
    /BUYER_PII_TABLES/.test(src),
    "assembleUserExport does not iterate the buyer register, so a compliance " +
      "export returns less than the same person's self-serve download",
  );
  assert(
    /SELLER_EXPORT_TABLES/.test(src),
    "the seller register is declared and not iterated",
  );
});

Deno.test("US-2648: neither path reaches a table the other misses", () => {
  const selfServe = selfServeTables();
  const admin = new Set<string>();
  const src = Deno.readTextFileSync(new URL("../lib/data-export.ts", import.meta.url));
  for (const m of src.matchAll(/\.from\("([a-z0-9_]+)"\)/g)) admin.add(m[1]!);
  for (const t of [...BUYER_PII_TABLES, ...SELLER_EXPORT_TABLES]) admin.add(t.table);

  // ⚠ CORRECTED (US-2650). This exemption used to read "the stream hands back
  // the rows themselves", and that was simply false — I wrote it without
  // checking. The self-serve response contained NO reference to the person's
  // photographs at all: not the rows, not a list. The admin archive has carried
  // a storage manifest since US-903, so the two answers to one obligation
  // disagreed about the most personal thing we hold.
  //
  // Both paths now build that manifest from collectOwnedStorageObjects, so
  // these two tables are reached as OBJECTS on both sides rather than as rows on
  // either. The exemption stands; the reason it gives is now true.
  const MANIFEST_ONLY = new Set(["submission_images", "item_photos"]);
  const missingFromAdmin = [...selfServe].filter((t) => !admin.has(t)).sort();
  const missingFromSelfServe = [...admin]
    .filter((t) => !selfServe.has(t) && !MANIFEST_ONLY.has(t))
    .sort();

  assertEquals(
    missingFromAdmin,
    [],
    "the self-serve download returns these and the compliance archive does not",
  );
  assertEquals(
    missingFromSelfServe,
    [],
    "the compliance archive returns these and the self-serve download does not",
  );
});

Deno.test("US-2650: both export paths disclose the storage objects we hold", () => {
  // The self-serve response listed none of the person's photographs. The admin
  // archive has had a manifest since US-903. Photographs are the most personal
  // thing here, and one of the two answers to a subject-access request omitted
  // them entirely.
  const stream = Deno.readTextFileSync(new URL("../routes/account.ts", import.meta.url));
  const archive = Deno.readTextFileSync(new URL("../lib/data-export.ts", import.meta.url));

  assert(
    /"storage_objects":/.test(stream),
    "the self-serve export does not disclose any storage object",
  );
  assert(
    /storage_objects/.test(archive),
    "the compliance archive lost its storage manifest",
  );
  // Built from the SAME collector the erasure paths use, so "what we hold for
  // you" and "what we delete for you" cannot describe different sets.
  assert(
    /collectOwnedStorageObjects\(/.test(stream),
    "the export builds its own object list instead of reusing the erasure collector",
  );
});

Deno.test("US-2650: the self-serve manifest ships paths, not signed URLs", () => {
  // Deliberate and worth pinning. The admin archive signs its manifest because
  // an operator delivers it; here the person is already authenticated as
  // themselves. Whether a self-serve export should ALSO ship signed URLs is a
  // legal question, not a coding one — so the current answer is written down
  // rather than drifting silently.
  const stream = Deno.readTextFileSync(new URL("../routes/account.ts", import.meta.url));
  const at = stream.indexOf('"storage_objects":');
  assert(at > -1, "the manifest was renamed");
  const window = stream.slice(Math.max(0, at - 1200), at + 200);
  assert(
    !/createSignedUrl/.test(window),
    "the self-serve manifest started signing URLs; that was a deliberate no — " +
      "change the story, not just the code",
  );
});

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

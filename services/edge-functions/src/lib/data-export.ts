// US-903: tenant-scoped assembly of a single user's data export.
//
// Every query is scoped to the target userId — directly by user_id, or through
// the parent row's ownership (grade_reports via the user's submissions,
// submission_images via those submissions, item_photos via the user's inventory
// items). This is the same scoping the self-serve /api/account/export uses; it
// is extracted here so the admin compliance workflow reuses it AND so the
// zero-cross-tenant-leak guarantee (AC6) is unit-testable with an injected db.

// US-2648: the register the SELF-SERVE export already iterates. Imported here
// so both paths answer with the same set — see the block above assembleUserExport.
import { BUYER_PII_TABLES } from "./buyer-pii.ts";

/**
 * Seller-side tables that belong in a subject-access response and were in
 * neither export. Kept beside the buyer register rather than inlined so the two
 * halves read as one decision.
 *
 * grade_credit_transactions is the person's MONEY — every credit bought, spent,
 * refunded or expired. flipdesk_expenses is their own bookkeeping. disputes are
 * the cases they filed and our decisions on them. All three are user_id-owned
 * and cascade on erasure, which is the same test the buyer register applies.
 */
export const SELLER_EXPORT_TABLES: ReadonlyArray<
  { table: string; exportKey: string; scopeColumn: string; columns?: string }
> = [
  { table: "grade_credit_transactions", exportKey: "grade_credit_transactions", scopeColumn: "user_id" },
  { table: "flipdesk_expenses", exportKey: "expenses", scopeColumn: "user_id" },
  { table: "disputes", exportKey: "disputes", scopeColumn: "user_id" },
  // Found by the parity check in data-export_test.ts on its first run: the
  // self-serve route returns both of these and this archive did not.
  //
  // owner_nodes is scoped by linked_user_id, and takes the SAME narrow column
  // list the self-serve route uses rather than *. That restraint is deliberate
  // there — the passport is pseudonymous by default and the export shows the
  // linkage plus which hops the person chose to reveal, not the whole node.
  {
    table: "owner_nodes",
    exportKey: "passport_identity_nodes",
    scopeColumn: "linked_user_id",
    columns: "id, pseudonymous_label, kind, identity_revealed, identity_revealed_at, created_at",
  },
  // US-1864: the reseller's own Thrift Radar visit log — the one Radar table
  // that is subject data, since the shared event store has no account column.
  { table: "radar_personal_scans", exportKey: "radar_personal_scans", scopeColumn: "user_id" },
];

// Narrow structural view of the supabase client this module needs. The real
// service-role client satisfies it (cast at the call site); the test injects a
// fake. Keeping it minimal avoids depending on supabase-js builder internals.
export interface ExportSelect {
  eq(
    column: string,
    value: string,
  ): PromiseLike<{ data: Record<string, unknown>[] | null }>;
  in(
    column: string,
    values: string[],
  ): PromiseLike<{ data: Record<string, unknown>[] | null }>;
}
export interface ExportFrom {
  select(columns: string): ExportSelect;
}
export interface ExportDb {
  from(table: string): ExportFrom;
}

export interface ExportStorageObject {
  bucket: "submission-images" | "item-photos";
  path: string;
}

export interface UserExportArchive {
  exported_at: string;
  user_id: string;
  profile: Record<string, unknown> | null;
  submissions: Record<string, unknown>[];
  grade_reports: Record<string, unknown>[];
  inventory_items: Record<string, unknown>[];
  listings: Record<string, unknown>[];
  sales: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  storage_objects: ExportStorageObject[];
  /**
   * US-2648: everything driven off a register rather than a hand-written field.
   *
   * The buyer half and the three seller tables land here, keyed by exportKey. A
   * map rather than more named fields precisely because the named fields are
   * what let this archive fall behind the self-serve response: adding a table
   * meant remembering two files, and nobody did.
   */
  tables: Record<string, Record<string, unknown>[]>;
}

function ids(rows: Record<string, unknown>[], key: string): string[] {
  return rows
    .map((r) => r[key])
    .filter((v): v is string => typeof v === "string");
}

function paths(
  rows: Record<string, unknown>[],
): string[] {
  return rows
    .map((r) => r.storage_path)
    .filter((v): v is string => typeof v === "string");
}

/**
 * Assemble a complete, tenant-scoped export of `userId`'s data. Returns the row
 * payload plus a manifest of the user's storage objects (so a caller can sign or
 * archive them). NEVER includes any other tenant's rows.
 */
export async function assembleUserExport(
  db: ExportDb,
  userId: string,
  now: string = new Date().toISOString(),
): Promise<UserExportArchive> {
  // Tenant-keyed tables filter by user_id directly.
  const [profileRes, submissionsRes, inventoryRes, sourcesRes, listingsRes, salesRes] =
    await Promise.all([
      db.from("users").select("*").eq("id", userId),
      db.from("submissions").select("*").eq("user_id", userId),
      db.from("inventory_items").select("*").eq("user_id", userId),
      db.from("sources").select("*").eq("user_id", userId),
      db.from("listings").select("*").eq("user_id", userId),
      db.from("sales").select("*").eq("user_id", userId),
    ]);

  const submissions = submissionsRes.data ?? [];
  const inventory = inventoryRes.data ?? [];
  const submissionIds = ids(submissions, "id");
  const inventoryIds = ids(inventory, "id");

  // Parent-scoped tables resolve through the owned parents above.
  const [gradeReportsRes, subImagesRes, itemPhotosRes] = await Promise.all([
    submissionIds.length
      ? db.from("grade_reports").select("*").in("submission_id", submissionIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    submissionIds.length
      ? db.from("submission_images").select("submission_id, storage_path").in(
        "submission_id",
        submissionIds,
      )
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    inventoryIds.length
      ? db.from("item_photos").select("inventory_item_id, storage_path").in(
        "inventory_item_id",
        inventoryIds,
      )
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  const storage_objects: ExportStorageObject[] = [
    ...paths(subImagesRes.data ?? []).map((path) => ({
      bucket: "submission-images" as const,
      path,
    })),
    ...paths(itemPhotosRes.data ?? []).map((path) => ({
      bucket: "item-photos" as const,
      path,
    })),
  ];

  // US-2648: THE ADMIN ARCHIVE USED TO BE SMALLER THAN THE SELF-SERVE ONE.
  //
  // /api/account/export iterates BUYER_PII_TABLES; this did not. So a subject
  // whose access request went through the compliance queue — the formal,
  // legally-defensible path — received LESS than the same person got by
  // clicking Export in their own settings: no body measurements, no closet, no
  // saved searches, no watchlist, no reward ledger, no guarantee claims.
  //
  // US-1846 built the register exactly so this could not happen, and its own
  // docblock says the export route iterates it rather than a document beside
  // the code. Only one of the two export routes ever did.
  const registered = [...BUYER_PII_TABLES, ...SELLER_EXPORT_TABLES];
  const registeredRows = await Promise.all(
    registered.map((t) =>
      db.from(t.table).select((t as { columns?: string }).columns ?? "*").eq(
        t.scopeColumn,
        userId,
      )
    ),
  );
  const tables: Record<string, Record<string, unknown>[]> = {};
  registered.forEach((t, i) => {
    tables[t.exportKey] = registeredRows[i]?.data ?? [];
  });

  const profileRows = profileRes.data ?? [];

  return {
    exported_at: now,
    user_id: userId,
    profile: profileRows[0] ?? null,
    submissions,
    grade_reports: gradeReportsRes.data ?? [],
    inventory_items: inventory,
    listings: listingsRes.data ?? [],
    sales: salesRes.data ?? [],
    sources: sourcesRes.data ?? [],
    storage_objects,
    tables,
  };
}

// US-903: tenant-scoped assembly of a single user's data export.
//
// Every query is scoped to the target userId — directly by user_id, or through
// the parent row's ownership (grade_reports via the user's submissions,
// submission_images via those submissions, item_photos via the user's inventory
// items). This is the same scoping the self-serve /api/account/export uses; it
// is extracted here so the admin compliance workflow reuses it AND so the
// zero-cross-tenant-leak guarantee (AC6) is unit-testable with an injected db.

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
  };
}

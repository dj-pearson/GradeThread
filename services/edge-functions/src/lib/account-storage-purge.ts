// US-2649: every storage object an account owns, in one place, for both erasure
// paths.
//
// WHY THIS MODULE EXISTS. There are two erasure paths and they had drifted
// badly. `POST /api/account/delete` (self-serve) swept five buckets from seven
// sources. The admin compliance ANONYMIZE branch — the formal path, the one a
// written erasure request goes through, the one that has to stand up — swept
// TWO buckets from TWO sources.
//
// So the formal path was materially weaker than the self-serve one, and it still
// contained a defect fixed long ago everywhere else: it selected only
// `storage_path` from submission_images, never `original_storage_path`. US-1637
// added that column to the self-serve sweep with an explicit note that omitting
// it "left GPS-bearing PII in the bucket after deletion". The other path kept
// omitting it.
//
// One list, two callers. The duplication WAS the defect, so removing it is the
// fix rather than a tidy-up alongside one.
//
// TENANCY. Every query here is scoped to the target user — directly by a user
// column, or through a parent row already filtered to them. Nothing takes an id
// from a request. This runs on the service-role client, which bypasses RLS, so
// the scoping is the only protection (CLAUDE.md US-268).

/** A supabase-shaped reader. Narrow so a test can inject a fake. */
export interface PurgeSelect {
  eq(column: string, value: string): PromiseLike<{ data: Record<string, unknown>[] | null }>;
  in(column: string, values: string[]): PromiseLike<{ data: Record<string, unknown>[] | null }>;
}
export interface PurgeFrom {
  select(columns: string): PurgeSelect;
}
export interface PurgeStorage {
  list(prefix: string, opts?: { limit?: number }): PromiseLike<
    { data: { name?: string }[] | null; error: { message: string } | null }
  >;
}
export interface PurgeDb {
  from(table: string): PurgeFrom;
  storage: { from(bucket: string): PurgeStorage };
}

/** Objects to remove, grouped by the bucket they live in. */
export type OwnedStorage = Record<string, string[]>;

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function column(rows: Record<string, unknown>[] | null, key: string): string[] {
  return (rows ?? []).map((r) => r[key]).filter(str);
}

/**
 * Every storage object owned by `userId`, keyed by bucket.
 *
 * MUST be called BEFORE the account row is destroyed or anonymized: all but one
 * source is discovered through rows that the cascade removes, and the one
 * exception (avatars) is discovered by listing the user's folder precisely
 * because its only pointer — `users.avatar_url` — is destroyed by the anonymize
 * step in the admin path.
 */
export async function collectOwnedStorageObjects(
  db: PurgeDb,
  userId: string,
): Promise<OwnedStorage> {
  const [subs, items] = await Promise.all([
    db.from("submissions").select("id").eq("user_id", userId),
    db.from("inventory_items").select("id").eq("user_id", userId),
  ]);
  const subIds = column(subs.data, "id");
  const itemIds = column(items.data, "id");

  const [subImgs, itemPhotos, disputes, arrivals, exports_, receipts] = await Promise.all([
    subIds.length
      // US-1637: the EXIF/GPS-INTACT original as well as the served copy.
      ? db.from("submission_images").select("storage_path, original_storage_path").in(
        "submission_id",
        subIds,
      )
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    itemIds.length
      ? db.from("item_photos").select("storage_path").in("inventory_item_id", itemIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    db.from("disputes").select("evidence_paths").eq("user_id", userId),
    db.from("purchase_arrival_captures").select("storage_path").eq("user_id", userId),
    db.from("data_requests").select("file_path").eq("user_id", userId),
    db.from("flipdesk_expenses").select("receipt_path").eq("user_id", userId),
  ]);

  const evidence = (disputes.data ?? [])
    .flatMap((r) => (Array.isArray(r.evidence_paths) ? r.evidence_paths : []))
    .filter(str);

  return {
    "submission-images": [
      ...new Set([
        ...column(subImgs.data, "storage_path"),
        ...column(subImgs.data, "original_storage_path"),
        ...evidence,
        ...column(arrivals.data, "storage_path"),
      ]),
    ],
    "item-photos": [...new Set(column(itemPhotos.data, "storage_path"))],
    "compliance-exports": [...new Set(column(exports_.data, "file_path"))],
    "expense-receipts": [...new Set(column(receipts.data, "receipt_path"))],
    // US-2647: no table enumerates avatars. Uploads are timestamped, so
    // `users.avatar_url` names only the current object and reading it would
    // erase the latest while leaving every superseded one behind.
    avatars: await listUserFolder(db, "avatars", userId),
  };
}

/**
 * Every object under `{userId}/` in a bucket, as full paths.
 *
 * Best-effort: a listing failure logs and returns nothing rather than throwing,
 * because it must not be the reason an erasure request fails partway through.
 */
export async function listUserFolder(
  db: PurgeDb,
  bucket: string,
  userId: string,
): Promise<string[]> {
  const { data, error } = await db.storage.from(bucket).list(userId, { limit: 1000 });
  if (error) {
    console.error(`[account-storage-purge] list failed (${bucket}):`, error.message);
    return [];
  }
  return (data ?? []).map((o) => o.name).filter(str).map((n) => `${userId}/${n}`);
}

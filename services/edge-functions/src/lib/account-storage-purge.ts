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
// US-3391: ROWS ARE NOT THE INVENTORY. Every source above discovers objects by
// reading a column that points at them. A staged upload has no such column: the
// AutoLister, the phone-capture flow, the remote-photo importer and the expense
// receipt reader all write bytes to `{ownerId}/_staging/...` FIRST and create the
// row only when the seller confirms. Until then the only pointer is the page's
// React state, so closing the tab strands the object. In `item-photos` that
// object is on a guessable public URL, it has no row, and every sweep here used
// to discover it through rows -- so it survived account deletion and was still
// served after we told the seller their data was erased.
//
// The fix is the same one US-2647 used for avatars: enumerate the folder, do not
// follow a pointer. Staged objects are now LISTED under `{userId}/_staging/` in
// both buckets that have a staging area, and unioned into the bucket's path list
// so both callers sweep them without changing.
//
// TENANCY. Every query here is scoped to the target user — directly by a user
// column, or through a parent row already filtered to them. Nothing takes an id
// from a request. This runs on the service-role client, which bypasses RLS, so
// the scoping is the only protection (CLAUDE.md US-268).
//
// TENANCY OF THE LISTING, specifically, because this one DELETES what it finds:
//   1. `userId` must match SAFE_PATH_SEGMENT before any prefix is built. That
//      charset cannot express `/`, `.` or an empty string, so the prefix can
//      never become the bucket root or climb out of the user's folder. A userId
//      that fails the check lists NOTHING and reports -- the failure mode is
//      "delete nothing", never "delete more".
//   2. The prefix is built here from `userId`, never taken from a request body.
//   3. Every path the walk returns is re-checked against `${userId}/` before it
//      is returned, so a hostile or buggy storage response cannot smuggle a
//      foreign path into a delete list.
//   4. The walk is bounded on three axes (page count, folder count, depth). An
//      unbounded loop over a prefix is the shape to avoid even when the prefix
//      is right.
//
// ERRORS. `list()` and `remove()` RESOLVE with `{ error }`; they do not throw. A
// swallowed list error here means we told a person their data was erased and it
// was not, so every refusal, truncation and failure goes to a sink that says
// INCOMPLETE ERASURE in those words. Callers may pass their own sink.

/** A supabase-shaped reader. Narrow so a test can inject a fake. */
export interface PurgeSelect {
  eq(column: string, value: string): PromiseLike<{ data: Record<string, unknown>[] | null }>;
  in(column: string, values: string[]): PromiseLike<{ data: Record<string, unknown>[] | null }>;
}
export interface PurgeFrom {
  select(columns: string): PurgeSelect;
}
/**
 * One entry from a storage listing.
 *
 * `id` is how supabase-js distinguishes the two kinds: a stored object carries a
 * uuid, a FOLDER carries a literal `null`. Anything else (including `undefined`,
 * which is what a hand-written fake returns) is treated as an object, because
 * descending into something that is not a folder costs a wasted list call while
 * NOT descending into a real one silently loses every child.
 */
export interface PurgeListEntry {
  name?: string;
  id?: string | null;
}
export interface PurgeStorage {
  list(prefix: string, opts?: { limit?: number; offset?: number }): PromiseLike<
    { data: PurgeListEntry[] | null; error: { message: string } | null }
  >;
}
export interface PurgeDb {
  from(table: string): PurgeFrom;
  storage: { from(bucket: string): PurgeStorage };
}

/** Objects to remove, grouped by the bucket they live in. */
export type OwnedStorage = Record<string, string[]>;

/** Why a listing did not produce a complete answer. */
export interface PurgeListFailure {
  bucket: string;
  prefix: string;
  reason: string;
}
export type PurgeFailureSink = (failure: PurgeListFailure) => void;

export interface CollectOptions {
  /** Where incomplete-enumeration reports go. Defaults to the console sink. */
  onListFailure?: PurgeFailureSink;
}

/**
 * The default sink. Loud and greppable on purpose: the caller currently records
 * `storage_purged: true` unconditionally, so this line is the only place a
 * partially-completed erasure is visible at all.
 */
export const reportToConsole: PurgeFailureSink = (f) => {
  console.error(
    `[account-storage-purge] INCOMPLETE ERASURE: could not enumerate ` +
      `${f.bucket}/${f.prefix}: ${f.reason}`,
  );
};

/**
 * A path segment we are willing to build a delete prefix from.
 *
 * No `/`, no `.`, no whitespace, never empty. This is the whole cross-tenant
 * argument for the listing: `${userId}/_staging` cannot collapse to `""` (the
 * bucket root, i.e. every tenant) and cannot climb with `..`.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The scratch prefix every staging writer uses, under the owner's folder. */
export const STAGING_PREFIX = "_staging";

/**
 * Buckets that hold a `{ownerId}/_staging/` scratch area, with the writers.
 *
 * Both are enumerated on erasure. `submission-images` is deliberately absent:
 * grading uploads land on their final `{ownerId}/{submissionId}/` path with the
 * row written in the same request, so there is no staging tree to walk.
 */
export const STAGING_BUCKETS: readonly string[] = [
  // routes/flipdesk-autolister.ts (staging photo upload, handoff park/claim),
  // routes/flipdesk-phone-capture.ts (`_staging/phone/`),
  // lib/remote-photo-import.ts (`_staging/<provider>/`). PUBLIC bucket.
  "item-photos",
  // routes/flipdesk-expenses.ts POST /extract parks the receipt before the
  // expense row exists. Private, but a receipt carries a card tail and a
  // billing address.
  "expense-receipts",
];

/** Entries fetched per `list()` call. */
export const LIST_PAGE_SIZE = 1000;
/** Pages per folder before we stop and report rather than loop. */
export const MAX_PAGES_PER_FOLDER = 20;
/** Folders visited per bucket walk before we stop and report. */
export const MAX_FOLDERS_PER_WALK = 500;
/**
 * How deep below `{userId}/_staging` the walk may go.
 *
 * Measured against prod on 2026-09-11, not assumed: the deepest real path is
 * TWO levels down, `{userId}/_staging/gphotos/originals/{id}.jpg`, because
 * lib/measure-upright-pass.ts inserts an `originals/` segment ahead of the
 * filename when a photo is rotated (US-2890). A cap of one would have walked
 * straight past 2,745 objects. One level of headroom on top of that, then a
 * report -- a silently truncated walk is the failure this whole story is about.
 */
export const MAX_STAGING_DEPTH = 3;

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function column(rows: Record<string, unknown>[] | null, key: string): string[] {
  return (rows ?? []).map((r) => r[key]).filter(str);
}

/**
 * Every entry directly under `prefix`, following pagination.
 *
 * A page-cap or an error stops the walk for that folder and reports; it never
 * spins. `complete` is false when the answer is known to be partial.
 */
async function listPage(
  db: PurgeDb,
  bucket: string,
  prefix: string,
  report: PurgeFailureSink,
): Promise<{ entries: PurgeListEntry[]; complete: boolean }> {
  const entries: PurgeListEntry[] = [];
  for (let page = 0; page < MAX_PAGES_PER_FOLDER; page++) {
    const { data, error } = await db.storage.from(bucket).list(prefix, {
      limit: LIST_PAGE_SIZE,
      offset: page * LIST_PAGE_SIZE,
    });
    // list() RESOLVES with an error rather than throwing. Reported, not
    // swallowed: the objects we did not see are objects we will not delete.
    if (error) {
      report({ bucket, prefix, reason: `list failed: ${error.message}` });
      return { entries, complete: false };
    }
    const batch = data ?? [];
    entries.push(...batch);
    if (batch.length < LIST_PAGE_SIZE) return { entries, complete: true };
  }
  report({
    bucket,
    prefix,
    reason: `more than ${MAX_PAGES_PER_FOLDER * LIST_PAGE_SIZE} entries; the rest were not enumerated`,
  });
  return { entries, complete: false };
}

/**
 * Every object at or below `root`, as full paths. Breadth-first, bounded.
 *
 * `root` is built by the caller from a SAFE_PATH_SEGMENT-checked user id; this
 * function never receives a prefix from a request.
 */
async function walk(
  db: PurgeDb,
  bucket: string,
  root: string,
  report: PurgeFailureSink,
): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ prefix: string; depth: number }> = [{ prefix: root, depth: 0 }];
  let folders = 0;

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (++folders > MAX_FOLDERS_PER_WALK) {
      report({
        bucket,
        prefix: node.prefix,
        reason: `more than ${MAX_FOLDERS_PER_WALK} folders; the rest were not enumerated`,
      });
      break;
    }
    const { entries } = await listPage(db, bucket, node.prefix, report);
    for (const entry of entries) {
      const name = entry.name;
      // A listing returns ONE segment per entry. A name carrying a separator is
      // not something to reassemble a path from.
      if (!str(name) || name.includes("/")) continue;
      const full = `${node.prefix}/${name}`;
      if (entry.id === null) {
        if (node.depth + 1 > MAX_STAGING_DEPTH) {
          report({ bucket, prefix: full, reason: `deeper than ${MAX_STAGING_DEPTH} levels; not enumerated` });
          continue;
        }
        queue.push({ prefix: full, depth: node.depth + 1 });
        continue;
      }
      found.push(full);
    }
  }
  return found;
}

/**
 * Every object under `{userId}/` in a bucket, ONE level deep, as full paths.
 *
 * Used for avatars, which are flat. Paginated (a user with more than one page of
 * avatars used to be silently truncated) and prefix-filtered on the way out.
 *
 * Best-effort by return value: a listing failure reports and returns what it
 * has, because it must not be the reason an erasure request fails partway
 * through. It is NOT silent -- see reportToConsole.
 */
export async function listUserFolder(
  db: PurgeDb,
  bucket: string,
  userId: string,
  report: PurgeFailureSink = reportToConsole,
): Promise<string[]> {
  if (!SAFE_PATH_SEGMENT.test(userId)) {
    report({ bucket, prefix: userId, reason: "user id is not a safe path segment; listed nothing" });
    return [];
  }
  const { entries } = await listPage(db, bucket, userId, report);
  return entries
    .map((o) => o.name)
    .filter(str)
    .filter((n) => !n.includes("/"))
    .map((n) => `${userId}/${n}`)
    .filter((p) => p.startsWith(`${userId}/`));
}

/**
 * US-3391: every STAGED object this user has stranded in `bucket`.
 *
 * Discovered by walking `{userId}/_staging/`, because a staged object has no row
 * to follow -- that is the entire defect. Returns full paths, every one of them
 * re-checked to sit under `{userId}/`.
 */
export async function listStagedObjects(
  db: PurgeDb,
  bucket: string,
  userId: string,
  report: PurgeFailureSink = reportToConsole,
): Promise<string[]> {
  if (!SAFE_PATH_SEGMENT.test(userId)) {
    report({ bucket, prefix: userId, reason: "user id is not a safe path segment; listed nothing" });
    return [];
  }
  const root = `${userId}/${STAGING_PREFIX}`;
  const paths = await walk(db, bucket, root, report);
  // Belt and braces. `walk` builds every path from `root`, so this can only fire
  // on a bug, and a bug here deletes another tenant's photograph.
  const own = paths.filter((p) => p.startsWith(`${userId}/`));
  if (own.length !== paths.length) {
    report({
      bucket,
      prefix: root,
      reason: `${paths.length - own.length} listed path(s) fell outside the user folder and were dropped`,
    });
  }
  return own;
}

/**
 * Every storage object owned by `userId`, keyed by bucket.
 *
 * MUST be called BEFORE the account row is destroyed or anonymized: all but two
 * sources are discovered through rows that the cascade removes. The exceptions
 * are discovered by listing precisely because they have no usable pointer:
 * avatars (`users.avatar_url` names only the current object, and the anonymize
 * step destroys it) and staged uploads (no row exists at all until the seller
 * confirms).
 */
export async function collectOwnedStorageObjects(
  db: PurgeDb,
  userId: string,
  opts: CollectOptions = {},
): Promise<OwnedStorage> {
  const report = opts.onListFailure ?? reportToConsole;

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

  // US-3391: the objects no row points at. Unioned into the bucket they live in
  // rather than given a key of their own, so both callers keep sweeping with
  // `for (const [bucket, paths] of Object.entries(owned))` -- a new top-level
  // key would be read as a new BUCKET NAME and address nothing.
  const staged = await Promise.all(
    STAGING_BUCKETS.map((bucket) => listStagedObjects(db, bucket, userId, report)),
  );
  const stagedIn = (bucket: string): string[] => {
    const at = STAGING_BUCKETS.indexOf(bucket);
    return at === -1 ? [] : (staged[at] ?? []);
  };

  return {
    "submission-images": [
      ...new Set([
        ...column(subImgs.data, "storage_path"),
        ...column(subImgs.data, "original_storage_path"),
        ...evidence,
        ...column(arrivals.data, "storage_path"),
      ]),
    ],
    "item-photos": [
      ...new Set([...column(itemPhotos.data, "storage_path"), ...stagedIn("item-photos")]),
    ],
    "compliance-exports": [...new Set(column(exports_.data, "file_path"))],
    "expense-receipts": [
      ...new Set([...column(receipts.data, "receipt_path"), ...stagedIn("expense-receipts")]),
    ],
    // US-2647: no table enumerates avatars. Uploads are timestamped, so
    // `users.avatar_url` names only the current object and reading it would
    // erase the latest while leaving every superseded one behind.
    avatars: await listUserFolder(db, "avatars", userId),
  };
}

// US-3391 AC1, the half that needs a join: which staged objects are ORPHANS.
//
// THE NUMBER ON THE STORY IS NOT THE ANSWER, and mistaking it for one is how a
// sweep deletes a live listing photo. US-3391 measured 3,557 objects and
// 2.21 GB under `{owner}/_staging/` in prod `item-photos`. That is staged
// OBJECTS. Generation does not copy a staged object out of `_staging/` -- it
// points `item_photos.storage_path` STRAIGHT BACK INTO IT -- so an adopted
// photo is a live listing image at a staging path, and eBay is serving some of
// them right now. Age alone cannot tell the two apart.
//
// So an object is an orphan only when NO ROW ANYWHERE references it. This file
// is the reference set and the classification; the script that fetches both
// halves is scripts/diagnose-staged-orphans.ts, and it only ever READS.
//
// WHY THIS IS NOT THE SWEEP. AC3 asks for one and it is deliberately not built
// here. A sweep deletes seller photographs, and the set it would delete has
// never been counted -- the story says so in as many words. Counting first is
// the whole point, and the count is a different risk from the deletion.

/** The columns that can hold a path inside a staging tree, and their bucket. */
export interface StagedReferenceSource {
  table: string;
  column: string;
  bucket: string;
}

/**
 * Every row-side reference to a staged object, enumerated rather than
 * summarised, because a MISSING entry here turns a live photo into an orphan
 * and a sweep built on it deletes a listing image.
 *
 * ⚠ `item_photos.thumbnail_storage_path` IS ON THIS LIST and is absent from
 * `collectOwnedStorageObjects`'s row-following read, which selects
 * `storage_path` alone. That is not an erasure hole -- erasure also walks the
 * whole `_staging/` folder, so the thumbnail goes either way -- but it WOULD
 * be an orphan-counting hole, and later a deletion one. Counted here.
 */
export const STAGED_REFERENCE_SOURCES: readonly StagedReferenceSource[] = [
  // The adopted listing photo and its thumbnail, both of which stay at their
  // staging path after generation.
  { table: "item_photos", column: "storage_path", bucket: "item-photos" },
  { table: "item_photos", column: "thumbnail_storage_path", bucket: "item-photos" },
  // routes/flipdesk-phone-capture.ts writes `{owner}/_staging/phone/<uuid>.<ext>`
  // and keeps the path on its own row until the desktop stages it.
  { table: "phone_capture_photos", column: "storage_path", bucket: "item-photos" },
  // routes/flipdesk-expenses.ts POST /extract parks the receipt before the
  // expense row exists; the row gains the same path when it is saved.
  { table: "flipdesk_expenses", column: "receipt_path", bucket: "expense-receipts" },
];

/** Buckets with a `{owner}/_staging/` tree. Mirrors STAGING_BUCKETS. */
export const STAGED_BUCKETS: readonly string[] = ["item-photos", "expense-receipts"];

export const STAGING_SEGMENT = "_staging";

/** One object as the storage listing gives it. */
export interface StagedObject {
  /** Full path inside the bucket, e.g. `<owner>/_staging/gphotos/x.jpg`. */
  path: string;
  /** Last modified, ISO. Absent is treated as unknown age, never as old. */
  updatedAt?: string | null;
  bytes?: number | null;
}

export interface AgeBand {
  label: string;
  /** Inclusive lower bound in days. */
  fromDays: number;
  /** Exclusive upper bound, or null for open-ended. */
  toDays: number | null;
}

/**
 * The bands US-3391 measured in, so a re-run is comparable to the first count
 * rather than merely adjacent to it.
 */
export const AGE_BANDS: readonly AgeBand[] = [
  { label: "under a day", fromDays: 0, toDays: 1 },
  { label: "1-7 days", fromDays: 1, toDays: 7 },
  { label: "7-30 days", fromDays: 7, toDays: 30 },
  { label: "30-90 days", fromDays: 30, toDays: 90 },
  { label: "over 90 days", fromDays: 90, toDays: null },
];

export const UNKNOWN_AGE_LABEL = "age unknown";

/**
 * Normalise a path for comparison.
 *
 * A stored path and a listed path describe the same object and are not always
 * the same string: a leading slash, a bucket prefix someone included, or a
 * percent-encoded space. Comparing them raw is the failure that would classify
 * a REFERENCED object as an orphan, so the normalisation is deliberately
 * generous in exactly the ways that cannot merge two different objects.
 */
export function normalizeStoragePath(raw: string, bucket?: string): string {
  let p = String(raw ?? "").trim();
  if (!p) return "";
  try {
    // Only if it changes nothing structural: decoding cannot introduce a slash
    // that was not already expressed, because %2F is not produced by the
    // uploaders here and a decode that yields one is refused below.
    const decoded = decodeURIComponent(p);
    if (!/%2f/i.test(p)) p = decoded;
  } catch {
    // A malformed escape is left as-is rather than dropped: an unparseable
    // path that matches byte-for-byte is still a reference.
  }
  p = p.replace(/^\/+/, "");
  if (bucket && p.startsWith(`${bucket}/`)) p = p.slice(bucket.length + 1);
  return p;
}

/** Is this path inside some owner's staging tree? */
export function isStagedPath(path: string): boolean {
  const parts = normalizeStoragePath(path).split("/");
  return parts.length > 2 && parts[1] === STAGING_SEGMENT;
}

/** The owner segment of a staged path, or null when it is not one. */
export function stagedOwner(path: string): string | null {
  const parts = normalizeStoragePath(path).split("/");
  if (parts.length > 2 && parts[1] === STAGING_SEGMENT && parts[0]) return parts[0];
  return null;
}

export function ageBandFor(
  updatedAt: string | null | undefined,
  nowMs: number,
): string {
  if (!updatedAt) return UNKNOWN_AGE_LABEL;
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return UNKNOWN_AGE_LABEL;
  const days = (nowMs - t) / 86_400_000;
  // A clock skew that puts an object in the future is not "brand new" and not
  // an error worth failing on; it lands in the youngest band, which is the one
  // no sweep would ever touch.
  if (days < 0) return AGE_BANDS[0].label;
  for (const band of AGE_BANDS) {
    if (days >= band.fromDays && (band.toDays === null || days < band.toDays)) {
      return band.label;
    }
  }
  return AGE_BANDS[AGE_BANDS.length - 1].label;
}

export interface BucketOrphanReport {
  bucket: string;
  staged: number;
  stagedBytes: number;
  referenced: number;
  orphans: number;
  orphanBytes: number;
  /** Orphan counts by age band, in AGE_BANDS order then unknown. */
  orphansByAge: Record<string, number>;
  /** Orphan owners whose account is already marked deleted. */
  orphansForDeletedAccounts: number;
  /** Distinct owners with at least one orphan. */
  ownersWithOrphans: number;
}

export interface ClassifyInput {
  bucket: string;
  objects: readonly StagedObject[];
  /** Every path any row references, already normalised. */
  referenced: ReadonlySet<string>;
  /** Owner ids whose account row is gone or marked deleted. */
  deletedOwners?: ReadonlySet<string>;
  nowMs?: number;
}

/**
 * Split a bucket's staged objects into referenced and orphaned.
 *
 * REFERENCED WINS EVERY TIE. An object whose path is in the set is never an
 * orphan, whatever its age, and an object this cannot classify is counted as
 * referenced rather than as an orphan -- because the only consumer of the
 * orphan number is a deletion, and the safe error is to under-report it.
 */
export function classifyStagedObjects(input: ClassifyInput): BucketOrphanReport {
  const nowMs = input.nowMs ?? Date.now();
  const deleted = input.deletedOwners ?? new Set<string>();
  const orphansByAge: Record<string, number> = {};
  for (const band of AGE_BANDS) orphansByAge[band.label] = 0;
  orphansByAge[UNKNOWN_AGE_LABEL] = 0;

  const owners = new Set<string>();
  const report: BucketOrphanReport = {
    bucket: input.bucket,
    staged: 0,
    stagedBytes: 0,
    referenced: 0,
    orphans: 0,
    orphanBytes: 0,
    orphansByAge,
    orphansForDeletedAccounts: 0,
    ownersWithOrphans: 0,
  };

  for (const obj of input.objects) {
    const path = normalizeStoragePath(obj.path, input.bucket);
    if (!isStagedPath(path)) continue; // not in a staging tree; not this count
    report.staged++;
    const bytes = typeof obj.bytes === "number" && obj.bytes > 0 ? obj.bytes : 0;
    report.stagedBytes += bytes;

    if (input.referenced.has(path)) {
      report.referenced++;
      continue;
    }
    report.orphans++;
    report.orphanBytes += bytes;
    orphansByAge[ageBandFor(obj.updatedAt, nowMs)]++;
    const owner = stagedOwner(path);
    if (owner) {
      owners.add(owner);
      if (deleted.has(owner)) report.orphansForDeletedAccounts++;
    }
  }
  report.ownersWithOrphans = owners.size;
  return report;
}

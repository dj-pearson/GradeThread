// US-3187: item_photos rows whose file is gone from storage.
//
// THE INVERSE OF US-3391, and the two must not be confused. staged-orphans.ts
// asks which OBJECTS no row references; this asks which ROWS no object backs.
// Both are joins over the same two sets and they fail in opposite directions:
// a mistake there deletes a live photo, a mistake here deletes a row whose
// photo was only briefly unreadable.
//
// CONFIRMED IN PRODUCTION 2026-09-08 from a console 400: the row exists and
// yields a valid public URL; the object behind it does not. The storage GET
// answers HTTP 400 carrying {"statusCode":"404","error":"not_found"}.
//
// ── WHY ABSENCE HAS TO MEAN ABSENT-FROM-A-COMPLETE-LISTING ───────────────────
//
// A row is only dead when its path is missing from a listing we KNOW finished.
// A 403, a timeout or a truncated page all look exactly like "not there", and
// acting on one would delete a row whose file is sitting in the bucket. So the
// caller hands in `listingComplete`, and a false value makes every classifier
// below refuse rather than guess. That is US-3187 AC4, expressed as a type
// rather than as a warning in a comment nobody reads.
//
// ── WHY TWO PATHS PER ROW ────────────────────────────────────────────────────
//
// A row carries `storage_path` and `thumbnail_storage_path`. Either can die
// alone, and the one-dead case is RECOVERABLE by clearing a single column --
// the photo still exists. Lumping it in with a row that has nothing left would
// throw away a photo to fix a thumbnail. That is AC5.

/** One item_photos row, as far as this join cares. */
export interface PhotoRow {
  id: string;
  inventoryItemId: string;
  /** users.id that owns the item. The first path segment, in practice. */
  ownerUserId: string | null;
  storagePath: string | null;
  thumbnailStoragePath: string | null;
  createdAt: string | null;
}

/** What is missing on one row. */
export type MissingKind =
  /** Both paths absent: nothing of this photo is left. */
  | "both_gone"
  /** The full-size object is gone, the thumbnail survives. */
  | "photo_gone_thumb_alive"
  /** The thumbnail is gone, the full-size object survives. Clear one column. */
  | "thumb_gone_photo_alive"
  /** The row names no storage_path at all, so there is nothing to look for. */
  | "no_path_recorded";

/**
 * The SHAPE a group of dead rows makes, which is as close to a cause as a join
 * can honestly get.
 *
 * Each maps to one of AC3's three causes, and the mapping is an INFERENCE, not
 * a reading. It is stated that way in `causeHint` so nobody quotes it as fact.
 */
export type DeadShape =
  /** One dead row on an item whose other photos are all present. */
  | "isolated"
  /** Every photo on the item is dead; the item's whole folder is empty. */
  | "whole_item"
  /** Every dead row in the report belongs to one owner, across several items. */
  | "whole_owner"
  /** Dead rows span several owners and all predate the newest live row. */
  | "older_than_every_live_row";

export interface DeadRow {
  row: PhotoRow;
  kind: MissingKind;
  shape: DeadShape;
  /** The inferred cause, worded as an inference. */
  causeHint: string;
}

const CAUSE: Record<DeadShape, string> = {
  isolated:
    "looks like an upload that wrote the row and failed the object: this photo " +
    "is dead and its siblings on the same item are not",
  whole_item:
    "looks like a delete that took the item's whole folder and left the rows: " +
    "every photo on this item is dead",
  whole_owner:
    "looks like a bucket cleanup scoped to one owner that outran its rows: the " +
    "dead rows are all this owner's, across several items",
  older_than_every_live_row:
    "looks like a restore that brought the table back without the storage: the " +
    "dead rows span several owners and every one predates the oldest live row",
};

/** Normalise a path for comparison. Mirrors staged-orphans.ts for the same reasons. */
export function normalizePhotoPath(raw: string | null | undefined, bucket?: string): string {
  let p = String(raw ?? "").trim();
  if (!p) return "";
  try {
    const decoded = decodeURIComponent(p);
    if (!/%2f/i.test(p)) p = decoded;
  } catch {
    // A malformed escape stays as-is: a path that matches byte-for-byte is
    // still the same object.
  }
  p = p.replace(/^\/+/, "");
  if (bucket && p.startsWith(`${bucket}/`)) p = p.slice(bucket.length + 1);
  return p;
}

export interface ClassifyInput {
  rows: readonly PhotoRow[];
  /** Every object path the bucket listing returned, already normalised. */
  presentPaths: ReadonlySet<string>;
  /**
   * Did every listing this report depends on finish? False refuses the whole
   * classification rather than reporting a partial read as a set of dead rows.
   */
  listingComplete: boolean;
  bucket?: string;
}

export interface MissingPhotoReport {
  /** Null when `listingComplete` was false. Absence of an answer, not an empty one. */
  dead: DeadRow[] | null;
  /** Rows checked, including the live ones. */
  rowsChecked: number;
  /** Rows with no storage_path recorded, which this join cannot speak about. */
  withoutPath: number;
  refusal: string | null;
  countsByKind: Record<MissingKind, number>;
  countsByShape: Record<DeadShape, number>;
  owners: string[];
  /** ISO timestamps of the oldest and newest dead row, or null when none. */
  span: { oldest: string; newest: string } | null;
}

const emptyKinds = (): Record<MissingKind, number> => ({
  both_gone: 0,
  photo_gone_thumb_alive: 0,
  thumb_gone_photo_alive: 0,
  no_path_recorded: 0,
});

const emptyShapes = (): Record<DeadShape, number> => ({
  isolated: 0,
  whole_item: 0,
  whole_owner: 0,
  older_than_every_live_row: 0,
});

/**
 * Which rows are dead, what is dead about each, and what shape they make.
 *
 * READ-ONLY by construction: it takes two sets and returns a report. Nothing
 * here can delete anything, which is why AC4's second mode is not in this file.
 */
export function classifyMissingPhotoObjects(input: ClassifyInput): MissingPhotoReport {
  const base: MissingPhotoReport = {
    dead: null,
    rowsChecked: input.rows.length,
    withoutPath: 0,
    refusal: null,
    countsByKind: emptyKinds(),
    countsByShape: emptyShapes(),
    owners: [],
    span: null,
  };

  if (!input.listingComplete) {
    return {
      ...base,
      refusal:
        "a bucket listing did not finish, so an absent path cannot be told from " +
        "an unread one. Nothing is classified.",
    };
  }

  const present = (p: string | null | undefined): boolean => {
    const n = normalizePhotoPath(p, input.bucket);
    return n !== "" && input.presentPaths.has(n);
  };

  const dead: DeadRow[] = [];
  const liveByItem = new Map<string, number>();
  const deadByItem = new Map<string, number>();
  let withoutPath = 0;
  let oldestLive: string | null = null;

  const pending: { row: PhotoRow; kind: MissingKind }[] = [];
  for (const row of input.rows) {
    const hasPhotoPath = normalizePhotoPath(row.storagePath, input.bucket) !== "";
    const hasThumbPath = normalizePhotoPath(row.thumbnailStoragePath, input.bucket) !== "";
    if (!hasPhotoPath && !hasThumbPath) {
      withoutPath++;
      continue;
    }

    const photoAlive = hasPhotoPath && present(row.storagePath);
    const thumbAlive = hasThumbPath && present(row.thumbnailStoragePath);

    // A row with only a full-size path is judged on that alone; the same for a
    // row with only a thumbnail. Calling a missing thumbnail path "dead" would
    // report every row that never had one.
    const photoDead = hasPhotoPath && !photoAlive;
    const thumbDead = hasThumbPath && !thumbAlive;

    if (!photoDead && !thumbDead) {
      liveByItem.set(row.inventoryItemId, (liveByItem.get(row.inventoryItemId) ?? 0) + 1);
      if (row.createdAt && (oldestLive === null || row.createdAt < oldestLive)) {
        oldestLive = row.createdAt;
      }
      continue;
    }

    // ⚠ "the other one survives" requires the other one to EXIST. Most rows
    // carry no thumbnail_storage_path at all, so a dead photo on one of those
    // is `both_gone` -- nothing of it is left. An earlier version read the
    // absence of a thumbnail path as a surviving thumbnail and filed the
    // commonest case under the RECOVERABLE class, where AC5 says the fix is to
    // clear one column. There is no column to clear. The tests caught it.
    const bothRecorded = hasPhotoPath && hasThumbPath;
    const kind: MissingKind = !bothRecorded || (photoDead && thumbDead)
      ? "both_gone"
      : photoDead
      ? "photo_gone_thumb_alive"
      : "thumb_gone_photo_alive";
    pending.push({ row, kind });
    deadByItem.set(row.inventoryItemId, (deadByItem.get(row.inventoryItemId) ?? 0) + 1);
  }

  const owners = [...new Set(pending.map((p) => p.row.ownerUserId).filter((o): o is string => !!o))]
    .sort();
  const everyDeadPredatesLive = oldestLive !== null &&
    pending.length > 0 &&
    pending.every((p) => p.row.createdAt !== null && p.row.createdAt < oldestLive!);

  for (const { row, kind } of pending) {
    let shape: DeadShape;
    if (owners.length > 1 && everyDeadPredatesLive) {
      shape = "older_than_every_live_row";
    } else if (owners.length === 1 && deadByItem.size > 1) {
      shape = "whole_owner";
    } else if ((liveByItem.get(row.inventoryItemId) ?? 0) === 0) {
      shape = "whole_item";
    } else {
      shape = "isolated";
    }
    dead.push({ row, kind, shape, causeHint: CAUSE[shape] });
  }

  const countsByKind = emptyKinds();
  const countsByShape = emptyShapes();
  countsByKind.no_path_recorded = withoutPath;
  for (const d of dead) {
    countsByKind[d.kind]++;
    countsByShape[d.shape]++;
  }

  const stamps = dead.map((d) => d.row.createdAt).filter((s): s is string => !!s).sort();
  return {
    dead,
    rowsChecked: input.rows.length,
    withoutPath,
    refusal: null,
    countsByKind,
    countsByShape,
    owners,
    span: stamps.length > 0
      ? { oldest: stamps[0]!, newest: stamps[stamps.length - 1]! }
      : null,
  };
}

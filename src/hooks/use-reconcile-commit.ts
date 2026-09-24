import { supabase } from "@/lib/supabase";
import { toastWarning } from "@/lib/toast-error";
import { compressImage } from "@/lib/image-utils";
import { advanceItemStatus } from "@/lib/status-writer";
import { REQUIRED_PHOTO_TYPES } from "@/lib/constants";
import type { FlipdeskPhotoType, ItemStatus } from "@/types/database";

/** Statuses a photo-less item can be in and still take a cluster (US-285). */
export const LINKABLE_STATUSES = ["sourced", "cataloged", "drafted"] as const;

// One photo as it goes into a commit. `file` is null for entries restored from
// a persisted session (the blob is gone) — those are skipped with a note.
export interface CommitPhoto {
  id: string;
  file: File | null;
  capturedAt: Date | null;
  photoType: FlipdeskPhotoType;
  // US-2461: the open-text qualifier stored beside the type. Null for a type
  // that takes none. Optional so older callers still compile against this shape.
  photoRole?: string | null;
  // US-289: when the blob is already in storage (iOS-staged), commit references
  // this existing object instead of re-uploading a (missing) in-memory File.
  storagePath?: string | null;
}

export interface CommitCluster {
  clusterId: string;
  /** Human label (e.g. "Item 1") used in the batch-results dialog. */
  label: string;
  photos: CommitPhoto[];
  /** Existing item to attach to; null = create a new draft. */
  linkItemId: string | null;
  /** The item an EARLIER partial commit of this same cluster created. A retry
   *  attaches the leftover photos to it rather than making a second draft.
   *  Unlike linkItemId it may already have photos: they are this cluster's. */
  resumeItemId?: string | null;
  /** Optional title for a newly-created draft. */
  titleHint?: string;
}

// Mirrors pipeline.tsx's BatchResult so the reconcile board can reuse the
// batch-results dialog pattern (no wall of toasts on partial failure).
export interface CommitResult {
  clusterId: string;
  title: string;
  ok: boolean;
  detail: string;
  itemId?: string;
  /** Photos that couldn't be uploaded (e.g. restored placeholders). US-1633:
   * the session is only marked committed when every cluster has zero skips. */
  skipped?: number;
  /** Photos that reached item_photos. */
  saved?: number;
  /** Photos that did not, for any reason. Equal to `skipped`. */
  failed?: number;
  /** Ids of the CommitPhotos that were saved, so the board can drop them and
   * a retry does not upload them twice. */
  savedPhotoIds?: string[];
}

/** Shown when the canvas re-encode fails. The original is never uploaded in
 * its place: it still carries EXIF and GPS, and item-photos is public. */
export const UNCONVERTIBLE_PHOTO_DETAIL =
  "This format couldn't be converted (HEIC?). Export as JPEG and add it again.";

type PhotoOutcome = { saved: true } | { saved: false; detail: string };

function extForBlobType(mimeType: string, fallback: string): string {
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  return fallback;
}

async function uploadOnePhoto(
  itemId: string,
  ownerFolder: string,
  sortOrder: number,
  photo: CommitPhoto,
  sessionId: string | null,
): Promise<PhotoOutcome> {
  // US-289: iOS-staged photo — the blob is already in the item-photos bucket.
  // Reference it directly instead of re-uploading (the in-memory File is gone).
  if (!photo.file && photo.storagePath) {
    const { data: pub } = supabase.storage
      .from("item-photos")
      .getPublicUrl(photo.storagePath);
    const { error: insErr } = await supabase.from("item_photos").insert({
      inventory_item_id: itemId,
      photo_url: pub.publicUrl,
      storage_path: photo.storagePath,
      photo_type: photo.photoType,
      photo_role: photo.photoRole ?? null,
      sort_order: sortOrder,
      captured_at: photo.capturedAt ? photo.capturedAt.toISOString() : null,
      reconcile_session_id: sessionId,
    } as never);
    if (insErr) throw insErr;
    return { saved: true };
  }
  if (!photo.file) {
    // Restored placeholder: the blob did not survive the reload.
    return { saved: false, detail: "The photo didn't survive a reload. Add it again." };
  }

  const file = photo.file;
  let thumbBlob: Blob | null = null;
  let thumbType = "image/webp";

  // The canvas re-encode IS the EXIF/GPS strip for this bucket, so a failure
  // here skips the photo. It used to fall through and upload the original File
  // to the PUBLIC item-photos bucket, location and all, and HEIC on Chrome and
  // Firefox always took that path.
  let main: Awaited<ReturnType<typeof compressImage>>;
  try {
    main = await compressImage(file, 2400, 0.85);
  } catch {
    return { saved: false, detail: UNCONVERTIBLE_PHOTO_DETAIL };
  }
  if (main.blob.size === 0) {
    return { saved: false, detail: UNCONVERTIBLE_PHOTO_DETAIL };
  }
  const body: Blob = main.blob;
  const bodyType = main.blob.type || "image/jpeg";
  const ext = extForBlobType(bodyType, "jpg");
  const width: number | null = main.width;
  const height: number | null = main.height;
  try {
    const thumb = await compressImage(file, 320, 0.7);
    if (thumb.blob.size > 0) {
      thumbBlob = thumb.blob;
      thumbType = thumb.blob.type || "image/webp";
    }
  } catch {
    /* thumbnail optional */
  }

  const ts = Date.now() + sortOrder; // keep paths unique within a cluster
  const path = `${ownerFolder}/${itemId}/${photo.photoType}_${ts}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("item-photos")
    .upload(path, body, { upsert: false, contentType: bodyType || undefined });
  if (upErr) throw upErr;
  const { data: pub } = supabase.storage.from("item-photos").getPublicUrl(path);

  let thumbnailUrl: string | null = null;
  let thumbnailPath: string | null = null;
  if (thumbBlob) {
    thumbnailPath = `${ownerFolder}/${itemId}/thumbs/${photo.photoType}_${ts}.${extForBlobType(thumbType, "webp")}`;
    const { error: thumbErr } = await supabase.storage
      .from("item-photos")
      .upload(thumbnailPath, thumbBlob, { upsert: false, contentType: thumbType });
    if (thumbErr) {
      thumbnailPath = null;
    } else {
      thumbnailUrl = supabase.storage
        .from("item-photos")
        .getPublicUrl(thumbnailPath).data.publicUrl;
    }
  }

  const { error: insErr } = await supabase.from("item_photos").insert({
    inventory_item_id: itemId,
    photo_url: pub.publicUrl,
    storage_path: path,
    photo_type: photo.photoType,
    photo_role: photo.photoRole ?? null,
    sort_order: sortOrder,
    thumbnail_url: thumbnailUrl,
    thumbnail_storage_path: thumbnailPath,
    width,
    height,
    bytes: body.size,
    captured_at: photo.capturedAt ? photo.capturedAt.toISOString() : null,
    reconcile_session_id: sessionId,
  } as never);
  if (insErr) {
    // The object is in storage with no row pointing at it. Remove it, or a
    // retry uploads a second copy and this one sits in a public bucket
    // forever. Best effort: the insert error is the one the seller needs.
    const orphans = [path, ...(thumbnailPath ? [thumbnailPath] : [])];
    await supabase.storage
      .from("item-photos")
      .remove(orphans)
      .catch(() => undefined);
    throw insErr;
  }
  return { saved: true };
}

export async function resolveItemId(
  cluster: CommitCluster,
  workspaceOwnerId: string,
): Promise<{
  itemId: string;
  currentStatus: ItemStatus;
  createdNew: boolean;
  sortStart?: number;
}> {
  if (cluster.resumeItemId) {
    // Ownership is re-checked like a link; the photo rules are not, because
    // the photos it already has came from this cluster a moment ago.
    const { data, error } = await supabase
      .from("items_full")
      .select("id, user_id, status, photo_count")
      .eq("id", cluster.resumeItemId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("The item from the earlier try no longer exists.");
    const row = data as {
      id: string;
      user_id: string;
      status: ItemStatus;
      photo_count: number | null;
    };
    if (row.user_id !== workspaceOwnerId) {
      throw new Error("This item belongs to a different workspace.");
    }
    return {
      itemId: row.id,
      currentStatus: row.status,
      createdNew: false,
      sortStart: row.photo_count ?? 0,
    };
  }
  if (cluster.linkItemId) {
    // Re-verify ownership AND the picker's own rules. RLS admits a workspace
    // member to every workspace they belong to, so a row coming back does not
    // mean it belongs to the workspace on screen; and the picker's list can be
    // a minute old, so the item may have been photographed since.
    const { data, error } = await supabase
      .from("items_full")
      .select("id, user_id, status, photo_count")
      .eq("id", cluster.linkItemId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("That item no longer exists or isn't yours.");
    const row = data as {
      id: string;
      user_id: string;
      status: ItemStatus;
      photo_count: number | null;
    };
    if (row.user_id !== workspaceOwnerId) {
      throw new Error("This item belongs to a different workspace.");
    }
    if (!(LINKABLE_STATUSES as readonly string[]).includes(row.status)) {
      throw new Error("That item has moved past the photo step, so it can't be linked.");
    }
    if ((row.photo_count ?? 0) > 0) {
      throw new Error("That item already has photos, so it can't be linked.");
    }
    return { itemId: row.id, currentStatus: row.status, createdNew: false };
  }

  const { data, error } = await supabase
    .from("inventory_items")
    .insert({
      user_id: workspaceOwnerId,
      title: cluster.titleHint?.trim() || "Untitled item",
      status: "cataloged",
    } as never)
    .select("id, status")
    .single();
  if (error) throw error;
  const row = data as { id: string; status: ItemStatus };
  return { itemId: row.id, currentStatus: row.status, createdNew: true };
}

/**
 * Commits one cluster: create-or-link an inventory item, upload its photos into
 * item_photos (with photo_type, captured_at, reconcile_session_id), and advance
 * the item to `photographed` once the required photo set is present.
 */
async function commitCluster(
  cluster: CommitCluster,
  workspaceOwnerId: string,
  sessionId: string | null,
): Promise<CommitResult> {
  let resolved: Awaited<ReturnType<typeof resolveItemId>>;
  try {
    resolved = await resolveItemId(cluster, workspaceOwnerId);
  } catch (err) {
    return {
      clusterId: cluster.clusterId,
      title: cluster.label,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const { itemId, currentStatus, createdNew } = resolved;
  const total = cluster.photos.length;

  // From here the item EXISTS, so every return carries its id. A photo that
  // throws is counted against this cluster rather than escaping to an outer
  // catch that no longer knew which item it had half-built, which is how a
  // retry used to create the item and upload the photos a second time.
  const savedPhotoIds: string[] = [];
  const savedTypes = new Set<string>();
  const reasons: string[] = [];
  let sort = resolved.sortStart ?? 0;
  for (const photo of cluster.photos) {
    try {
      const out = await uploadOnePhoto(itemId, workspaceOwnerId, sort, photo, sessionId);
      if (out.saved) {
        savedPhotoIds.push(photo.id);
        savedTypes.add(photo.photoType);
      } else {
        reasons.push(out.detail);
      }
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }
    sort += 1;
  }
  const saved = savedPhotoIds.length;
  const failed = total - saved;

  // US-1633: a freshly-created draft that ended up with ZERO uploaded photos
  // (e.g. every photo was a restored placeholder) is an orphan — delete it and
  // report failure instead of leaving an empty draft littering the pipeline.
  if (createdNew && saved === 0) {
    // US-3376: checked. The whole point of this delete is that an empty draft
    // does not litter the pipeline, and dropping its result meant that on a
    // refusal one did anyway, while the results dialog said only "re-add the
    // photos" and never mentioned the draft now sitting in Inventory.
    const { error: deleteErr } = await supabase
      .from("inventory_items")
      .delete()
      .eq("id", itemId)
      .eq("user_id", workspaceOwnerId);
    const why = reasons[0] ? ` ${reasons[0]}` : "";
    return {
      clusterId: cluster.clusterId,
      title: cluster.label,
      ok: false,
      skipped: failed,
      saved: 0,
      failed,
      savedPhotoIds: [],
      // Only when the draft is still there: a deleted id is nothing to link to.
      itemId: deleteErr ? itemId : undefined,
      detail: deleteErr
        ? "No photos could be uploaded, and the empty draft this created could not be removed. Delete it from Inventory, then re-add the photos."
        : `No photos could be uploaded, so re-add them and try again.${why}`,
    };
  }

  // Advance to "photographed" only when the required set is really there:
  // the types that UPLOADED here, plus whatever a linked item already had. A
  // skipped front photo does not count as a front photo.
  const presentTypes = new Set<string>(savedTypes);
  if (!createdNew) {
    const { data: existing, error: existingErr } = await supabase
      .from("item_photos")
      .select("photo_type")
      .eq("inventory_item_id", itemId);
    if (!existingErr) {
      for (const r of (existing ?? []) as { photo_type: string }[]) {
        presentTypes.add(r.photo_type);
      }
    }
  }
  const requiredComplete = REQUIRED_PHOTO_TYPES.every((t) => presentTypes.has(t));
  let statusNote = "";
  if (requiredComplete) {
    try {
      await advanceItemStatus(itemId, currentStatus, "photographed");
    } catch {
      statusNote = " The photos are saved, but the item couldn't be moved to Photographed.";
    }
  }

  const detail =
    (failed > 0
      ? `${saved} of ${total} photos saved. ${reasons[0] ?? "Re-add the rest."}`
      : `${saved} photo${saved === 1 ? "" : "s"} → ${cluster.linkItemId || cluster.resumeItemId ? "linked item" : "new draft"}`) +
    statusNote;
  return {
    clusterId: cluster.clusterId,
    title: cluster.label,
    ok: failed === 0,
    detail,
    itemId,
    skipped: failed,
    saved,
    failed,
    savedPhotoIds,
  };
}

/**
 * Commits every cluster, then marks the session committed. Per-cluster failures
 * are returned (not thrown) so the UI can show a batch-results summary; the
 * session is only marked committed if at least one cluster succeeded.
 */
export async function commitClusters(
  clusters: CommitCluster[],
  workspaceOwnerId: string,
  sessionId: string | null,
  opts: {
    /** Photos are being left on the board (unsorted ones the seller chose not
     *  to save), so the session must stay open to bring them back. */
    keepSessionOpen?: boolean;
  } = {},
): Promise<CommitResult[]> {
  const results: CommitResult[] = [];
  for (const cluster of clusters) {
    results.push(await commitCluster(cluster, workspaceOwnerId, sessionId));
  }
  // US-1633: only mark the session committed when EVERY cluster fully succeeded
  // with no skipped photos. Previously any single ok cluster committed the whole
  // session, so a partial run (failed clusters / skipped photos) could no longer
  // be retried — those photos were orphaned. Leaving it open lets the user
  // re-commit the incomplete clusters.
  const fullyCommitted =
    results.length > 0 && results.every((r) => r.ok && (r.skipped ?? 0) === 0);
  if (sessionId && fullyCommitted && !opts.keepSessionOpen) {
    // US-3376, same shape as the orphan delete above. A dropped failure here
    // leaves a fully-committed session looking un-committed, so the board offers
    // Commit again and a second press duplicates every item it just created.
    const { error } = await supabase
      .from("flipdesk_reconcile_sessions")
      .update({ status: "committed" } as never)
      .eq("id", sessionId);
    if (error) {
      toastWarning(error, "Your items were committed, but this session still looks open.", {
        action: "close reconcile session",
        duration: 12_000,
        nextStep: "Don't press Commit again, or you will create the items twice.",
      });
    }
  }
  return results;
}

import { supabase } from "@/lib/supabase";
import { compressImage } from "@/lib/image-utils";
import { advanceItemStatus } from "@/lib/status-writer";
import { REQUIRED_PHOTO_TYPES } from "@/lib/constants";
import type { FlipdeskPhotoType, ItemStatus } from "@/types/database";

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
}

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
): Promise<boolean> {
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
    return true;
  }
  if (!photo.file) return false; // restored placeholder — nothing to upload

  const file = photo.file;
  let body: Blob = file;
  let bodyType = file.type || "image/jpeg";
  let ext = extForBlobType(bodyType, "jpg");
  let width: number | null = null;
  let height: number | null = null;
  let thumbBlob: Blob | null = null;
  let thumbType = "image/webp";

  try {
    const main = await compressImage(file, 2400, 0.85);
    if (main.blob.size > 0) {
      body = main.blob;
      bodyType = main.blob.type || bodyType;
      ext = extForBlobType(bodyType, ext);
      width = main.width;
      height = main.height;
      try {
        const thumb = await compressImage(file, 320, 0.7);
        if (thumb.blob.size > 0) {
          thumbBlob = thumb.blob;
          thumbType = thumb.blob.type || "image/webp";
        }
      } catch {
        /* thumbnail optional */
      }
    }
  } catch {
    /* fall back to the original file */
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
  if (insErr) throw insErr;
  return true;
}

async function resolveItemId(
  cluster: CommitCluster,
  workspaceOwnerId: string,
): Promise<{ itemId: string; currentStatus: ItemStatus; createdNew: boolean }> {
  if (cluster.linkItemId) {
    // Re-verify ownership: RLS only returns rows the caller owns, so a missing
    // row here means it isn't theirs (or doesn't exist).
    const { data, error } = await supabase
      .from("inventory_items")
      .select("id, status")
      .eq("id", cluster.linkItemId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("That item no longer exists or isn't yours.");
    const row = data as { id: string; status: ItemStatus };
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
  try {
    const { itemId, currentStatus, createdNew } = await resolveItemId(cluster, workspaceOwnerId);

    let uploaded = 0;
    let skipped = 0;
    let sort = 0;
    for (const photo of cluster.photos) {
      const ok = await uploadOnePhoto(itemId, workspaceOwnerId, sort, photo, sessionId);
      if (ok) uploaded += 1;
      else skipped += 1;
      sort += 1;
    }

    // US-1633: a freshly-created draft that ended up with ZERO uploaded photos
    // (e.g. every photo was a restored placeholder) is an orphan — delete it and
    // report failure instead of leaving an empty draft littering the pipeline.
    if (createdNew && uploaded === 0) {
      await supabase
        .from("inventory_items")
        .delete()
        .eq("id", itemId)
        .eq("user_id", workspaceOwnerId);
      return {
        clusterId: cluster.clusterId,
        title: cluster.label,
        ok: false,
        skipped,
        detail: "No photos could be uploaded — re-add them and try again.",
      };
    }

    // Advance to "photographed" if the required set is satisfied (consider both
    // the freshly-uploaded types and any the linked item already had).
    const presentTypes = new Set(cluster.photos.map((p) => p.photoType));
    const requiredComplete = REQUIRED_PHOTO_TYPES.every((t) => presentTypes.has(t));
    if (requiredComplete) {
      await advanceItemStatus(itemId, currentStatus, "photographed");
    }

    const detail =
      skipped > 0
        ? `${uploaded} uploaded, ${skipped} skipped (re-add those photos)`
        : `${uploaded} photo${uploaded === 1 ? "" : "s"} → ${cluster.linkItemId ? "linked item" : "new draft"}`;
    return { clusterId: cluster.clusterId, title: cluster.label, ok: true, detail, itemId, skipped };
  } catch (err) {
    return {
      clusterId: cluster.clusterId,
      title: cluster.label,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
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
  if (sessionId && fullyCommitted) {
    await supabase
      .from("flipdesk_reconcile_sessions")
      .update({ status: "committed" } as never)
      .eq("id", sessionId);
  }
  return results;
}

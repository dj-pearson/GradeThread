// US-534 / US-535 / US-536: the workbench's per-photo tools, moved unchanged
// out of autolister.tsx (which sits at a shrink-only line ceiling). Each
// re-stages the processed image through the validated server upload, keeps
// the staged id so grouping survives, and snapshots `original` for undo.
import { useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { processStagedImage } from "@/lib/image-worker-pool";
import { autoEnhance, type EnhanceStats } from "@/lib/image-enhance";
import {
  backgroundRemovalMessage,
  removeImageBackground,
  type BgMode,
} from "@/lib/background-removal";
import {
  type StagedPhoto,
  type StagedUploadResult,
  uploadStagingPhoto,
} from "@/stores/autolister-upload-store";
import { discardStagedObjects } from "./discard-staged-objects";

export function usePhotoTools({
  ownerId,
  sessionId,
  staged,
  setStaged,
  stagedById,
  groups,
  ungrouped,
}: {
  ownerId: string | null;
  sessionId: string;
  staged: StagedPhoto[];
  setStaged: Dispatch<SetStateAction<StagedPhoto[]>>;
  stagedById: ReadonlyMap<string, StagedPhoto>;
  groups: readonly { photoIds: string[]; coverId: string }[];
  ungrouped: readonly StagedPhoto[];
}) {
  // US-535: photos currently being segmented, a batch-busy flag, and one-time
  // model-download progress.
  const [bgProcessing, setBgProcessing] = useState<Set<string>>(new Set());
  const [bgBusy, setBgBusy] = useState(false);
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  // US-536: photos currently being auto-enhanced, and a batch-busy flag.
  const [enhancing, setEnhancing] = useState<Set<string>>(new Set());
  const [enhanceBusy, setEnhanceBusy] = useState(false);

  // Upload a processed image under a fresh storage key and swap it into the
  // staged photo, snapshotting the previous image into `original` for one-tap
  // revert. Keeps the staged id + capture time so grouping/order survive.
  async function restageProcessed(
    photoId: string,
    processed: {
      full: Blob;
      thumb: Blob;
      width: number;
      height: number;
      contentType: string;
      ext: string;
    },
  ): Promise<boolean> {
    if (!ownerId) return false;
    const existing = stagedById.get(photoId);
    if (!existing) return false;

    // US-529: re-staged (enhanced/bg-removed) images go through the same
    // validated server upload as fresh ones.
    let up: StagedUploadResult;
    try {
      up = await uploadStagingPhoto(
        sessionId,
        processed.full,
        processed.thumb,
      );
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[autolister] restage upload failed:", err);
      return false;
    }

    const original = existing.original ?? {
      url: existing.url,
      storagePath: existing.storagePath,
      thumbnailUrl: existing.thumbnailUrl,
      thumbnailStoragePath: existing.thumbnailStoragePath,
      width: existing.width,
      height: existing.height,
      bytes: existing.bytes,
      phash: existing.phash,
    };
    const orphans = existing.original
      ? [existing.storagePath, existing.thumbnailStoragePath].filter(
          (p): p is string => !!p,
        )
      : [];
    setStaged((prev) =>
      prev.map((p) =>
        p.id === photoId
          ? {
              ...p,
              url: up.url,
              storagePath: up.storagePath,
              thumbnailUrl: up.thumbnailUrl,
              thumbnailStoragePath: up.thumbnailStoragePath,
              width: processed.width,
              height: processed.height,
              bytes: up.bytes,
              phash: "",
              original,
            }
          : p,
      ),
    );
    // US-3389: reported, not surfaced. The re-stage already succeeded.
    void discardStagedObjects(orphans, "re-stage processed photo");
    return true;
  }

  // US-535: run on-device segmentation on one staged photo and swap in the
  // cleaned result (studio-white or transparent). Keeps the staged id + capture
  // time so grouping/order survive, snapshots the previous image into `original`
  // for one-tap undo, writes a fresh storage key, and drops the replaced object.
  // The cleaned image flows into BOTH the AI input and the published listing.
  async function applyBgToPhoto(photoId: string, mode: BgMode): Promise<boolean> {
    if (!ownerId) return false;
    const existing = stagedById.get(photoId);
    if (!existing) return false;

    setBgProcessing((prev) => new Set(prev).add(photoId));
    try {
      const srcBlob = await (await fetch(existing.url)).blob();
      const processed = await removeImageBackground(srcBlob, mode, (f) =>
        setModelProgress(f < 1 ? f : null),
      );
      setModelProgress(null);
      const ok = await restageProcessed(photoId, processed);
      if (!ok) {
        toast.error("Could not save cleaned photo.");
        return false;
      }
      return true;
    } catch (err) {
      setModelProgress(null);
      // US-3069: a missing on-device model is not a failed removal.
      toastError(err, backgroundRemovalMessage(err));
      return false;
    } finally {
      setBgProcessing((prev) => {
        const next = new Set(prev);
        next.delete(photoId);
        return next;
      });
    }
  }

  // US-536: auto-enhance one photo. A `reference` (a group's cover stats) gives
  // every photo of an item the same white-point/exposure.
  async function enhancePhoto(
    photoId: string,
    reference?: EnhanceStats,
  ): Promise<EnhanceStats | null> {
    const existing = stagedById.get(photoId);
    if (!existing) return null;
    setEnhancing((prev) => new Set(prev).add(photoId));
    try {
      const srcBlob = await (await fetch(existing.url)).blob();
      const { image, stats } = await autoEnhance(srcBlob, reference);
      const ok = await restageProcessed(photoId, image);
      if (!ok) {
        toast.error("Could not save enhanced photo.");
        return null;
      }
      return stats;
    } catch (err) {
      toastError(err, "Auto-enhance failed.");
      return null;
    } finally {
      setEnhancing((prev) => {
        const next = new Set(prev);
        next.delete(photoId);
        return next;
      });
    }
  }

  // US-535: restore the pre-cleanup original and drop the cleaned objects.
  function undoBg(photoId: string) {
    const existing = stagedById.get(photoId);
    if (!existing?.original) return;
    const o = existing.original;
    const orphans = [existing.storagePath, existing.thumbnailStoragePath].filter(
      (p): p is string => !!p,
    );
    setStaged((prev) =>
      prev.map((p) =>
        p.id === photoId
          ? {
              ...p,
              url: o.url,
              storagePath: o.storagePath,
              thumbnailUrl: o.thumbnailUrl,
              thumbnailStoragePath: o.thumbnailStoragePath,
              width: o.width,
              height: o.height,
              bytes: o.bytes,
              phash: o.phash,
              original: undefined,
            }
          : p,
      ),
    );
    // US-3389: reported, not surfaced. The undo itself succeeded.
    void discardStagedObjects(orphans, "undo background removal");
  }

  // US-534: persist an edited photo (crop/rotate/straighten) by re-running the
  // SAME stage pipeline as upload — compress → thumbnail → dHash → upload — so
  // the edit feeds BOTH the AI input and the published image. Keeps the staged
  // id + capture time so grouping/order/roles survive; writes a fresh storage
  // key (avoids CDN-caching a reused URL) and cleans up the replaced objects.
  async function replacePhotoWithBlob(photoId: string, blob: Blob): Promise<void> {
    if (!ownerId) return;
    const existing = stagedById.get(photoId);
    if (!existing) return;
    const file = new File([blob], "edited.jpg", { type: blob.type || "image/jpeg" });

    let body: Blob = file;
    let width: number | null = null;
    let height: number | null = null;
    let phash = "";
    let thumbBlob: Blob | null = null;
    try {
      // US-539: same off-thread worker pipeline as fresh uploads.
      const out = await processStagedImage(file, {
        maxWidth: 2400,
        quality: 0.85,
        thumbWidth: 320,
        thumbQuality: 0.7,
      });
      body = out.blob;
      width = out.width;
      height = out.height;
      phash = out.phash;
      thumbBlob = out.thumbBlob;
    } catch (compErr) {
      if (import.meta.env.DEV) console.warn("[autolister] edit compress failed, using edited blob:", compErr);
    }

    // US-529: edits re-land through the validated server upload too — even the
    // compress-failure fallback gets its metadata stripped server-side.
    let up: StagedUploadResult;
    try {
      up = await uploadStagingPhoto(sessionId, body, thumbBlob);
    } catch (err) {
      toastError(err, "Could not save edit.");
      throw err;
    }

    const orphans = [existing.storagePath, existing.thumbnailStoragePath].filter(
      (p): p is string => !!p,
    );
    setStaged((prev) =>
      prev.map((p) =>
        p.id === photoId
          ? {
              ...p,
              url: up.url,
              storagePath: up.storagePath,
              thumbnailUrl: up.thumbnailUrl,
              thumbnailStoragePath: up.thumbnailStoragePath,
              width: width ?? up.width,
              height: height ?? up.height,
              bytes: up.bytes,
              phash,
            }
          : p,
      ),
    );

    // Drop the replaced objects so staging doesn't accumulate them. US-3389:
    // reported, not surfaced. The edit is already saved and on screen.
    void discardStagedObjects(orphans, "replace staged photo with an edit");
    toast.success("Photo updated.");
  }

  // US-535: one tap to clean every not-yet-cleaned staged photo. Sequential —
  // segmentation is heavy and parallel runs would thrash memory on mobile.
  async function applyBgToAll(mode: BgMode) {
    if (bgBusy) return;
    const targets = staged.filter((p) => !p.original);
    if (targets.length === 0) {
      toast.info("Every photo already has a clean background.");
      return;
    }
    setBgBusy(true);
    try {
      let ok = 0;
      for (const p of targets) {
        if (await applyBgToPhoto(p.id, mode)) ok++;
      }
      if (ok > 0) {
        toast.success(
          `Cleaned ${ok} photo${ok === 1 ? "" : "s"} onto ${mode === "white" ? "studio white" : "a transparent background"}.`,
        );
      }
    } finally {
      setBgBusy(false);
    }
  }

  // US-536: one tap to enhance the whole batch. For each GROUP the cover is
  // enhanced first and its stats are reused for the rest.
  async function enhanceAll() {
    if (enhanceBusy) return;
    if (staged.every((p) => !!p.original)) {
      toast.info("Every photo is already enhanced.");
      return;
    }
    setEnhanceBusy(true);
    try {
      let ok = 0;
      for (const g of groups) {
        const members = g.photoIds
          .map((id) => stagedById.get(id))
          .filter((p): p is StagedPhoto => !!p && !p.original);
        if (members.length === 0) continue;
        const coverId =
          members.find((m) => m.id === g.coverId)?.id ?? members[0]!.id;
        const stats = await enhancePhoto(coverId);
        if (stats) ok++;
        for (const m of members) {
          if (m.id === coverId) continue;
          if (await enhancePhoto(m.id, stats ?? undefined)) ok++;
        }
      }
      for (const p of ungrouped) {
        if (p.original) continue;
        if (await enhancePhoto(p.id)) ok++;
      }
      if (ok > 0) {
        toast.success(`Auto-enhanced ${ok} photo${ok === 1 ? "" : "s"}.`);
      }
    } finally {
      setEnhanceBusy(false);
    }
  }

  return {
    bgProcessing,
    bgBusy,
    modelProgress,
    enhancing,
    enhanceBusy,
    applyBgToPhoto,
    enhancePhoto,
    undoBg,
    replacePhotoWithBlob,
    applyBgToAll,
    enhanceAll,
  };
}

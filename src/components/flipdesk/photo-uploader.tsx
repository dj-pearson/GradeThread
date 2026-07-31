import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  Trash2,
  Loader2,
  Check,
  Camera,
  Pencil,
  ImagePlus,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { PhotoEditorDialog } from "@/components/flipdesk/photo-editor-dialog";
import { PHOTO_TYPE_LABELS } from "@/lib/constants";
import { usePhotoProfile } from "@/lib/photo-profiles";
import { advanceItemStatus } from "@/lib/status-writer";
import { nextUploadSortOrder } from "@/lib/photo-order";
import { compressImage } from "@/lib/image-utils";
import {
  assessMacroPhoto,
  measureMacroPhoto,
  uploadMaxWidthFor,
  type MacroQualityAssessment,
} from "@/lib/macro-photo-quality";
import { normalizeToImageFile } from "@/lib/media-intake";
import { ItemPhotoImg } from "@/components/flipdesk/item-photo-img";
import {
  useItemPhotoDisplayUrl,
  useItemPhotoOriginalUrl,
} from "@/hooks/use-item-photo-url";
import { persistPhotoEdit, revertPhotoEdit } from "@/lib/photo-mutations";
import {
  parseEditRecipe,
  type PhotoEditRecipe,
} from "@/lib/photo-edit-recipe";
import { cn } from "@/lib/utils";
import type {
  ItemPhotoRow,
  FlipdeskPhotoType,
  ItemCategory,
  ItemStatus,
} from "@/types/database";

function extOf(file: File): string {
  const m = file.name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1]!.toLowerCase() : "jpg";
}

function extForBlobType(mimeType: string, fallback: string): string {
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return fallback;
}

export function PhotoUploader({
  itemId,
  currentStatus,
  category,
  onChange,
}: {
  itemId: string;
  currentStatus?: ItemStatus;
  /**
   * item_category — drives which photo slots/labels are shown via the photo
   * profile. Defaults to the clothing profile when null/undefined so existing
   * clothing flows are unchanged.
   */
  category?: ItemCategory | null;
  /**
   * Fired after the item's photo set actually changes (a successful upload,
   * delete, or in-place edit). Lets a host (e.g. the AutoLister cockpit dialog)
   * know it should re-run photo QA / refresh indicators only when something
   * really changed — an open-then-close with no edits fires nothing.
   */
  onChange?: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId } = useWorkspace();
  const qc = useQueryClient();
  const [uploading, setUploading] = useState<FlipdeskPhotoType | null>(null);
  const [editingPhoto, setEditingPhoto] = useState<ItemPhotoRow | null>(null);
  // Bulk-add progress: {done,total} while a multi-select batch is uploading,
  // null otherwise. Drives the button label/spinner and disables re-picking.
  const [bulkBusy, setBulkBusy] = useState<{ done: number; total: number } | null>(
    null,
  );
  const bulkInputRef = useRef<HTMLInputElement>(null);

  // Category-driven photo slots. Required roles gate the "photographed" status;
  // optional roles are extra coverage. Both come from the (cached) profile.
  const profile = usePhotoProfile(category ?? null);
  const requiredRoles = profile.roles.filter((r) => r.required);
  const optionalRoles = profile.roles.filter((r) => !r.required);
  const requiredTypes = requiredRoles.map((r) => r.type);
  const labelFor = (t: FlipdeskPhotoType): string =>
    profile.roles.find((r) => r.type === t)?.label ?? PHOTO_TYPE_LABELS[t];

  const { data: photos = [], isLoading } = useQuery({
    queryKey: ["item_photos", itemId],
    queryFn: async (): Promise<ItemPhotoRow[]> => {
      const { data, error } = await supabase
        .from("item_photos")
        .select("*")
        .eq("inventory_item_id", itemId)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ItemPhotoRow[];
    },
  });

  const byType = (t: FlipdeskPhotoType) =>
    photos.filter((p) => p.photo_type === t);

  // The shared upload core — normalize → compress → store → thumbnail → insert
  // one photo row. Takes an explicit `sortOrder` so the bulk path can sequence a
  // whole batch deterministically without waiting for the query cache to refresh
  // between files. Returns the original + stored byte sizes for the caller's
  // "saved N%" note. Throws on failure; callers own the toast + status advance.
  async function processAndUpload(
    picked: File,
    photoType: FlipdeskPhotoType,
    sortOrder: number,
  ): Promise<{
    originalSize: number;
    storedSize: number;
    macro: MacroQualityAssessment;
  }> {
    if (!user) throw new Error("You must be signed in.");
    // US-1300: normalize odd iPhone inputs first — a Live Photo exported as a
    // .mov/.mp4 video becomes a still JPEG frame and HEIC/HEIF becomes JPEG, so
    // the canvas compress/upload path below gets a decodable image.
    const file = await normalizeToImageFile(picked);

    // Compress + strip EXIF client-side via canvas re-encode. Falls back
    // to the original file if decode fails (e.g. HEIC in Chrome), so
    // iOS users who pick a HEIC photo still upload successfully — iOS
    // Safari does this conversion natively at the file-input layer in
    // most cases anyway.
    const originalSize = file.size;
    let body: Blob = file;
    let bodyType = file.type;
    let ext = extOf(file);
    let width: number | null = null;
    let height: number | null = null;
    let thumbBlob: Blob | null = null;
    let thumbType = "image/webp";
    try {
      // US-2135: macro slots keep more pixels than a general condition photo.
      // Non-macro slots get the unchanged 2400 default — AC5 is explicit that
      // the increase must NOT be global, because the upload-speed tradeoff that
      // motivated the low cap is real on mobile data.
      const main = await compressImage(file, uploadMaxWidthFor(photoType), 0.85);
      // Always prefer the canvas-baked output: compressImage applies EXIF
      // orientation to the PIXELS (upright) and strips metadata, so the
      // stored image renders the right way up everywhere — including eBay,
      // which ignores EXIF orientation tags. Falling back to the original
      // only to dodge a marginally larger file would re-introduce
      // sideways/upside-down photos, so correctness wins over a few KB.
      if (main.blob.size > 0) {
        body = main.blob;
        bodyType = main.blob.type || "image/webp";
        ext = extForBlobType(bodyType, ext);
      }
      width = main.width;
      height = main.height;

      // Thumbnail — 320w is the sweet spot for grid views and avatar-sized
      // previews. Quality 0.7 because perceptual quality at that size is
      // already saturated. Same canvas pipeline = same EXIF-stripped result.
      try {
        const thumb = await compressImage(file, 320, 0.7);
        if (thumb.blob.size > 0) {
          thumbBlob = thumb.blob;
          thumbType = thumb.blob.type || "image/webp";
        }
      } catch (thumbErr) {
        // US-1487: expected best-effort fallback — don't log unconditionally
        // in production (US-784).
        if (import.meta.env.DEV) {
          console.warn("[photo-uploader] thumbnail gen failed:", thumbErr);
        }
      }
    } catch (compressErr) {
      if (import.meta.env.DEV) {
        console.warn(
          "[photo-uploader] compress failed, uploading original:",
          compressErr,
        );
      }
    }

    // Millisecond timestamp alone collides when a bulk batch uploads several
    // files of the SAME assigned type in the same tick; a short random suffix
    // keeps every storage path (and thus the upsert:false insert) unique.
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);
    const ownerFolder = workspaceOwnerId ?? user.id;
    const path = `${ownerFolder}/${itemId}/${photoType}_${ts}_${rand}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("item-photos")
      .upload(path, body, {
        upsert: false,
        contentType: bodyType || undefined,
      });
    if (upErr) throw upErr;

    const { data: pub } = supabase.storage.from("item-photos").getPublicUrl(path);

    // Best-effort thumbnail upload. If it fails, we still have the full
    // image — frontend falls back to photo_url via `thumbnail_url ?? photo_url`.
    let thumbnailUrl: string | null = null;
    let thumbnailPath: string | null = null;
    if (thumbBlob) {
      thumbnailPath = `${ownerFolder}/${itemId}/thumbs/${photoType}_${ts}_${rand}.${extForBlobType(thumbType, "webp")}`;
      const { error: thumbUpErr } = await supabase.storage
        .from("item-photos")
        .upload(thumbnailPath, thumbBlob, {
          upsert: false,
          contentType: thumbType,
        });
      if (thumbUpErr) {
        if (import.meta.env.DEV) {
          console.warn(
            "[photo-uploader] thumbnail upload failed:",
            thumbUpErr.message,
          );
        }
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
      photo_type: photoType,
      // Canonical default order: Front → Back → Tag → Detail … so the
      // listing's photo order (and eBay cover) is sensible without any
      // manual drag. A later reorder densifies sort_order and wins.
      sort_order: sortOrder,
      thumbnail_url: thumbnailUrl,
      thumbnail_storage_path: thumbnailPath,
      width,
      height,
      bytes: body.size,
    } as never);
    if (insErr) throw insErr;

    // US-2136: assess the macro slots (tag, serial, marking, surface, …) on the
    // bytes we actually stored, not the camera original — compressImage caps at
    // 2400px, so a distant serial shot can arrive fine and be stored soft. The
    // seller is nudged AFTER the upload rather than blocked before it: Claude
    // Vision reads a marginal photo better than any client-side check, and a
    // false "retake this" is what teaches sellers to ignore the nudge.
    const macro = assessMacroPhoto(await measureMacroPhoto(body, photoType));

    return { originalSize, storedSize: body.size, macro };
  }

  // After a batch of one or more new photos of `newTypes`, advance the item to
  // "photographed" if the required set is now complete, and refresh the caches.
  async function afterPhotosChanged(newTypes: FlipdeskPhotoType[]) {
    const typesAfter = new Set(
      photos.map((p) => p.photo_type).concat(newTypes),
    );
    const requiredNowComplete = requiredTypes.every((t) => typesAfter.has(t));
    if (requiredNowComplete && currentStatus) {
      const advanced = await advanceItemStatus(
        itemId,
        currentStatus,
        "photographed",
      );
      if (advanced) await qc.invalidateQueries({ queryKey: ["items_full"] });
    }
    await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
    onChange?.();
  }

  async function upload(picked: File, photoType: FlipdeskPhotoType) {
    if (!user) return;
    setUploading(photoType);
    try {
      const { originalSize, storedSize, macro } = await processAndUpload(
        picked,
        photoType,
        nextUploadSortOrder(photos, photoType),
      );
      await afterPhotosChanged([photoType]);
      const savedPct = ((1 - storedSize / originalSize) * 100).toFixed(0);
      const sizeNote =
        storedSize < originalSize && originalSize > 100 * 1024
          ? ` (−${savedPct}%, ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(storedSize / 1024 / 1024).toFixed(1)}MB)`
          : "";
      toast.success(`${labelFor(photoType)} photo uploaded${sizeNote}.`);
      // Separate toast, not appended to the success line: the upload DID
      // succeed, and the nudge is a different message with a different action.
      if (macro.message) toast.warning(macro.message);
    } catch (err) {
      toast.error(
        `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setUploading(null);
    }
  }

  // Bulk add: take everything the seller picked in one go, auto-assign a
  // sensible starting tag, and upload the batch — so photographing no longer
  // means clicking a slot per shot. Each photo lands with a provisional tag the
  // seller corrects below (PhotoManager's per-photo tag dropdown); we don't try
  // to guess the real role from pixels. The first files fill any UNFILLED
  // required slots in canonical order (front, back … so the required-set /
  // "photographed" advance still fires); the rest come in as "detail", which
  // is listable and holds any number of photos.
  async function bulkUpload(files: File[]) {
    if (!user || files.length === 0) return;
    // Which required roles still have no photo — the batch fills these first.
    const openRequired = requiredTypes.filter((t) => byType(t).length === 0);
    // Running tally per type so each file of the same assigned type gets the
    // next sort_order without re-reading the (not-yet-refreshed) query cache.
    const working: { photo_type: FlipdeskPhotoType }[] = photos.map((p) => ({
      photo_type: p.photo_type,
    }));

    setBulkBusy({ done: 0, total: files.length });
    const assigned: FlipdeskPhotoType[] = [];
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      const photoType: FlipdeskPhotoType = openRequired[i] ?? "detail";
      const sortOrder = nextUploadSortOrder(working, photoType);
      try {
        await processAndUpload(files[i]!, photoType, sortOrder);
        working.push({ photo_type: photoType });
        assigned.push(photoType);
      } catch (err) {
        failed += 1;
        if (import.meta.env.DEV) {
          console.warn(`[photo-uploader] bulk item ${i} failed:`, err);
        }
      }
      setBulkBusy({ done: i + 1, total: files.length });
    }

    if (assigned.length > 0) await afterPhotosChanged(assigned);
    setBulkBusy(null);

    if (assigned.length > 0 && failed === 0) {
      toast.success(
        `Added ${assigned.length} photo${assigned.length === 1 ? "" : "s"}.`,
        { description: "Set the correct tag for each one below." },
      );
    } else if (assigned.length > 0) {
      toast.warning(
        `Added ${assigned.length} of ${files.length} photos — ${failed} failed.`,
        { description: "Set the correct tag for each one below." },
      );
    } else {
      toast.error("None of the selected photos could be uploaded.");
    }
  }

  async function remove(photo: ItemPhotoRow) {
    try {
      const paths = [photo.storage_path, photo.thumbnail_storage_path].filter(
        (p): p is string => !!p,
      );
      if (paths.length > 0) {
        await supabase.storage.from("item-photos").remove(paths);
      }
      const { error } = await supabase
        .from("item_photos")
        .delete()
        .eq("id", photo.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
      // Deleting a photo can change the cover; the Listings table cover keys
      // under the ["items_full", …] prefix, so refresh it too.
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      onChange?.();
    } catch (err) {
      toast.error(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const requiredFilled = requiredTypes.every((t) => byType(t).length > 0);

  // See the matching note in photo-manager: rendering from the original is only
  // safe when a recipe fully describes the current image.
  const editingRecipe = editingPhoto
    ? parseEditRecipe(editingPhoto.edit_recipe)
    : null;
  // US-2273: same private-bucket split as photo-manager — an iOS Garment Tag
  // has no public photo_url, so a hardcoded item-photos URL opened the editor
  // on a broken image.
  const editingSrc = useItemPhotoDisplayUrl(editingPhoto ?? {}, { full: true });
  const editingOriginal = useItemPhotoOriginalUrl(
    editingPhoto && editingRecipe ? editingPhoto : null,
  );

  async function refreshAfterPhotoWrite() {
    await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
    // A rotate/edit changes the cover image; refresh the Listings cover too.
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    onChange?.();
  }

  // US-2208: shared with PhotoManager via photo-mutations, so an edit made here
  // preserves the original and records its recipe exactly as one made there.
  async function saveEdit(blob: Blob, recipe: PhotoEditRecipe) {
    if (!editingPhoto) return;
    try {
      await persistPhotoEdit(supabase, editingPhoto, blob, recipe);
    } catch (err) {
      toast.error(
        `Couldn't save the edit: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    await refreshAfterPhotoWrite();
    toast.success("Photo updated.");
    setEditingPhoto(null);
  }

  async function revertEdit() {
    if (!editingPhoto) return;
    await revertPhotoEdit(supabase, editingPhoto);
    await refreshAfterPhotoWrite();
    toast.success("Photo restored to the original.");
    setEditingPhoto(null);
  }

  if (isLoading) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        Loading photos…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-muted-foreground">{profile.label}</span>
        {requiredFilled ? (
          <Badge variant="default" className="gap-1">
            <Check className="h-3 w-3" />
            Required set complete
          </Badge>
        ) : (
          <Badge variant="secondary">
            {requiredTypes.filter((t) => byType(t).length > 0).length}/
            {requiredTypes.length} required photos
          </Badge>
        )}
      </div>

      {/* Bulk add — pick every photo for this item at once instead of filling
          one slot at a time. They come in with a provisional tag (unfilled
          required slots first, then Detail) that you correct per-photo below. */}
      <div>
        <input
          ref={bulkInputRef}
          type="file"
          multiple
          accept="image/*,.heic,.heif,video/*,.mov,.mp4,.m4v"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) void bulkUpload(files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          className="w-full border-dashed"
          disabled={bulkBusy != null}
          onClick={() => bulkInputRef.current?.click()}
        >
          {bulkBusy ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Uploading {bulkBusy.done}/{bulkBusy.total}…
            </>
          ) : (
            <>
              <ImagePlus className="mr-2 h-4 w-4" />
              Add photos — pick them all, tag below
            </>
          )}
        </Button>
      </div>

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Required
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {requiredRoles.map((r) => (
            <PhotoSlot
              key={r.type}
              label={r.label}
              hint={r.hint}
              photos={byType(r.type)}
              uploading={uploading === r.type}
              onUpload={(f) => upload(f, r.type)}
              onRemove={remove}
              onEdit={setEditingPhoto}
              required
            />
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Optional
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {optionalRoles.map((r) => (
            <PhotoSlot
              key={r.type}
              label={r.label}
              hint={r.hint}
              photos={byType(r.type)}
              uploading={uploading === r.type}
              onUpload={(f) => upload(f, r.type)}
              onRemove={remove}
              onEdit={setEditingPhoto}
            />
          ))}
        </div>
      </div>

      <PhotoEditorDialog
        open={editingPhoto != null}
        src={editingSrc.url}
        originalSrc={editingOriginal}
        initialRecipe={editingRecipe}
        onRevert={editingPhoto?.original_storage_path ? revertEdit : undefined}
        // Grading evidence keeps the tone it was graded from — see the prop's
        // note on PhotoEditorDialog. Geometry edits stay available.
        allowToneEdits={!editingPhoto?.used_for_grading}
        onClose={() => setEditingPhoto(null)}
        onSave={saveEdit}
      />
    </div>
  );
}

function PhotoSlot({
  label,
  hint,
  photos,
  uploading,
  onUpload,
  onRemove,
  onEdit,
  required = false,
}: {
  label: string;
  hint: string;
  photos: ItemPhotoRow[];
  uploading: boolean;
  onUpload: (file: File) => void;
  onRemove: (photo: ItemPhotoRow) => void;
  onEdit: (photo: ItemPhotoRow) => void;
  required?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const filled = photos.length > 0;
  const first = photos[0];

  return (
    <div
      title={hint}
      className={cn(
        "relative overflow-hidden rounded-md border",
        required && !filled && "border-dashed border-amber-400/60",
      )}
    >
      {/* No `capture` attribute — that would force the camera on mobile.
          Without it the OS shows a native chooser with Camera, Photo
          Library, and Files, so users can take a fresh shot OR pick an
          existing photo (e.g. one they took on a DSLR and AirDropped). */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif,video/*,.mov,.mp4,.m4v"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = "";
        }}
      />
      <div className="aspect-square bg-muted/40">
        {filled && first ? (
          <div className="group relative h-full w-full">
            <ItemPhotoImg
              photo={first}
              alt={label}
              loading="lazy"
              className="h-full w-full object-cover"
            />
            {/* Edit overlay — visible on hover (desktop) or always (mobile) */}
            <button
              type="button"
              onClick={() => onEdit(first)}
              className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/40 focus-visible:bg-black/40 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
              aria-label="Edit photo"
            >
              <Pencil className="h-5 w-5 text-white opacity-0 drop-shadow group-hover:opacity-100 group-focus-within:opacity-100" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground hover:bg-muted/60"
          >
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Camera className="h-5 w-5" />
            )}
            <span className="text-[10px]">Add</span>
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-1 px-1.5 py-1">
        <span className="truncate text-[10px] font-medium">
          {label}
          {photos.length > 1 && (
            <span className="ml-1 text-muted-foreground">
              ×{photos.length}
            </span>
          )}
        </span>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {filled && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Add another"
            >
              <Upload className="h-3 w-3" />
            </button>
          )}
          {filled && first && (
            <button
              type="button"
              onClick={() => onRemove(first)}
              className="text-destructive"
              aria-label="Remove photo"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

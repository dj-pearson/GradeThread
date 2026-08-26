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
import { toastError } from "@/lib/toast-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { PhotoEditorDialog } from "@/components/flipdesk/photo-editor-dialog";
import { usePhotoProfile } from "@/lib/photo-profiles";
import { advanceItemStatus } from "@/lib/status-writer";
import { nextUploadSortOrder } from "@/lib/photo-order";
import { uploadItemPhoto } from "@/lib/item-photo-upload";
import type { MacroQualityAssessment } from "@/lib/macro-photo-quality";
import { captureGuidanceFor } from "@/lib/macro-capture-guidance";
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

export function PhotoUploader({
  itemId,
  currentStatus,
  category,
  garment,
  showSlots = true,
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
   * US-2465: the free-text `inventory_items.category` ("blazer", "dress
   * pants"). Only consulted for clothing, where item_category alone is too
   * coarse — it is what decides whether an inseam slot belongs on screen.
   */
  garment?: string | null;
  /**
   * US-2501: render the per-tag slot grids (Required / Optional), or just the
   * header + the bulk "Add photos" button.
   *
   * The grids are shoot-time guidance: one tile per expected tag so you can see
   * what you still owe the listing. That is the right surface in Prep, Snap
   * Catalog and the AutoLister queue, where the photos don't exist yet. In the
   * composer the photos are already taken, and the grid there was a second,
   * lossy view of the same set — each tile showed only `photos[0]` with a "×N"
   * count, so the 2nd and 3rd photo of a tag were invisible directly above a
   * PhotoManager grid that shows every one of them. Off ⇒ the missing required
   * tags are named in the header instead, and the tiles below are the only
   * gallery.
   */
  showSlots?: boolean;
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
  const [uploading, setUploading] = useState<string | null>(null);
  const [editingPhoto, setEditingPhoto] = useState<ItemPhotoRow | null>(null);
  // Bulk-add progress: {done,total} while a multi-select batch is uploading,
  // null otherwise. Drives the button label/spinner and disables re-picking.
  const [bulkBusy, setBulkBusy] = useState<{ done: number; total: number } | null>(
    null,
  );
  const bulkInputRef = useRef<HTMLInputElement>(null);

  // Category-driven photo slots. Required roles gate the "photographed" status;
  // optional roles are extra coverage. Both come from the (cached) profile.
  const profile = usePhotoProfile(category ?? null, garment);
  const requiredRoles = profile.roles.filter((r) => r.required);
  const optionalRoles = profile.roles.filter((r) => !r.required);
  const requiredTypes = requiredRoles.map((r) => r.type);

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

  // US-2465: slot identity is (type, role), not type alone. Without the role
  // half, a suit's three tag slots would all show the same photo and a
  // "Measure: Chest" upload would fill the "Measure: Waist" tile too.
  const slotKey = (t: string, role?: string | null) =>
    role ? `${t}:${role}` : t;

  const bySlot = (r: { type: FlipdeskPhotoType; role?: string }) =>
    photos.filter(
      (p) => p.photo_type === r.type && (p.photo_role ?? null) === (r.role ?? null),
    );

  // The required GATE is still per type, not per slot: `front` and `back` are
  // the only required roles and neither takes a qualifier, so "has a front" is
  // the right question and a role-blind count is the right instrument.
  const byType = (t: FlipdeskPhotoType) =>
    photos.filter((p) => p.photo_type === t);

  // US-2546: the upload core moved to src/lib/item-photo-upload.ts so the
  // FlipDesk intake form can stage photos and upload them the moment the item
  // row exists, WITHOUT growing a second implementation. This wrapper keeps the
  // component's call sites unchanged.
  async function processAndUpload(
    picked: File,
    photoType: FlipdeskPhotoType,
    sortOrder: number,
    photoRole?: string | null,
  ): Promise<{
    originalSize: number;
    storedSize: number;
    macro: MacroQualityAssessment;
  }> {
    if (!user) throw new Error("You must be signed in.");
    return uploadItemPhoto({
      file: picked,
      itemId,
      ownerFolder: workspaceOwnerId ?? user.id,
      photoType,
      sortOrder,
      photoRole,
    });
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

  async function upload(
    picked: File,
    slot: { type: FlipdeskPhotoType; role?: string; label: string },
  ) {
    if (!user) return;
    const photoType = slot.type;
    setUploading(slotKey(photoType, slot.role));
    try {
      const { originalSize, storedSize, macro } = await processAndUpload(
        picked,
        photoType,
        nextUploadSortOrder(photos, photoType),
        slot.role,
      );
      await afterPhotosChanged([photoType]);
      const savedPct = ((1 - storedSize / originalSize) * 100).toFixed(0);
      const sizeNote =
        storedSize < originalSize && originalSize > 100 * 1024
          ? ` (−${savedPct}%, ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(storedSize / 1024 / 1024).toFixed(1)}MB)`
          : "";
      toast.success(`${slot.label} photo uploaded${sizeNote}.`);
      // Separate toast, not appended to the success line: the upload DID
      // succeed, and the nudge is a different message with a different action.
      if (macro.message) toast.warning(macro.message);
    } catch (err) {
      toastError(err, "Upload failed.");
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
      toastError(err, "Delete failed.");
    }
  }

  const requiredFilled = requiredTypes.every((t) => byType(t).length > 0);

  // US-2501: with the slot grids off, the dashed amber tiles that used to say
  // "you still owe a Back shot" are gone, and "2/4 required photos" alone
  // doesn't say WHICH two. Name them.
  const missingRequiredLabels = requiredRoles
    .filter((r) => byType(r.type).length === 0)
    .map((r) => r.label);

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
  async function saveEdit(
    blob: Blob,
    recipe: PhotoEditRecipe,
    dims: [number, number],
  ) {
    if (!editingPhoto) return;
    try {
      await persistPhotoEdit(supabase, editingPhoto, blob, recipe, { dims });
    } catch (err) {
      toastError(err, "Couldn't save the edit.");
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
      <div className="flex flex-wrap items-center gap-2 text-xs">
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
        {!showSlots && missingRequiredLabels.length > 0 && (
          <span className="text-muted-foreground">
            Still needed: {missingRequiredLabels.join(", ")}
          </span>
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

      {showSlots && (
        <>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Required
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {requiredRoles.map((r) => (
                <PhotoSlot
                  key={slotKey(r.type, r.role)}
                  label={r.label}
                  hint={r.hint}
                  photoType={r.type}
                  photos={bySlot(r)}
                  uploading={uploading === slotKey(r.type, r.role)}
                  onUpload={(f) => upload(f, r)}
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
                  key={slotKey(r.type, r.role)}
                  label={r.label}
                  hint={r.hint}
                  photoType={r.type}
                  photos={bySlot(r)}
                  uploading={uploading === slotKey(r.type, r.role)}
                  onUpload={(f) => upload(f, r)}
                  onRemove={remove}
                  onEdit={setEditingPhoto}
                />
              ))}
            </div>
          </div>
        </>
      )}

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
  photoType,
  photos,
  uploading,
  onUpload,
  onRemove,
  onEdit,
  required = false,
}: {
  label: string;
  hint: string;
  // US-2137: the slot's server photo_type, for the macro capture guidance.
  photoType?: string | null;
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
  // US-2137: the profile hint says WHAT to shoot; for a macro slot the distance
  // and lighting are what actually decide whether the tell is legible. This is
  // the uploader's only per-slot affordance, so the guidance rides the tooltip
  // rather than inventing a surface for it.
  const guidance = captureGuidanceFor(photoType);
  const title = guidance
    ? `${hint}\n${guidance.distance}\n${guidance.lighting}`
    : hint;

  return (
    <div
      title={title}
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

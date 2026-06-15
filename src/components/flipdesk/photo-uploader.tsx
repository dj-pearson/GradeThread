import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, Trash2, Loader2, Check, Camera, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { PhotoEditorDialog } from "@/components/flipdesk/photo-editor-dialog";
import { PHOTO_TYPE_LABELS } from "@/lib/constants";
import { usePhotoProfile } from "@/lib/photo-profiles";
import { advanceItemStatus } from "@/lib/status-writer";
import { nextUploadSortOrder } from "@/lib/photo-order";
import { compressImage } from "@/lib/image-utils";
import { itemPhotoThumb } from "@/lib/images";
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
}: {
  itemId: string;
  currentStatus?: ItemStatus;
  /**
   * item_category — drives which photo slots/labels are shown via the photo
   * profile. Defaults to the clothing profile when null/undefined so existing
   * clothing flows are unchanged.
   */
  category?: ItemCategory | null;
}) {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId } = useWorkspace();
  const qc = useQueryClient();
  const [uploading, setUploading] = useState<FlipdeskPhotoType | null>(null);
  const [editingPhoto, setEditingPhoto] = useState<ItemPhotoRow | null>(null);

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

  async function upload(file: File, photoType: FlipdeskPhotoType) {
    if (!user) return;
    setUploading(photoType);
    try {
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
        const main = await compressImage(file, 2400, 0.85);
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
          console.warn("[photo-uploader] thumbnail gen failed:", thumbErr);
        }
      } catch (compressErr) {
        console.warn(
          "[photo-uploader] compress failed, uploading original:",
          compressErr,
        );
      }

      const ts = Date.now();
      const ownerFolder = workspaceOwnerId ?? user.id;
      const path = `${ownerFolder}/${itemId}/${photoType}_${ts}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("item-photos")
        .upload(path, body, {
          upsert: false,
          contentType: bodyType || undefined,
        });
      if (upErr) throw upErr;

      const { data: pub } = supabase.storage
        .from("item-photos")
        .getPublicUrl(path);

      // Best-effort thumbnail upload. If it fails, we still have the full
      // image — frontend falls back to photo_url via `thumbnail_url ?? photo_url`.
      let thumbnailUrl: string | null = null;
      let thumbnailPath: string | null = null;
      if (thumbBlob) {
        thumbnailPath = `${ownerFolder}/${itemId}/thumbs/${photoType}_${ts}.${extForBlobType(thumbType, "webp")}`;
        const { error: thumbUpErr } = await supabase.storage
          .from("item-photos")
          .upload(thumbnailPath, thumbBlob, {
            upsert: false,
            contentType: thumbType,
          });
        if (thumbUpErr) {
          console.warn(
            "[photo-uploader] thumbnail upload failed:",
            thumbUpErr.message,
          );
          thumbnailPath = null;
        } else {
          thumbnailUrl = supabase.storage
            .from("item-photos")
            .getPublicUrl(thumbnailPath).data.publicUrl;
        }
      }

      const { error: insErr } = await supabase
        .from("item_photos")
        .insert({
          inventory_item_id: itemId,
          photo_url: pub.publicUrl,
          storage_path: path,
          photo_type: photoType,
          // Canonical default order: Front → Back → Tag → Detail … so the
          // listing's photo order (and eBay cover) is sensible without any
          // manual drag. A later reorder densifies sort_order and wins.
          sort_order: nextUploadSortOrder(photos, photoType),
          thumbnail_url: thumbnailUrl,
          thumbnail_storage_path: thumbnailPath,
          width,
          height,
          bytes: body.size,
        } as never);
      if (insErr) throw insErr;

      // Auto-advance to "photographed" once the required set is complete.
      const typesAfter = new Set(
        photos.map((p) => p.photo_type).concat(photoType),
      );
      const requiredNowComplete = requiredTypes.every((t) =>
        typesAfter.has(t),
      );
      if (requiredNowComplete && currentStatus) {
        const advanced = await advanceItemStatus(
          itemId,
          currentStatus,
          "photographed",
        );
        if (advanced) await qc.invalidateQueries({ queryKey: ["items_full"] });
      }

      await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
      const savedPct = ((1 - body.size / originalSize) * 100).toFixed(0);
      const sizeNote =
        body.size < originalSize && originalSize > 100 * 1024
          ? ` (−${savedPct}%, ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(body.size / 1024 / 1024).toFixed(1)}MB)`
          : "";
      toast.success(`${labelFor(photoType)} photo uploaded${sizeNote}.`);
    } catch (err) {
      toast.error(
        `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setUploading(null);
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
    } catch (err) {
      toast.error(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const requiredFilled = requiredTypes.every((t) => byType(t).length > 0);

  async function saveEdit(blob: Blob) {
    if (!editingPhoto) return;
    const path = editingPhoto.storage_path;
    if (!path) {
      toast.error("This photo has no storage path; can't save edits.");
      return;
    }
    const { error: upErr } = await supabase.storage
      .from("item-photos")
      .upload(path, blob, { upsert: true, contentType: "image/jpeg" });
    if (upErr) throw upErr;
    const { data: pub } = supabase.storage.from("item-photos").getPublicUrl(path);
    const { error: dbErr } = await supabase
      .from("item_photos")
      .update({ photo_url: `${pub.publicUrl}?v=${Date.now()}` } as never)
      .eq("id", editingPhoto.id);
    if (dbErr) throw dbErr;
    await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
    toast.success("Photo updated.");
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
        src={editingPhoto?.photo_url ?? ""}
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
        accept="image/*"
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
            <img
              src={itemPhotoThumb(first)}
              alt={label}
              loading="lazy"
              className="h-full w-full object-cover"
            />
            {/* Edit overlay — visible on hover (desktop) or always (mobile) */}
            <button
              type="button"
              onClick={() => onEdit(first)}
              className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/40 sm:opacity-0 sm:group-hover:opacity-100"
              aria-label="Edit photo"
            >
              <Pencil className="h-5 w-5 text-white opacity-0 drop-shadow group-hover:opacity-100" />
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

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload, Trash2, Loader2, Check, Camera } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  REQUIRED_PHOTO_TYPES,
  OPTIONAL_PHOTO_TYPES,
  PHOTO_TYPE_LABELS,
} from "@/lib/constants";
import { rankOf } from "@/lib/workflow";
import { cn } from "@/lib/utils";
import type {
  ItemPhotoRow,
  FlipdeskPhotoType,
  ItemStatus,
} from "@/types/database";

function extOf(file: File): string {
  const m = file.name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1]!.toLowerCase() : "jpg";
}

export function PhotoUploader({
  itemId,
  currentStatus,
}: {
  itemId: string;
  currentStatus?: ItemStatus;
}) {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [uploading, setUploading] = useState<FlipdeskPhotoType | null>(null);

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
      const path = `${user.id}/${itemId}/${photoType}_${Date.now()}.${extOf(file)}`;
      const { error: upErr } = await supabase.storage
        .from("item-photos")
        .upload(path, file, { upsert: false });
      if (upErr) throw upErr;

      const { data: pub } = supabase.storage
        .from("item-photos")
        .getPublicUrl(path);

      const { error: insErr } = await supabase
        .from("item_photos")
        .insert({
          inventory_item_id: itemId,
          photo_url: pub.publicUrl,
          storage_path: path,
          photo_type: photoType,
          sort_order: photos.length,
        } as never);
      if (insErr) throw insErr;

      // Auto-advance to "photographed" once the required set is complete.
      const typesAfter = new Set(
        photos.map((p) => p.photo_type).concat(photoType),
      );
      const requiredNowComplete = REQUIRED_PHOTO_TYPES.every((t) =>
        typesAfter.has(t),
      );
      if (
        requiredNowComplete &&
        currentStatus &&
        rankOf(currentStatus) < rankOf("photographed")
      ) {
        await supabase
          .from("inventory_items")
          .update({ status: "photographed" } as never)
          .eq("id", itemId);
        await qc.invalidateQueries({ queryKey: ["items_full"] });
      }

      await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
      toast.success(`${PHOTO_TYPE_LABELS[photoType]} photo uploaded.`);
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
      if (photo.storage_path) {
        await supabase.storage
          .from("item-photos")
          .remove([photo.storage_path]);
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

  const requiredFilled = REQUIRED_PHOTO_TYPES.every(
    (t) => byType(t).length > 0,
  );

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
        {requiredFilled ? (
          <Badge variant="default" className="gap-1">
            <Check className="h-3 w-3" />
            Required set complete
          </Badge>
        ) : (
          <Badge variant="secondary">
            {REQUIRED_PHOTO_TYPES.filter((t) => byType(t).length > 0).length}/
            {REQUIRED_PHOTO_TYPES.length} required photos
          </Badge>
        )}
      </div>

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Required
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {REQUIRED_PHOTO_TYPES.map((t) => (
            <PhotoSlot
              key={t}
              photoType={t}
              photos={byType(t)}
              uploading={uploading === t}
              onUpload={(f) => upload(f, t)}
              onRemove={remove}
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
          {OPTIONAL_PHOTO_TYPES.map((t) => (
            <PhotoSlot
              key={t}
              photoType={t}
              photos={byType(t)}
              uploading={uploading === t}
              onUpload={(f) => upload(f, t)}
              onRemove={remove}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PhotoSlot({
  photoType,
  photos,
  uploading,
  onUpload,
  onRemove,
  required = false,
}: {
  photoType: FlipdeskPhotoType;
  photos: ItemPhotoRow[];
  uploading: boolean;
  onUpload: (file: File) => void;
  onRemove: (photo: ItemPhotoRow) => void;
  required?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const filled = photos.length > 0;
  const first = photos[0];

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border",
        required && !filled && "border-dashed border-amber-400/60",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = "";
        }}
      />
      <div className="aspect-square bg-muted/40">
        {filled && first ? (
          <img
            src={first.photo_url}
            alt={PHOTO_TYPE_LABELS[photoType]}
            className="h-full w-full object-cover"
          />
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
          {PHOTO_TYPE_LABELS[photoType]}
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

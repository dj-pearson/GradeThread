import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2, Pencil, Wand2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { FLIPDESK_PHOTO_TYPES, PHOTO_TYPE_LABELS } from "@/lib/constants";
import { PhotoEditorDialog } from "@/components/flipdesk/photo-editor-dialog";
import { useRemoveBackground, useRemoveBgCapability } from "@/hooks/use-remove-bg";
import { itemPhotoThumb } from "@/lib/images";
import { cn } from "@/lib/utils";
import type {
  ItemPhotoRow,
  FlipdeskPhotoType,
  FlipdeskGradingSubmissionRow,
} from "@/types/database";

interface PhotoManagerProps {
  itemId: string;
}

export function PhotoManager({ itemId }: PhotoManagerProps) {
  const qc = useQueryClient();
  const [order, setOrder] = useState<ItemPhotoRow[]>([]);
  const [editingPhoto, setEditingPhoto] = useState<ItemPhotoRow | null>(null);
  const [removingBgId, setRemovingBgId] = useState<string | null>(null);
  const removeBg = useRemoveBackground();
  // US-1114: only offer server-backed background removal when it's configured,
  // so the button never 503s on click.
  const { data: bgCaps } = useRemoveBgCapability();
  const removeBgEnabled = bgCaps?.remove_bg ?? false;

  async function doRemoveBg(photo: ItemPhotoRow) {
    setRemovingBgId(photo.id);
    try {
      await removeBg.mutateAsync({ itemPhotoId: photo.id, itemId });
      toast.success("Background-removed flatlay saved.");
    } catch {
      /* surfaced by hook's onError */
    } finally {
      setRemovingBgId(null);
    }
  }

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

  // Any pending/processing grading submission blocks deleting graded photos.
  const { data: gradingInFlight = false } = useQuery({
    queryKey: ["grading-inflight", itemId],
    queryFn: async (): Promise<boolean> => {
      const { data } = await supabase
        .from("flipdesk_grading_submissions")
        .select("status")
        .eq("inventory_item_id", itemId);
      const rows = (data ?? []) as Pick<
        FlipdeskGradingSubmissionRow,
        "status"
      >[];
      return rows.some(
        (r) => r.status === "pending" || r.status === "processing"
      );
    },
  });

  // Keep local drag order in sync with the fetched rows.
  useEffect(() => {
    setOrder(photos);
  }, [photos]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  async function persistOrder(next: ItemPhotoRow[]) {
    try {
      await Promise.all(
        next.map((p, i) =>
          supabase
            .from("item_photos")
            .update({ sort_order: i } as never)
            .eq("id", p.id)
        )
      );
      await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
    } catch {
      toast.error("Failed to save the new photo order.");
      await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.findIndex((p) => p.id === active.id);
    const newIndex = order.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next); // optimistic
    void persistOrder(next);
  }

  async function retag(photo: ItemPhotoRow, photoType: FlipdeskPhotoType) {
    try {
      const { error } = await supabase
        .from("item_photos")
        .update({ photo_type: photoType } as never)
        .eq("id", photo.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
    } catch {
      toast.error("Failed to change the photo type.");
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
      toast.success("Photo deleted.");
    } catch (err) {
      toast.error(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (isLoading) {
    return (
      <p className="py-3 text-center text-xs text-muted-foreground">
        Loading photos…
      </p>
    );
  }
  if (order.length === 0) {
    return (
      <p className="py-3 text-xs text-muted-foreground">
        No photos yet — add some above.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Drag to reorder. The first photo is the listing's main image.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={order.map((p) => p.id)}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {order.map((photo) => (
              <SortablePhoto
                key={photo.id}
                photo={photo}
                gradingInFlight={gradingInFlight}
                onRetag={retag}
                onRemove={remove}
                onEdit={setEditingPhoto}
                onRemoveBg={doRemoveBg}
                removingBg={removingBgId === photo.id}
                removeBgEnabled={removeBgEnabled}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <PhotoEditorDialog
        open={editingPhoto != null}
        src={editingPhoto?.photo_url ?? ""}
        onClose={() => setEditingPhoto(null)}
        onSave={async (blob) => {
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
          await supabase
            .from("item_photos")
            .update({ photo_url: `${pub.publicUrl}?v=${Date.now()}` } as never)
            .eq("id", editingPhoto.id);
          await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
          toast.success("Photo updated.");
          setEditingPhoto(null);
        }}
      />
    </div>
  );
}

function SortablePhoto({
  photo,
  gradingInFlight,
  onRetag,
  onRemove,
  onEdit,
  onRemoveBg,
  removingBg,
  removeBgEnabled,
}: {
  photo: ItemPhotoRow;
  gradingInFlight: boolean;
  onRetag: (photo: ItemPhotoRow, t: FlipdeskPhotoType) => void;
  onRemove: (photo: ItemPhotoRow) => void;
  onEdit: (photo: ItemPhotoRow) => void;
  onRemoveBg: (photo: ItemPhotoRow) => void;
  removingBg: boolean;
  removeBgEnabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: photo.id });

  // A photo sent for grading can't be deleted while a grade is in flight.
  const deleteBlocked = photo.used_for_grading && gradingInFlight;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className="overflow-hidden rounded-md border bg-card"
    >
      <div className="relative aspect-square bg-muted/40">
        <img
          src={itemPhotoThumb(photo)}
          alt={PHOTO_TYPE_LABELS[photo.photo_type]}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="absolute left-1 top-1 cursor-grab rounded bg-background/80 p-1 text-muted-foreground active:cursor-grabbing"
          aria-label="Drag to reorder"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <div className="absolute right-1 top-1 flex gap-1">
          {photo.photo_type !== "flatlay" && removeBgEnabled && (
            <button
              type="button"
              onClick={() => onRemoveBg(photo)}
              disabled={removingBg}
              className="rounded bg-background/80 p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
              aria-label="Remove background"
              title="Remove background (saves a new flatlay variant — uses 1 remove.bg credit)"
            >
              {removingBg ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => onEdit(photo)}
            className="rounded bg-background/80 p-1 text-muted-foreground hover:text-foreground"
            aria-label="Edit photo"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1 p-1">
        <Select
          value={photo.photo_type}
          onValueChange={(v) => onRetag(photo, v as FlipdeskPhotoType)}
        >
          <SelectTrigger className="h-7 flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FLIPDESK_PHOTO_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {PHOTO_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={() => !deleteBlocked && onRemove(photo)}
          disabled={deleteBlocked}
          title={
            deleteBlocked
              ? "This photo was sent for grading — it can't be deleted while a grade is in progress."
              : "Delete photo"
          }
          aria-label="Delete photo"
          className={cn(
            "flex-shrink-0 rounded p-1",
            deleteBlocked
              ? "cursor-not-allowed text-muted-foreground/40"
              : "text-destructive hover:bg-destructive/10"
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

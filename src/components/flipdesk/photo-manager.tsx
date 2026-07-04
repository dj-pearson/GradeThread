import { type MutableRefObject, useEffect, useRef, useState } from "react";
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
import { GripVertical, Trash2, Pencil, Wand2, Loader2, Star } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { FLIPDESK_PHOTO_TYPES, PHOTO_TYPE_LABELS } from "@/lib/constants";
import { PhotoEditorDialog } from "@/components/flipdesk/photo-editor-dialog";
import { useRemoveBackground, useRemoveBgCapability } from "@/hooks/use-remove-bg";
import { itemPhotoThumb } from "@/lib/images";
import { persistRetag, persistDelete } from "@/lib/photo-mutations";
import { useEbayReviseListing } from "@/hooks/use-ebay";
import { cn } from "@/lib/utils";
import type {
  ItemPhotoRow,
  FlipdeskPhotoType,
  FlipdeskGradingSubmissionRow,
} from "@/types/database";

// Stable identity for the photos query's pending/empty state. An inline `[]`
// default is a NEW array every render, and the drag-order sync effect
// (`setOrder(photos)`) keys on the array's identity — a fresh identity each
// render re-fires the effect and each setOrder schedules another render, an
// update loop that runs until the query resolves. On slow loads React hits its
// nested-update limit first and the whole route crashes with "Maximum update
// depth exceeded". Same fix as the composer's EMPTY_PHOTOS.
const EMPTY_PHOTOS: ItemPhotoRow[] = [];

interface PhotoManagerProps {
  itemId: string;
  /** The item's live, revisable GradeThread eBay listing id, when one exists.
   *  When set, a photo edit (reorder/retag/rotate/delete) made here is pushed to
   *  the live listing once — coalesced — when this editor closes. eBay blocks
   *  editing inventory-based listing photos on its own site, so this is the
   *  supported path. null/undefined → photo edits stay local only. */
  liveListingId?: string | null;
  /** Shared "photos changed this session" flag, owned by the parent canvas so
   *  its "Save & sync" button can include photo-only edits (e.g. a rotate) in
   *  the eBay patch and clear it after pushing — preventing this component's
   *  unmount auto-sync from double-pushing the same change. When omitted, an
   *  internal ref is used and edits sync only on unmount. */
  dirtyRef?: MutableRefObject<boolean>;
  /** US-1567: optional primary-photo picker (the composer's star). When both
   *  are provided each tile shows a star button; the highlighted star marks
   *  the current primary. Omit for surfaces where position 0 is the cover. */
  primaryPhotoId?: string | null;
  onPickPrimary?: (photoId: string) => void;
}

export function PhotoManager({
  itemId,
  liveListingId,
  dirtyRef,
  primaryPhotoId,
  onPickPrimary,
}: PhotoManagerProps) {
  const qc = useQueryClient();
  const [order, setOrder] = useState<ItemPhotoRow[]>([]);
  // US-1567: click a thumbnail to view the full-size photo.
  const [viewingPhoto, setViewingPhoto] = useState<ItemPhotoRow | null>(null);
  // US-1296+: coalesced auto-resync. Each photo edit persists immediately; we
  // push the net result to the live eBay listing ONCE on unmount (the editor
  // closing) instead of a full photo re-PUT per micro-edit. Refs so the cleanup
  // reads the latest values without re-subscribing.
  const revise = useEbayReviseListing();
  // Use the parent-owned dirty flag when provided so "Save & sync" and this
  // unmount handler observe the same state; otherwise fall back to a local ref.
  const internalDirtyRef = useRef(false);
  const photosDirtyRef = dirtyRef ?? internalDirtyRef;
  const liveListingIdRef = useRef(liveListingId);
  liveListingIdRef.current = liveListingId;
  const reviseRef = useRef(revise);
  reviseRef.current = revise;
  useEffect(() => {
    return () => {
      const lid = liveListingIdRef.current;
      if (photosDirtyRef.current && lid) {
        photosDirtyRef.current = false;
        // Fire-and-forget: the component is unmounting, so a failure is recorded
        // on the listing (publish_error) and surfaces on the next eBay-sync read
        // rather than inline.
        reviseRef.current.mutate({ listingId: lid, patch: { photos: true } });
      }
    };
    // Unmount-only: photosDirtyRef is a stable ref (own useRef or the parent's),
    // and the other reads go through refs above — none belong in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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

  const { data: photos = EMPTY_PHOTOS, isLoading } = useQuery({
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
    photosDirtyRef.current = true;
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
    photosDirtyRef.current = true;
    try {
      await persistRetag(supabase, photo, photoType);
      await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
    } catch {
      toast.error("Failed to change the photo type.");
    }
  }

  async function remove(photo: ItemPhotoRow) {
    photosDirtyRef.current = true;
    try {
      await persistDelete(supabase, photo);
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
                onView={setViewingPhoto}
                isPrimary={
                  onPickPrimary ? photo.id === primaryPhotoId : undefined
                }
                onPickPrimary={onPickPrimary}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* US-1567: full-size viewer. */}
      <Dialog
        open={viewingPhoto != null}
        onOpenChange={(o) => !o && setViewingPhoto(null)}
      >
        <DialogContent className="max-w-4xl p-2">
          <DialogTitle className="sr-only">
            {viewingPhoto ? PHOTO_TYPE_LABELS[viewingPhoto.photo_type] : "Photo"}
          </DialogTitle>
          {viewingPhoto && (
            <img
              src={viewingPhoto.photo_url}
              alt={PHOTO_TYPE_LABELS[viewingPhoto.photo_type]}
              className="max-h-[80vh] w-full rounded object-contain"
            />
          )}
        </DialogContent>
      </Dialog>

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
          photosDirtyRef.current = true;
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
  onView,
  isPrimary,
  onPickPrimary,
}: {
  photo: ItemPhotoRow;
  gradingInFlight: boolean;
  onRetag: (photo: ItemPhotoRow, t: FlipdeskPhotoType) => void;
  onRemove: (photo: ItemPhotoRow) => void;
  onEdit: (photo: ItemPhotoRow) => void;
  onRemoveBg: (photo: ItemPhotoRow) => void;
  removingBg: boolean;
  removeBgEnabled: boolean;
  onView: (photo: ItemPhotoRow) => void;
  isPrimary?: boolean;
  onPickPrimary?: (photoId: string) => void;
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
        <button
          type="button"
          onClick={() => onView(photo)}
          className="block h-full w-full cursor-zoom-in"
          aria-label="View photo full size"
        >
          <img
            src={itemPhotoThumb(photo)}
            alt={PHOTO_TYPE_LABELS[photo.photo_type]}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        </button>
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
          {onPickPrimary && (
            <button
              type="button"
              onClick={() => onPickPrimary(photo.id)}
              className={cn(
                "rounded bg-background/80 p-1",
                isPrimary
                  ? "text-amber-500"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-label={isPrimary ? "Primary photo" : "Set as primary photo"}
              title={isPrimary ? "Primary photo" : "Set as primary photo"}
            >
              <Star
                className="h-3.5 w-3.5"
                fill={isPrimary ? "currentColor" : "none"}
              />
            </button>
          )}
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
      {/* US-1571: capture guidance for the MeasureCard frame, surfaced right
          where the tag is set. */}
      {photo.photo_type === "measurement" && (
        <p className="px-1.5 pb-1 text-[10px] leading-tight text-muted-foreground">
          MeasureCard shot: whole garment flat, card BESIDE it, all 4 squares
          visible. Never sent to eBay.
        </p>
      )}
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

import {
  type MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  GripVertical,
  Trash2,
  Pencil,
  Wand2,
  Loader2,
  Star,
  SunMedium,
  Eye,
  EyeOff,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import {
  isNonListablePhotoType,
  isSensitivePhotoType,
} from "@/lib/constants";
import {
  hideTag,
  isHiddenFromListing,
  showTag,
} from "@/lib/photo-visibility";
import {
  PhotoTagSelect,
  photoTagLabel,
} from "@/components/flipdesk/photo-tag-select";
import { usePhotoProfile, type PhotoProfile } from "@/lib/photo-profiles";
import { captureGuidanceFor } from "@/lib/macro-capture-guidance";
import { firstPhotoNudge } from "@/lib/photo-standards";
import { PhotoEditorDialog } from "@/components/flipdesk/photo-editor-dialog";
import { BulkToneDialog } from "@/components/flipdesk/bulk-tone-dialog";
import { useRemoveBackground, useRemoveBgCapability } from "@/hooks/use-remove-bg";
import { ItemPhotoImg } from "@/components/flipdesk/item-photo-img";
import {
  useItemPhotoDisplayUrl,
  useItemPhotoOriginalUrl,
} from "@/hooks/use-item-photo-url";
import { needsSignedDisplayUrl } from "@/lib/item-photo-url";
import {
  persistRetag,
  persistDelete,
  persistPhotoEdit,
  revertPhotoEdit,
} from "@/lib/photo-mutations";
import {
  parseEditRecipe,
  type PhotoEditRecipe,
} from "@/lib/photo-edit-recipe";
import { itemPhotoQueryKeys } from "@/lib/photo-query-keys";
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
  /** US-2465: the free-text garment word ("blazer", "dress pants"), used to
   *  pick the suggested tag set. items_full has no item_category column, so
   *  this is the only category signal the composer actually has. */
  garment?: string | null;
  /** US-1567: optional primary-photo picker (the composer's star). When both
   *  are provided each tile shows a star button; the highlighted star marks
   *  the current primary. Omit for surfaces where position 0 is the cover. */
  primaryPhotoId?: string | null;
  /** null clears the pick — used when the starred photo is hidden (US-2669). */
  onPickPrimary?: (photoId: string | null) => void;
}

export function PhotoManager({
  itemId,
  liveListingId,
  dirtyRef,
  garment,
  primaryPhotoId,
  onPickPrimary,
}: PhotoManagerProps) {
  // US-2465: the garment word picks the suggested tag set. Non-clothing items
  // resolve through the same call — see usePhotoProfile.
  const profile = usePhotoProfile(null, garment);
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
  const [toneMatchOpen, setToneMatchOpen] = useState(false);
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

  // A photo edit (reorder/retag/delete/rotate/remove-bg) can change the cover
  // (lowest sort_order) or its image. The Listings table cover query keys under
  // the ["items_full", …] prefix, so invalidate BOTH keys — otherwise the
  // Listings row thumbnail stays stale for up to its 5-min staleTime.
  // US-2888: the list lives in lib/photo-query-keys.ts. It used to be a
  // sequence of calls here and one of them was missing — see that module.
  async function invalidatePhotos() {
    for (const queryKey of itemPhotoQueryKeys(itemId)) {
      await qc.invalidateQueries({ queryKey });
    }
  }

  // Any pending/processing grading submission blocks deleting graded photos.
  const { data: gradingInFlightData, isError: gradingCheckFailed } = useQuery({
    queryKey: ["grading-inflight", itemId],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from("flipdesk_grading_submissions")
        .select("status")
        .eq("inventory_item_id", itemId);
      // Throw (don't swallow) so a failed check surfaces as isError and we can
      // fail CLOSED — previously an errored check returned false and let a
      // graded photo be deleted mid grading run.
      if (error) throw error;
      const rows = (data ?? []) as Pick<
        FlipdeskGradingSubmissionRow,
        "status"
      >[];
      return rows.some(
        (r) => r.status === "pending" || r.status === "processing"
      );
    },
  });
  // Fail closed on a check failure (undefined while loading → not blocked;
  // isError → blocked). Only a confirmed "no in-flight grading" unblocks delete.
  const gradingInFlight = gradingInFlightData ?? gradingCheckFailed;

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
      await invalidatePhotos();
    } catch {
      toast.error("Failed to save the new photo order.");
      await invalidatePhotos();
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

  // US-1896: one-click reorder for the first-photo nudge — move the suggested
  // full-view photo to the front (index 0 = eBay cover / search thumbnail).
  function makeHero(photoId: string) {
    const idx = order.findIndex((p) => p.id === photoId);
    if (idx <= 0) return; // already the hero (or not found)
    const next = arrayMove(order, idx, 0);
    setOrder(next); // optimistic
    void persistOrder(next);
  }

  // US-1896: live nudge when the search thumbnail (lowest sort_order among the
  // LISTABLE photos — internal/measurement shots never reach eBay) is a
  // tag/detail/defect shot rather than a full front/flat-lay view. Client mirror
  // of the edge picture-standards preflight; publish re-checks server-side.
  // The role argument matters: a 'measurement' WITH a role is a tape close-up
  // that lists, and dropping it here made the hero nudge reason about a photo
  // set the listing does not have (US-2462).
  const listableOrder = order.filter(
    (p) => !isNonListablePhotoType(p.photo_type, p.photo_role),
  );
  const heroNudge = firstPhotoNudge(listableOrder);

  // Photos eligible for bulk tone matching. Grading evidence is excluded so a
  // tone pass can't quietly re-expose a photo the grade was read from; sensitive
  // close-ups are excluded because a tone sweep is a LISTING-imagery pass and a
  // label is not listing imagery (a single edit on one is fine now — US-2407);
  // and a photo with no storage_path has nowhere to save to.
  //
  // Memoized because this array is a PROP of BulkToneDialog and one of its load
  // effect's dependencies. A fresh identity on every parent render would restart
  // the dialog's fetch-and-analyse pass mid-review — the same trap EMPTY_PHOTOS
  // guards against above.
  const toneMatchable = useMemo(
    () =>
      order.filter(
        (p) =>
          !p.used_for_grading &&
          !isSensitivePhotoType(p.photo_type) &&
          p.storage_path != null,
      ),
    [order],
  );

  /**
   * Write edited pixels back over a photo. Shared by the single-photo editor and
   * bulk tone matching so both preserve the original identically (US-2208) and
   * stay consistent about cache-busting and thumbnails.
   */
  async function persistPhotoBlob(
    photo: ItemPhotoRow,
    blob: Blob,
    recipe: PhotoEditRecipe | null,
    dims?: [number, number],
  ) {
    // US-2407: no longer refused for a private original. persistPhotoEdit writes
    // the edit back to the bucket the bytes came from, so a phone-captured tag
    // is cropped IN the private bucket and photo_url stays "" — nothing is
    // republished, which was the whole reason the old block existed.
    const outcome = await persistPhotoEdit(supabase, photo, blob, recipe, {
      dims,
    });
    photosDirtyRef.current = true;
    return outcome;
  }

  /** Restore a photo's preserved pre-edit original. */
  async function revertPhoto(photo: ItemPhotoRow) {
    await revertPhotoEdit(supabase, photo);
    photosDirtyRef.current = true;
    await invalidatePhotos();
  }

  // US-2208 invariant: the editor may only render from the ORIGINAL when a
  // recipe fully describes how the current image was derived from it. Bulk tone
  // matching writes a null recipe precisely because it composes on top of
  // whatever edit was already there — so without this guard, opening the editor
  // after a tone match would load the uncropped original and silently discard
  // the seller's crop. No recipe → edit the current image, as before.
  const editingRecipe = editingPhoto
    ? parseEditRecipe(editingPhoto.edit_recipe)
    : null;
  // US-2273: an iOS-captured Garment Tag lives in the PRIVATE bucket with an
  // empty photo_url, so both of these used to resolve to a public item-photos
  // URL (or to "") and the editor opened on a broken image — the tag looked
  // uploaded-but-corrupt on desktop while rendering fine on the phone. Both now
  // go through the same resolver the galleries use, which signs the private
  // case and leaves the public case exactly as it was.
  const editingSrc = useItemPhotoDisplayUrl(editingPhoto ?? {}, { full: true });
  const editingOriginal = useItemPhotoOriginalUrl(
    editingPhoto && editingRecipe ? editingPhoto : null,
  );

  async function retag(
    photo: ItemPhotoRow,
    photoType: FlipdeskPhotoType,
    photoRole: string | null,
  ) {
    photosDirtyRef.current = true;
    try {
      await persistRetag(supabase, photo, photoType, photoRole);
      await invalidatePhotos();
      // US-2407: retagging changes the LABEL, never where the bytes live. A
      // phone-captured close-up called "Front" is still in the private bucket
      // and still won't be sent to a marketplace, so say so once rather than
      // let the seller discover it as a missing listing photo.
      if (needsSignedDisplayUrl(photo) && !isSensitivePhotoType(photoType)) {
        toast.info(
          "This photo was captured on the phone and stays private, so it won't be sent to eBay. Re-take it here if you want it in the listing.",
          { duration: 10_000 },
        );
      }
    } catch {
      toast.error("Failed to change the photo type.");
    }
  }

  // US-2669: the eye. Hiding writes the tag every marketplace filter already
  // drops ('internal') and remembers the old one in photo_role; showing puts the
  // remembered tag back. Deliberately NOT routed through retag() above — that
  // one warns about phone-captured photos not reaching eBay, which is noise when
  // the seller is the one saying "keep this out of the listing".
  async function toggleListed(photo: ItemPhotoRow) {
    const hidden = isHiddenFromListing(photo.photo_type);
    const next = hidden
      ? showTag(photo.photo_role)
      : hideTag(photo.photo_type, photo.photo_role);
    photosDirtyRef.current = true;
    try {
      await persistRetag(supabase, photo, next.type, next.role);
      // Hiding the STARRED photo would leave listings.primary_photo_id pointing
      // at a photo no marketplace receives. The storefront and cross-push both
      // resolve the primary against their listable set and fall through, so the
      // saved value is not dangerous — it is just a star sitting on a greyed-out
      // tile with no effect, which is worse to look at than to fix. Hand the
      // star to the next photo that will actually be sent.
      if (!hidden && onPickPrimary && primaryPhotoId === photo.id) {
        const nextPrimary = order.find(
          (p) =>
            p.id !== photo.id &&
            !isNonListablePhotoType(p.photo_type, p.photo_role),
        );
        onPickPrimary(nextPrimary?.id ?? null);
      }
      await invalidatePhotos();
      toast.success(
        hidden
          ? "Photo is back in the listing."
          : "Photo hidden — it stays on the item but won't be sent to any marketplace.",
      );
    } catch {
      toast.error(
        hidden ? "Failed to show the photo." : "Failed to hide the photo.",
      );
    }
  }

  async function remove(photo: ItemPhotoRow) {
    photosDirtyRef.current = true;
    try {
      await persistDelete(supabase, photo);
      await invalidatePhotos();
      toast.success("Photo deleted.");
    } catch (err) {
      toastError(err, "Delete failed.");
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Drag to reorder. The first photo is the listing's main image.
          {listableOrder.length < order.length && (
            <>
              {" "}
              <span className="font-medium text-foreground">
                {listableOrder.length} of {order.length}
              </span>{" "}
              will be sent to marketplaces.
            </>
          )}
        </p>
        {toneMatchable.length >= 2 && (
          <button
            type="button"
            onClick={() => setToneMatchOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Even out colour and brightness across all of this item's photos"
          >
            <SunMedium className="h-3.5 w-3.5" />
            Match tone
          </button>
        )}
      </div>
      {heroNudge && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:flex-row sm:items-center sm:justify-between dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <span>{heroNudge.message}</span>
          {heroNudge.suggestedHeroId && (
            <button
              type="button"
              onClick={() => makeHero(heroNudge.suggestedHeroId!)}
              className="shrink-0 self-start rounded-md bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-700 sm:self-auto"
            >
              Make it the main photo
            </button>
          )}
        </div>
      )}
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
                garment={garment}
                profile={profile}
                onRetag={retag}
                onRemove={remove}
                onToggleListed={toggleListed}
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
            {viewingPhoto
              ? photoTagLabel(viewingPhoto.photo_type, viewingPhoto.photo_role, garment)
              : "Photo"}
          </DialogTitle>
          {viewingPhoto && (
            <ItemPhotoImg
              photo={viewingPhoto}
              full
              alt={photoTagLabel(viewingPhoto.photo_type, viewingPhoto.photo_role, garment)}
              className="max-h-[80dvh] w-full rounded object-contain"
            />
          )}
        </DialogContent>
      </Dialog>

      <PhotoEditorDialog
        open={editingPhoto != null}
        src={editingSrc.url}
        // US-2208: re-edit from the pristine original with the previous recipe
        // replayed, so tone and JPEG generations never compound.
        originalSrc={editingOriginal}
        initialRecipe={editingRecipe}
        // Offered whenever an original was preserved — including after a bulk
        // tone match, which leaves no recipe but still has something to undo.
        onRevert={
          editingPhoto?.original_storage_path
            ? async () => {
                if (!editingPhoto) return;
                await revertPhoto(editingPhoto);
                toast.success("Photo restored to the original.");
                setEditingPhoto(null);
              }
            : undefined
        }
        // A photo that fed a grade keeps the tone it was graded from — see the
        // prop's own note. Geometry edits stay available.
        allowToneEdits={!editingPhoto?.used_for_grading}
        onClose={() => setEditingPhoto(null)}
        onSave={async (blob, recipe, dims) => {
          if (!editingPhoto) return;
          let outcome;
          try {
            outcome = await persistPhotoBlob(editingPhoto, blob, recipe, dims);
          } catch (err) {
            toastError(err, "Couldn't save the edit.");
            return;
          }
          await invalidatePhotos();
          // US-2888: say what happened to the measurements, because the two
          // outcomes are not interchangeable and only one of them costs the
          // seller anything. A turn keeps every line exactly where it was; a
          // crop or a straighten cannot, and finding that out by scrolling down
          // to an empty panel is how it used to be communicated.
          if (outcome.action === "rotate") {
            toast.success(
              "Photo rotated — the MeasureCard lines turned with it.",
            );
          } else if (outcome.action === "clear") {
            toast.success(
              "Photo updated. Cropping moves the MeasureCard, so the card is being read again — check the measurement lines before listing.",
              { duration: 8000 },
            );
          } else {
            toast.success("Photo updated.");
          }
          setEditingPhoto(null);
        }}
      />

      <BulkToneDialog
        open={toneMatchOpen}
        photos={toneMatchable}
        onClose={() => setToneMatchOpen(false)}
        onSavePhoto={persistPhotoBlob}
        onDone={async () => {
          await invalidatePhotos();
          toast.success("Photo tone matched across the set.");
        }}
      />
    </div>
  );
}

function SortablePhoto({
  photo,
  gradingInFlight,
  garment,
  profile,
  onRetag,
  onRemove,
  onToggleListed,
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
  garment?: string | null;
  profile?: PhotoProfile;
  onRetag: (photo: ItemPhotoRow, t: FlipdeskPhotoType, role: string | null) => void;
  onRemove: (photo: ItemPhotoRow) => void;
  onToggleListed: (photo: ItemPhotoRow) => void;
  onEdit: (photo: ItemPhotoRow) => void;
  onRemoveBg: (photo: ItemPhotoRow) => void;
  removingBg: boolean;
  removeBgEnabled: boolean;
  onView: (photo: ItemPhotoRow) => void;
  isPrimary?: boolean;
  onPickPrimary?: (photoId: string | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: photo.id });

  // A photo sent for grading can't be deleted while a grade is in flight.
  const deleteBlocked = photo.used_for_grading && gradingInFlight;
  // The bytes live in the PRIVATE bucket (phone-captured tag / certificate).
  // Read off the row's shape, never its type — see needsSignedDisplayUrl.
  const privateOriginal = needsSignedDisplayUrl(photo);
  // US-2278: why editing is unavailable, or null when it's available.
  //
  // US-2407 removed the private-original case. The rule being protected is
  // "never republish a private-bucket image to the public one", and the editor
  // now writes each edit back to the bucket it read from — so a phone-captured
  // tag is croppable without a public copy existing at any point. Blocking it
  // was also self-defeating: sellers learned to retag the photo to "Front" to
  // unlock the pencil, which broke its display and taught a habit that would
  // have leaked PII the moment the old code did publish it.
  const editBlockedReason =
    photo.storage_path == null
      ? "This photo is still uploading, or its file is missing, so there's nothing to edit yet."
      : null;

  // US-2669: the eye. Three states, because "will this photo be listed" has
  // three answers and only one of them is the seller's to change here.
  //   hidden     — the seller pressed the eye. Reversible right here.
  //   locked     — the MeasureCard frame. It never lists (the fiducial card is a
  //                branded foreign object) and no toggle should imply otherwise,
  //                so the eye shows the state and refuses the click.
  //   listed     — everything else.
  const hiddenFromListing = isHiddenFromListing(photo.photo_type);
  const listingLocked =
    !hiddenFromListing &&
    isNonListablePhotoType(photo.photo_type, photo.photo_role);
  const notListed = hiddenFromListing || listingLocked;
  const visibilityTitle = listingLocked
    ? "MeasureCard photo — never sent to a marketplace. Retag it to list it."
    : hiddenFromListing
      ? "Hidden from listings — click to put it back"
      : "Listed. Click to hide it from every marketplace (it stays on the item)";

  // US-2501: the shoot guidance used to hang off the uploader's slot tiles, and
  // the composer no longer renders those. It belongs on the photo either way —
  // the tile now says what this tag wants (the profile hint) and, for a macro
  // tag, how close to stand and how to light it. A retag changes the advice,
  // which is exactly what you want when the photo turned out to be a serial
  // rather than a detail.
  const slotHint =
    profile?.roles.find(
      (r) =>
        r.type === photo.photo_type &&
        (r.role ?? null) === (photo.photo_role ?? null),
    )?.hint ?? null;
  const guidance = captureGuidanceFor(photo.photo_type);
  const tileTitle =
    [slotHint, guidance?.distance, guidance?.lighting]
      .filter((s): s is string => !!s)
      .join("\n") || undefined;

  return (
    <div
      ref={setNodeRef}
      title={tileTitle}
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
          <ItemPhotoImg
            photo={photo}
            alt={photoTagLabel(photo.photo_type, photo.photo_role, garment)}
            loading="lazy"
            decoding="async"
            className={cn(
              "h-full w-full object-cover",
              // Desaturated rather than faded: a hidden photo still has to be
              // recognisable enough to pick the right one to put back.
              notListed && "opacity-60 grayscale",
            )}
          />
        </button>
        {notListed && (
          <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            Not listed
          </span>
        )}
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
          <button
            type="button"
            onClick={() => !listingLocked && onToggleListed(photo)}
            disabled={listingLocked}
            className={cn(
              "rounded bg-background/80 p-1",
              listingLocked
                ? "cursor-not-allowed text-muted-foreground/40"
                : hiddenFromListing
                  ? "text-amber-600 hover:text-amber-700 dark:text-amber-500 dark:hover:text-amber-400"
                  : "text-muted-foreground hover:text-foreground",
            )}
            title={visibilityTitle}
            aria-label={visibilityTitle}
            aria-pressed={hiddenFromListing}
          >
            {notListed ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
          {/* Same rule as editing: remove-bg writes a NEW public object, so it
              is the private original that must not go through it. */}
          {photo.photo_type !== "flatlay" && removeBgEnabled && !privateOriginal && (
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
          {/* US-2278: the control is DISABLED with its reason rather than absent.
              Sensitive close-ups genuinely can't be edited — the original lives in
              the private bucket and an edited copy would have to be written back
              to the public one, republishing the PII the private bucket exists to
              hold — and a row with no storage_path has nowhere to save to. But
              silently omitting the pencil reads as "these two photos are broken",
              which is exactly how it was reported. Say why instead. */}
          <button
            type="button"
            onClick={() => onEdit(photo)}
            disabled={editBlockedReason != null}
            title={editBlockedReason ?? "Edit photo"}
            className="rounded bg-background/80 p-1 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
            aria-label={editBlockedReason ?? "Edit photo"}
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
        <PhotoTagSelect
          photoType={photo.photo_type}
          photoRole={photo.photo_role}
          garment={garment}
          profile={profile}
          onChange={(t, role) => onRetag(photo, t, role)}
          className="h-7 flex-1 text-xs"
        />
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

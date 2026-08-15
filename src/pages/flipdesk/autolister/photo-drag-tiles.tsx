import { useState, type ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { FolderInput, GripVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PhotoTagSelect } from "@/components/flipdesk/photo-tag-select";
import { usePhotoProfile } from "@/lib/photo-profiles";
import { FLIPDESK_PHOTO_TYPES } from "@/lib/constants";
import { cn } from "@/lib/utils";

// US-2520: lifted out of autolister.tsx, which was over its ratchet again.
// These six are the grouping workbench's tile-level pieces: they render one
// photo, or one drop target, and none of them reads page state. The page keeps
// the grid, the sort and the mutations.
//
// MovePhotoMenu takes a structural {id, name} list rather than the page's
// Group type on purpose. Importing that type back out of autolister.tsx would
// make the two files depend on each other to say what a menu row looks like,
// and the menu genuinely only needs those two fields.

type PhotoRole = (typeof FLIPDESK_PHOTO_TYPES)[number];

/** The subset of a group these tiles need: enough to label a menu row. */
export interface PhotoMenuGroup {
  id: string;
  name: string;
}

// ── US-1543: drag-and-drop grouping workbench pieces ─────────────────

/**
 * One photo tile as a drag source (via the GripVertical handle — the
 * photo-manager pattern, so the tile's own buttons keep working and the handle
 * is the keyboard-operable a11y affordance: focus it, Space lifts, arrows
 * move, Space drops) and, inside a group, a positional drop target so dropping
 * ON a tile inserts there (reorder / cross-group placement).
 */
export function PhotoDragTile({
  photoId,
  groupId,
  className,
  children,
}: {
  photoId: string;
  /** null = the tile lives in the Ungrouped grid. */
  groupId: string | null;
  className?: string;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: photoId, data: { fromGroupId: groupId } });
  // Ungrouped tiles aren't positional targets — their order is sort-derived
  // (US-1540/US-1550), so dropping "between" them means nothing.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `photo:${photoId}`,
    data: { groupId },
    disabled: groupId == null,
  });
  return (
    <div
      ref={(el) => {
        setDragRef(el);
        setDropRef(el);
      }}
      className={cn(
        className,
        isDragging && "opacity-40",
        groupId != null && isOver && "ring-2 ring-primary",
      )}
    >
      {children}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={groupId == null ? "Drag to add to a group" : "Drag to move or reorder"}
        title={groupId == null ? "Drag onto a group to add this photo" : "Drag to move"}
        className={cn(
          "absolute left-1 top-7 z-10 cursor-grab rounded bg-black/55 p-1 text-white focus-visible:opacity-100 active:cursor-grabbing group-hover:opacity-100",
          // US-2595: inside a group the tiles are dense and every photo already
          // has a home, so the handle stays hover-only. An UNGROUPED tile is a
          // stray the seller still has to place — its handle is the whole way
          // in, so it is always on (hover never fires on a touch screen).
          groupId == null ? "opacity-100" : "opacity-0",
        )}
      >
        <GripVertical className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Non-pointer fallback for moving a photo: a "Move to…" menu (US-1543 AC3). */
export function MovePhotoMenu({
  photoId,
  currentGroupId,
  groups,
  onMove,
  onNewGroup,
  className,
  alwaysVisible = false,
}: {
  photoId: string;
  currentGroupId: string | null;
  groups: PhotoMenuGroup[];
  onMove: (photoId: string, targetGroupId: string | null) => void;
  onNewGroup: (photoId: string) => void;
  className?: string;
  /** US-2595: on an ungrouped stray this is the pointer-free way into a group,
   *  so it is shown at all times rather than only on hover. */
  alwaysVisible?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={currentGroupId == null ? "Add to a group" : "Move to group"}
          title={currentGroupId == null ? "Add to a group…" : "Move to group…"}
          className={cn(
            "z-10 rounded-full bg-black/55 p-1 text-white focus-visible:opacity-100 group-hover:opacity-100",
            alwaysVisible ? "opacity-100" : "opacity-0",
            className,
          )}
        >
          <FolderInput className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 w-56 overflow-y-auto">
        <DropdownMenuLabel>
          {currentGroupId == null ? "Add photo to" : "Move photo to"}
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => onNewGroup(photoId)}>New group</DropdownMenuItem>
        {currentGroupId != null && (
          <DropdownMenuItem onClick={() => onMove(photoId, null)}>
            Ungrouped
          </DropdownMenuItem>
        )}
        {groups.some((g) => g.id !== currentGroupId) && <DropdownMenuSeparator />}
        {groups
          .filter((g) => g.id !== currentGroupId)
          .map((g) => (
            <DropdownMenuItem key={g.id} onClick={() => onMove(photoId, g.id)}>
              <span className="truncate">{g.name || "Untitled group"}</span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * US-2461: the per-photo tag overlay on a group tile.
 *
 * A component rather than an inline `<PhotoTagSelect>` because the picker needs
 * the item's photo profile, `usePhotoProfile` is a hook, and the tiles render
 * inside a map. There is no item yet at AutoLister time, so the group NAME is
 * the garment word — it is the title the seller typed, which is exactly what
 * the profile resolver reads everywhere else.
 */
export function GroupPhotoTag({
  groupName,
  photoType,
  photoRole,
  onChange,
}: {
  groupName: string;
  photoType: PhotoRole;
  photoRole: string | null;
  onChange: (type: PhotoRole, role: string | null) => void;
}) {
  const garment = groupName.trim() || null;
  const profile = usePhotoProfile(null, garment);
  return (
    <PhotoTagSelect
      photoType={photoType}
      photoRole={photoRole}
      garment={garment}
      profile={profile}
      onChange={onChange}
      ariaLabel="Photo role"
      className="absolute inset-x-0 bottom-0 h-auto w-full justify-center gap-1 rounded-none border-0 bg-black/60 py-0.5 text-[10px] text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    />
  );
}

/** A group card as a drop target: dropping anywhere on it appends the photos. */
export function GroupDropZone({ groupId, children }: { groupId: string; children: ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: `group:${groupId}` });
  return (
    <div
      ref={setNodeRef}
      // US-1546: scroll anchor for the checkpoint's warning links.
      id={`group-card-${groupId}`}
      className={cn("rounded-xl", isOver && "ring-2 ring-primary/60")}
    >
      {children}
    </div>
  );
}

/** The Ungrouped section as a drop target: dropping here ungroups the photos. */
export function UngroupedDropZone({ children }: { children: ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: "ungrouped" });
  return (
    <div ref={setNodeRef} className={cn("rounded-lg", isOver && "ring-2 ring-primary/60")}>
      {children}
    </div>
  );
}

// Staging thumbnails on a big batch (600 photos) arrive as one HTTP/2 burst
// that the self-hosted storage backend can 504 under. Retry each failed image
// a few times with jittered backoff (cache-busting param so the browser and
// any intermediary actually refetch) instead of leaving broken tiles.
export function StagedThumb({ src, className }: { src: string; className?: string }) {
  const [attempt, setAttempt] = useState(0);
  const url =
    attempt === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}r=${attempt}`;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className={className}
      onError={() => {
        if (attempt < 5) {
          const delay = 1_000 * 2 ** attempt + Math.random() * 1_500;
          setTimeout(() => setAttempt((a) => a + 1), delay);
        }
      }}
    />
  );
}

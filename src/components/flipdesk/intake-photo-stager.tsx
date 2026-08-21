import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PhotoTagSelect, slotKey } from "@/components/flipdesk/photo-tag-select";
import {
  missingRequiredRoles,
  usePhotoProfile,
  type PhotoRole,
} from "@/lib/photo-profiles";
import type { FlipdeskPhotoType } from "@/types/database";

// US-2546 AC2. Intake had no photo field at all: a seller cataloguing an item
// had to save it, find it again, open it, and photograph it there — or switch
// to ?mode=snap, which is a different form. The phone app shoots at intake, so
// the web form was the odd one out.
//
// Photos cannot be UPLOADED here, because item_photos rows need an
// inventory_item_id that does not exist until save. So they are staged in
// memory with an assigned slot, and the page uploads them (through the same
// uploadItemPhoto core the item page uses) the moment the row comes back.
//
// US-2769 AC1. This used to carry its OWN four-entry list of photo types with
// its own labels and no hints, and it asked for the type from a dropdown AFTER
// the shot was taken. That was a fifth copy of a vocabulary that already has a
// server-authoritative table, and it meant the web never told a seller which
// shot it wanted — the thing iOS has done since US-2134. The slots below come
// from usePhotoProfile (server table, bundled fallback until it loads), which
// is the same source the item page and the phone use.

export interface StagedPhoto {
  id: string;
  file: File;
  previewUrl: string;
  photoType: FlipdeskPhotoType;
  /** The qualifier saying what this photo shows; null for a slot that takes none. */
  photoRole?: string | null;
}

/** Slot identity is (type, role), so a suit can hold three separate tag slots. */
const keyOf = (p: { photoType: FlipdeskPhotoType; photoRole?: string | null }) =>
  slotKey(p.photoType, p.photoRole ?? null);

const roleKeyOf = (r: PhotoRole) => slotKey(r.type, r.role ?? null);

/**
 * Where an unaimed photo lands: the first unfilled slot the profile declares,
 * required ones first, then a bare detail once the profile is full. A seller
 * who picked six files at once still gets a front and a back tagged, and can
 * correct anything with the per-photo picker.
 */
function nextSlotFor(
  existing: StagedPhoto[],
  roles: PhotoRole[],
): { photoType: FlipdeskPhotoType; photoRole: string | null } {
  const used = new Set(existing.map(keyOf));
  const ordered = [
    ...roles.filter((r) => r.required),
    ...roles.filter((r) => !r.required),
  ];
  const free = ordered.find((r) => !used.has(roleKeyOf(r)));
  return free
    ? { photoType: free.type, photoRole: free.role ?? null }
    : { photoType: "detail", photoRole: null };
}

export function IntakePhotoStager({
  photos,
  onChange,
  disabled,
  category,
  garment,
}: {
  photos: StagedPhoto[];
  onChange: (next: StagedPhoto[]) => void;
  disabled?: boolean;
  /** item_category enum — picks the profile, exactly as on the item page. */
  category?: string | null;
  /** Free-text garment word, for the clothing sub-profiles (US-2465). */
  garment?: string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  // Which slot the next pick belongs to, or null for the unaimed "Add photos"
  // button. Set on the click that opens the picker, read when files arrive.
  const aimedRef = useRef<{
    photoType: FlipdeskPhotoType;
    photoRole: string | null;
  } | null>(null);
  const [counter, setCounter] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const profile = usePhotoProfile(category ?? null, garment);
  const requiredRoles = profile.roles.filter((r) => r.required);
  const optionalRoles = profile.roles.filter((r) => !r.required);

  // Object URLs are a leak if nobody revokes them, and this form can stage and
  // clear several batches in one session (Save & Add another).
  useEffect(() => {
    const urls = photos.map((p) => p.previewUrl);
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
    // Only on unmount: revoking on every change would kill the URLs of photos
    // still on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openPicker(
    which: "camera" | "library",
    slot: { photoType: FlipdeskPhotoType; photoRole: string | null } | null,
  ) {
    aimedRef.current = slot;
    (which === "camera" ? cameraRef : fileRef).current?.click();
  }

  function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    const aimed = aimedRef.current;
    aimedRef.current = null;
    let n = counter;
    const next = [...photos];
    for (const [i, file] of Array.from(files).entries()) {
      // Only the FIRST file of an aimed pick takes the slot it was aimed at;
      // a multi-select into one slot would otherwise stack every shot on it.
      const slot = aimed && i === 0 ? aimed : nextSlotFor(next, profile.roles);
      next.push({
        id: `staged-${n++}`,
        file,
        previewUrl: URL.createObjectURL(file),
        photoType: slot.photoType,
        photoRole: slot.photoRole,
      });
    }
    setCounter(n);
    onChange(next);
  }

  function remove(id: string) {
    const gone = photos.find((p) => p.id === id);
    if (gone) URL.revokeObjectURL(gone.previewUrl);
    onChange(photos.filter((p) => p.id !== id));
  }

  function setSlot(
    id: string,
    photoType: FlipdeskPhotoType,
    photoRole: string | null,
  ) {
    onChange(
      photos.map((p) => (p.id === id ? { ...p, photoType, photoRole } : p)),
    );
  }

  const inSlot = (r: PhotoRole) => photos.find((p) => keyOf(p) === roleKeyOf(r));

  // Photos that sit on no slot this profile declares — a bulk overflow, or a
  // slot the seller retagged by hand. They still need a tile and a picker.
  const declared = new Set(profile.roles.map(roleKeyOf));
  const extras = photos.filter((p) => !declared.has(keyOf(p)));

  // The same gate the item page advances "photographed" on, shared rather than
  // restated here. For clothing the profile's required set is exactly
  // REQUIRED_PHOTO_TYPES: front + back.
  const missing = missingRequiredRoles(profile, photos);

  // Photos are optional at intake, and a clothing profile declares a dozen
  // slots. Leading with all of them makes an optional section look like a
  // twelve-shot chore, so the required ones and anything already shot are on
  // screen and the rest are one click away — still named, never inferred.
  const shownOptional = showAll
    ? optionalRoles
    : optionalRoles.filter((r) => inSlot(r));
  const hiddenCount = optionalRoles.length - shownOptional.length;

  function tile(r: PhotoRole) {
    const staged = inSlot(r);
    return (
      <li key={roleKeyOf(r)} className="space-y-1.5">
        <div className="relative aspect-square overflow-hidden rounded-xl border bg-muted">
          {staged ? (
            <>
              <img
                src={staged.previewUrl}
                alt=""
                className="h-full w-full object-cover"
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={() => remove(staged.id)}
                aria-label={`Remove ${r.label} photo`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                openPicker("camera", {
                  photoType: r.type,
                  photoRole: r.role ?? null,
                })
              }
              className="flex h-full w-full flex-col items-center justify-center gap-1 p-3 text-center disabled:opacity-50"
            >
              <Camera className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs font-medium">{r.label}</span>
              {/* The hint is the whole point of the slot: it says what to put
                  in frame, in the same words the phone uses. */}
              <span className="text-[10px] leading-snug text-muted-foreground">
                {r.hint}
              </span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{r.label}</span>
          {r.required && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              Required
            </Badge>
          )}
        </div>
        {staged && (
          <PhotoTagSelect
            photoType={staged.photoType}
            photoRole={staged.photoRole ?? null}
            garment={garment}
            profile={profile}
            onChange={(t, role) => setSlot(staged.id, t, role)}
            className="h-8 text-xs"
            ariaLabel={`Photo type for the ${r.label} shot`}
          />
        )}
      </li>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => openPicker("library", null)}
        >
          <ImagePlus className="mr-2 h-4 w-4" />
          Add photos
        </Button>
        <span className="text-xs text-muted-foreground">
          {photos.length > 0
            ? `${photos.length} photo${photos.length === 1 ? "" : "s"} ready to upload`
            : `Tap a shot below to take it — ${profile.label.toLowerCase()} slots`}
        </span>
      </div>

      {/* `capture` opens the camera straight away on a phone; the second input
          is the ordinary picker, because a desktop seller has the shots on
          disk already. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {requiredRoles.map(tile)}
        {shownOptional.map(tile)}
        {extras.map((p) => (
          <li key={p.id} className="space-y-1.5">
            <div className="relative aspect-square overflow-hidden rounded-xl border bg-muted">
              <img
                src={p.previewUrl}
                alt=""
                className="h-full w-full object-cover"
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={() => remove(p.id)}
                aria-label="Remove photo"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Label htmlFor={`slot-${p.id}`} className="sr-only">
              Photo type
            </Label>
            <PhotoTagSelect
              photoType={p.photoType}
              photoRole={p.photoRole ?? null}
              garment={garment}
              profile={profile}
              onChange={(t, role) => setSlot(p.id, t, role)}
              className="h-8 text-xs"
              ariaLabel="Photo type"
            />
          </li>
        ))}
      </ul>

      {hiddenCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setShowAll(true)}
        >
          {hiddenCount} more shot{hiddenCount === 1 ? "" : "s"} for this
          {" "}
          {profile.label.toLowerCase()}
        </Button>
      )}

      {/* US-2769 AC3: this used to be gated on photos.length > 0, so the seller
          who had taken NO photos — the one most likely to save without a front
          — was told nothing at all. */}
      {missing.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Still missing{" "}
          {missing.map((r) => (
            <Badge
              key={roleKeyOf(r)}
              variant="outline"
              className="mx-0.5 text-[10px]"
            >
              {r.label}
            </Badge>
          ))}
          . You can add them later from the item page.
        </p>
      )}
    </div>
  );
}

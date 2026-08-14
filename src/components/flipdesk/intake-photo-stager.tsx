import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { REQUIRED_PHOTO_TYPES } from "@/lib/constants";
import type { FlipdeskPhotoType } from "@/types/database";

// US-2546 AC2. Intake had no photo field at all: a seller cataloguing an item
// had to save it, find it again, open it, and photograph it there — or switch
// to ?mode=snap, which is a different form. The phone app shoots at intake, so
// the web form was the odd one out.
//
// Photos cannot be UPLOADED here, because item_photos rows need an
// inventory_item_id that does not exist until save. So they are staged in
// memory with an assigned type, and the page uploads them (through the same
// uploadItemPhoto core the item page uses) the moment the row comes back.

export interface StagedPhoto {
  id: string;
  file: File;
  previewUrl: string;
  photoType: FlipdeskPhotoType;
}

// The four an item is usually catalogued with. The full slot grid lives on the
// item page, where the category is settled and the required set is known.
const INTAKE_TYPES: { value: FlipdeskPhotoType; label: string }[] = [
  { value: "front", label: "Front" },
  { value: "back", label: "Back" },
  { value: "tag", label: "Tag" },
  { value: "detail", label: "Detail" },
];

function nextTypeFor(existing: StagedPhoto[]): FlipdeskPhotoType {
  const used = new Set(existing.map((p) => p.photoType));
  const free = INTAKE_TYPES.find((t) => !used.has(t.value));
  return free?.value ?? "detail";
}

export function IntakePhotoStager({
  photos,
  onChange,
  disabled,
}: {
  photos: StagedPhoto[];
  onChange: (next: StagedPhoto[]) => void;
  disabled?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [counter, setCounter] = useState(0);

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

  function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    let n = counter;
    const next = [...photos];
    for (const file of Array.from(files)) {
      next.push({
        id: `staged-${n++}`,
        file,
        previewUrl: URL.createObjectURL(file),
        photoType: nextTypeFor(next),
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

  function setType(id: string, photoType: FlipdeskPhotoType) {
    onChange(photos.map((p) => (p.id === id ? { ...p, photoType } : p)));
  }

  const missing = REQUIRED_PHOTO_TYPES.filter(
    (t) => !photos.some((p) => p.photoType === t),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => cameraRef.current?.click()}
        >
          <Camera className="mr-2 h-4 w-4" />
          Take photo
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus className="mr-2 h-4 w-4" />
          Add photos
        </Button>
        {photos.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {photos.length} photo{photos.length === 1 ? "" : "s"} ready to upload
          </span>
        )}
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

      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id} className="space-y-1.5">
              <div className="relative aspect-square overflow-hidden rounded-lg border bg-muted">
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
              <Label htmlFor={`type-${p.id}`} className="sr-only">
                Photo type
              </Label>
              <Select
                value={p.photoType}
                onValueChange={(v) => setType(p.id, v as FlipdeskPhotoType)}
              >
                <SelectTrigger id={`type-${p.id}`} className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTAKE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          ))}
        </ul>
      )}

      {photos.length > 0 && missing.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Still missing{" "}
          {missing.map((t) => (
            <Badge key={t} variant="outline" className="mx-0.5 text-[10px]">
              {t}
            </Badge>
          ))}
          . You can add them later from the item page.
        </p>
      )}
    </div>
  );
}

import { useEffect, useId, useMemo, useState } from "react";
import { Upload, X } from "lucide-react";
import { addEvidenceFiles, MAX_DISPUTE_EVIDENCE } from "@/lib/dispute-evidence";

// SUB-10: the dispute dialog's photo picker. A labelled file input, a running
// "3 of 8" count, and real thumbnails whose remove control is a button, so a
// keyboard user can take one back out. The old chips were mouse-only spans
// showing names like IMG_4821.JPG.

const PREVIEW_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// A thumbnail src built from the picked file. Only an image type the picker
// accepts gets one, and only a same-origin blob: URL is ever handed to <img>,
// so nothing taken from the file input can reach the DOM as markup or a
// script URL (CodeQL js/xss-through-dom on PR 357).
function previewUrl(file: File): string {
  if (!PREVIEW_TYPES.has(file.type)) return "";
  const url = URL.createObjectURL(file);
  return url.startsWith("blob:") ? url : "";
}

export function DisputeEvidencePicker({
  photos,
  onChange,
  disabled,
}: {
  photos: File[];
  onChange: (next: File[]) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const [refused, setRefused] = useState(0);
  const full = photos.length >= MAX_DISPUTE_EVIDENCE;

  // One object URL per file, revoked when the file leaves the selection.
  const urls = useMemo(() => photos.map(previewUrl), [photos]);
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls]);

  function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    const { photos: next, refused: n } = addEvidenceFiles(photos, Array.from(files));
    setRefused(n);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={inputId}
          aria-disabled={full || disabled}
          className={
            "inline-flex h-8 cursor-pointer items-center rounded-md border px-3 text-sm font-medium hover:bg-muted focus-within:ring-2 focus-within:ring-ring" +
            (full || disabled ? " pointer-events-none opacity-50" : "")
          }
        >
          <Upload className="mr-1 h-4 w-4" aria-hidden="true" />
          Add photos
          <input
            id={inputId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="sr-only"
            disabled={full || disabled}
            aria-label="Add evidence photos"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {photos.length} of {MAX_DISPUTE_EVIDENCE}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        JPEG, PNG or WebP. HEIC photos from an iPhone are not supported yet.
      </p>
      {refused > 0 && (
        <p role="alert" className="text-sm text-brand-red-text">
          You can attach up to {MAX_DISPUTE_EVIDENCE} photos. {refused} photo
          {refused !== 1 ? "s were" : " was"} not added.
        </p>
      )}
      {photos.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Selected evidence photos">
          {photos.map((photo, i) => (
            <li key={`${photo.name}-${i}`} className="relative h-16 w-16">
              {urls[i] ? (
                <img
                  src={urls[i]}
                  alt={`Evidence photo ${i + 1}`}
                  className="h-16 w-16 rounded-md border object-cover"
                />
              ) : (
                <span className="flex h-16 w-16 items-center justify-center rounded-md border text-xs text-muted-foreground">
                  Photo {i + 1}
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove photo ${i + 1}`}
                disabled={disabled}
                onClick={() => {
                  setRefused(0);
                  onChange(photos.filter((_, idx) => idx !== i));
                }}
                className="absolute -right-2 -top-2 inline-flex h-6 w-6 items-center justify-center rounded-full border bg-background hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

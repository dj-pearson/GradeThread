import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  ImagePlus,
  Shirt,
  Tag,
  Search,
  AlertTriangle,
  Ruler,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  IN_APP_CAPTURE_SOURCE,
  LIBRARY_CAPTURE_SOURCE,
  type PhotoCaptureSource,
} from "@/lib/photo-capture-contract";
import { validateImage, compressImage, extractExif } from "@/lib/image-utils";
import {
  assessMacroPhoto,
  measureMacroPhoto,
  uploadMaxWidthFor,
} from "@/lib/macro-photo-quality";
import { normalizeToImageFile } from "@/lib/media-intake";
import {
  CameraCaptureDialog,
  isCameraCaptureSupported,
} from "@/components/submission/camera-capture-dialog";
import type { ImageType, ImageExifMetadata } from "@/types/database";

export interface PhotoUploadItem {
  file: File;
  imageType: ImageType;
  preview: string;
  // 64-bit dHash (16 hex chars) of the photo for reuse detection (US-337).
  phash?: string;
  // US-339: provenance EXIF read from the ORIGINAL file before compression
  // (camera make/model, capture time, GPS). Null/absent is normal.
  exif?: ImageExifMetadata | null;
  // US-339: the uncompressed original, kept so the caller can optionally upload
  // it for forensic/provenance retention (gated). The compressed `file` is what
  // the fast grading path uses.
  originalFile?: File;
  // US-2136 AC4: 0..1 measured sharpness of the COMPRESSED bytes, or null when
  // it could not be measured. Sent with the upload so authenticity confidence
  // can read a MEASURE instead of "a file exists in the macro slot".
  qualityScore?: number | null;
  // US-2802: where this photo came from. NOT optional, and never inferred —
  // the live-capture badge is a fraud claim, so an unknown origin has to be
  // spelled `library` by whoever put the file here rather than left absent
  // for a reader to guess at.
  captureSource: PhotoCaptureSource;
}

type SlotGroup = "required" | "more" | "measurements" | "defects";

interface UploadSlot {
  imageType: ImageType;
  label: string;
  required: boolean;
  icon: React.ElementType;
  description: string;
  // US-948: one-line shoot hint surfaced under required slots so first-time
  // graders frame a gradeable photo before they land in the low-confidence
  // retake loop.
  hint?: string;
  slotKey: string;
  group: SlotGroup;
}

// Section headers + helper copy, rendered in this order.
const SLOT_GROUPS: { group: SlotGroup; title: string; hint?: string }[] = [
  { group: "required", title: "Required" },
  {
    group: "more",
    title: "More tags & details",
    hint: "Add a second tag (e.g. a separate size tag) and extra close-ups.",
  },
  {
    group: "measurements",
    title: "Measurements",
    hint: "No size tag? Lay the garment flat and shoot a tape measure across each point — helps us identify the size (great for Lululemon and other untagged items).",
  },
  { group: "defects", title: "Defects" },
];

const UPLOAD_SLOTS: UploadSlot[] = [
  {
    imageType: "front",
    label: "Front",
    required: true,
    icon: Shirt,
    description: "Full front view of garment",
    hint: "Lay flat, full garment in frame, neutral background.",
    slotKey: "front",
    group: "required",
  },
  {
    imageType: "back",
    label: "Back",
    required: true,
    icon: Shirt,
    description: "Full back view of garment",
    hint: "Flip it over — full back, same flat framing.",
    slotKey: "back",
    group: "required",
  },
  {
    imageType: "label",
    label: "Label",
    required: true,
    icon: Tag,
    description: "Brand and care label",
    hint: "Fill the frame with the tag — text must be legible.",
    slotKey: "label",
    group: "required",
  },
  {
    imageType: "detail",
    label: "Detail",
    required: true,
    icon: Search,
    description: "Close-up of key feature",
    hint: "Sharp close-up of a key feature, seam, or flaw.",
    slotKey: "detail-1",
    group: "required",
  },
  {
    imageType: "label_2",
    label: "Tag 2",
    required: false,
    icon: Tag,
    description: "Second / size tag (optional)",
    slotKey: "label-2",
    group: "more",
  },
  {
    imageType: "detail_2",
    label: "Detail 2",
    required: false,
    icon: Search,
    description: "Additional detail (optional)",
    slotKey: "detail-2",
    group: "more",
  },
  {
    imageType: "detail_3",
    label: "Detail 3",
    required: false,
    icon: Search,
    description: "Additional detail (optional)",
    slotKey: "detail-3",
    group: "more",
  },
  {
    imageType: "detail_4",
    label: "Detail 4",
    required: false,
    icon: Search,
    description: "Additional detail (optional)",
    slotKey: "detail-4",
    group: "more",
  },
  {
    imageType: "measurement_chest",
    label: "Chest / Bust",
    required: false,
    icon: Ruler,
    description: "Tape measure, pit-to-pit",
    slotKey: "measurement-chest",
    group: "measurements",
  },
  {
    imageType: "measurement_waist",
    label: "Waist",
    required: false,
    icon: Ruler,
    description: "Tape measure across waist",
    slotKey: "measurement-waist",
    group: "measurements",
  },
  {
    imageType: "measurement_length",
    label: "Length",
    required: false,
    icon: Ruler,
    description: "Tape measure, top to hem",
    slotKey: "measurement-length",
    group: "measurements",
  },
  {
    imageType: "measurement_sleeve",
    label: "Sleeve",
    required: false,
    icon: Ruler,
    description: "Tape measure along sleeve",
    slotKey: "measurement-sleeve",
    group: "measurements",
  },
  {
    imageType: "measurement_inseam",
    label: "Inseam",
    required: false,
    icon: Ruler,
    description: "Tape measure along inseam",
    slotKey: "measurement-inseam",
    group: "measurements",
  },
  {
    imageType: "defect",
    label: "Defect 1",
    required: false,
    icon: AlertTriangle,
    description: "Damage or flaw (optional)",
    slotKey: "defect-1",
    group: "defects",
  },
  {
    imageType: "defect",
    label: "Defect 2",
    required: false,
    icon: AlertTriangle,
    description: "Additional defect (optional)",
    slotKey: "defect-2",
    group: "defects",
  },
  {
    imageType: "defect",
    label: "Defect 3",
    required: false,
    icon: AlertTriangle,
    description: "Additional defect (optional)",
    slotKey: "defect-3",
    group: "defects",
  },
];

// US-949: map a list of stored image_types to upload slotKeys, honoring slots
// that legitimately share an image_type (defect ×3). Returns null at an index
// whose type has no remaining free slot. Used to re-stage a retake's passing
// photos into the right slots.
export function assignSlotKeys(imageTypes: ImageType[]): (string | null)[] {
  const used = new Set<string>();
  return imageTypes.map((type) => {
    const slot = UPLOAD_SLOTS.find(
      (s) => s.imageType === type && !used.has(s.slotKey)
    );
    if (slot) {
      used.add(slot.slotKey);
      return slot.slotKey;
    }
    return null;
  });
}

// US-948: lightweight inline-SVG framing examples for each required slot. Shows
// the seller roughly what a gradeable shot looks like before they take it — no
// binary assets to load, scales crisply at any slot size, and inherits
// `currentColor` so it themes automatically.
function ExampleThumbnail({ slotKey }: { slotKey: string }) {
  const common = {
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinejoin: "round" as const,
    strokeLinecap: "round" as const,
    className: "h-10 w-10",
    "aria-hidden": true,
  };
  switch (slotKey) {
    case "front":
      return (
        <svg {...common}>
          <path d="M18 9l-7 4 2 6 3-1v15h16V18l3 1 2-6-7-4-3 3h-9z" />
        </svg>
      );
    case "back":
      return (
        <svg {...common}>
          <path d="M18 9l-7 4 2 6 3-1v15h16V18l3 1 2-6-7-4h-12z" />
          <path d="M21 9c0 2 6 2 6 0" />
        </svg>
      );
    case "label":
      return (
        <svg {...common}>
          <path d="M12 16h17l7 8-7 8H12z" />
          <path d="M30 22v4" />
          <path d="M16 23h7M16 27h10" />
        </svg>
      );
    case "detail-1":
      return (
        <svg {...common}>
          <circle cx="22" cy="22" r="9" />
          <path d="M29 29l7 7" />
          <path d="M19 22h6M22 19v6" />
        </svg>
      );
    default:
      return null;
  }
}

interface SlotState {
  file: File | null;
  preview: string | null;
  errors: string[];
  // US-2136: macro-quality nudges. Kept SEPARATE from `errors` on purpose — a
  // quality warning never blocks the upload, it offers a retake. Collapsing the
  // two would either block a photo Claude Vision would have read fine, or
  // render a real validation failure as a soft suggestion.
  warnings: string[];
  isProcessing: boolean;
  phash?: string;
  exif?: ImageExifMetadata | null;
  originalFile?: File;
  // US-2136 AC4: the assessment's continuous score, kept on pass AND fail.
  qualityScore?: number | null;
  // US-2802: set when the file lands; absent on an empty slot.
  captureSource?: PhotoCaptureSource;
}

const DEFAULT_SLOT_STATE: SlotState = {
  file: null,
  preview: null,
  errors: [],
  warnings: [],
  isProcessing: false,
};

function getSlot(slots: Map<string, SlotState>, key: string): SlotState {
  return slots.get(key) ?? DEFAULT_SLOT_STATE;
}

interface PhotoUploadProps {
  onChange: (items: PhotoUploadItem[]) => void;
  // US-952: photos to pre-stage into specific slots on mount (e.g. the
  // Snap-to-Value photo into "front"). Each file is run through the SAME
  // validate → compress path as a manual upload. Seeding only fills a slot
  // that is currently empty, so it never clobbers a user-chosen photo.
  initialPhotos?: { slotKey: string; file: File }[];
  // US-949: slotKeys the grader flagged on a retake — drawn with an amber ring
  // and a "Retake this photo" hint so the seller knows exactly which to redo.
  highlightSlotKeys?: string[];
}

export function PhotoUpload({
  onChange,
  initialPhotos,
  highlightSlotKeys,
}: PhotoUploadProps) {
  const [slots, setSlots] = useState<Map<string, SlotState>>(() => {
    const initial = new Map<string, SlotState>();
    for (const slot of UPLOAD_SLOTS) {
      initial.set(slot.slotKey, { ...DEFAULT_SLOT_STATE });
    }
    return initial;
  });

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // US-1636: previews are object URLs. Replace/remove revoke the old one, but
  // navigating away with photos still staged leaked every live preview. Mirror
  // the current slots into a ref so an unmount-only cleanup can revoke them all.
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  useEffect(() => {
    return () => {
      for (const slot of slotsRef.current.values()) {
        if (slot.preview) URL.revokeObjectURL(slot.preview);
      }
    };
  }, []);

  // US-947: which slot (if any) is mid live-capture, plus a one-time
  // feature-detect so the "Take photo" affordance only appears where
  // getUserMedia is actually available (secure context + camera-capable
  // browser). Camera-incapable devices simply keep the file picker.
  const [cameraSlotKey, setCameraSlotKey] = useState<string | null>(null);
  const [cameraSupported] = useState(() => isCameraCaptureSupported());

  const emitChange = useCallback(
    (updatedSlots: Map<string, SlotState>) => {
      const items: PhotoUploadItem[] = [];
      for (const slot of UPLOAD_SLOTS) {
        const state = getSlot(updatedSlots, slot.slotKey);
        if (state.file && state.preview) {
          items.push({
            file: state.file,
            imageType: slot.imageType,
            preview: state.preview,
            phash: state.phash,
            exif: state.exif,
            originalFile: state.originalFile,
            qualityScore: state.qualityScore ?? null,
            // Fails CLOSED: an origin nobody recorded is a library photo, not
            // a live one. The opposite default would hand out the strongest
            // provenance badge on a bookkeeping slip.
            captureSource: state.captureSource ?? LIBRARY_CAPTURE_SOURCE,
          });
        }
      }
      onChange(items);
    },
    [onChange]
  );

  const processFile = useCallback(
    async (
      slotKey: string,
      rawFile: File,
      // US-2802: defaulted so the picker, the drop target and the US-952
      // seeding path need no change AND state the truth — none of them
      // watched the photo being taken. Only the camera dialog overrides it.
      captureSource: PhotoCaptureSource = LIBRARY_CAPTURE_SOURCE,
    ) => {
      setSlots((prev) => {
        const next = new Map(prev);
        const current = getSlot(prev, slotKey);
        next.set(slotKey, {
          ...current,
          isProcessing: true,
          errors: [],
          warnings: [],
        });
        return next;
      });

      // US-1300: normalize odd iPhone inputs before validation — a Live Photo
      // exported as a .mov/.mp4 video becomes a still JPEG frame and HEIC/HEIF
      // becomes JPEG, so they pass the JPEG/PNG/WebP validator below instead of
      // being rejected outright.
      let file: File;
      try {
        file = await normalizeToImageFile(rawFile);
      } catch (err) {
        const message = err instanceof Error
          ? err.message
          : "Couldn't convert this file. Re-export it as a JPEG and try again.";
        setSlots((prev) => {
          const next = new Map(prev);
          const current = getSlot(prev, slotKey);
          next.set(slotKey, {
            ...current,
            isProcessing: false,
            errors: [message],
            warnings: [],
          });
          return next;
        });
        return;
      }

      const validation = await validateImage(file);
      if (!validation.valid) {
        const errors = validation.errors.map((e) => e.message);
        setSlots((prev) => {
          const next = new Map(prev);
          const current = getSlot(prev, slotKey);
          next.set(slotKey, { ...current, isProcessing: false, errors, warnings: [] });
          return next;
        });
        return;
      }

      // One resolution of the slot's server photo_type, used by BOTH the upload
      // cap and the quality gate — they must agree about which slot this is or
      // a macro shot gets judged against a floor its own cap never targeted.
      const slotImageType = UPLOAD_SLOTS.find(
        (s) => s.slotKey === slotKey,
      )?.imageType;

      try {
        // US-339: read provenance EXIF from the ORIGINAL file BEFORE the canvas
        // re-encode in compressImage destroys it. Best-effort — never blocks.
        const exif = await extractExif(file).catch(() => null);
        // US-2135: the tag/detail slots keep more pixels than front/back, so a
        // crop of the label region has something to magnify later. Scoped, not
        // global — see uploadMaxWidthFor.
        const compressed = await compressImage(file, uploadMaxWidthFor(slotImageType));
        const compressedFile = new File([compressed.blob], file.name, {
          type: compressed.blob.type,
        });
        const preview = URL.createObjectURL(compressed.blob);

        // US-2136: assess the COMPRESSED blob, not the original — those are the
        // pixels the model actually receives, so a 4000px capture that
        // compressImage caps down to a soft 1000px tag must be judged on what
        // it becomes, not on what the camera produced. Best-effort: a decode or
        // canvas failure returns nulls, which assessMacroPhoto reads as
        // "cannot tell" and passes.
        const macro = assessMacroPhoto(
          await measureMacroPhoto(compressed.blob, slotImageType),
        );

        setSlots((prev) => {
          const current = getSlot(prev, slotKey);
          if (current.preview) {
            URL.revokeObjectURL(current.preview);
          }
          const next = new Map(prev);
          next.set(slotKey, {
            file: compressedFile,
            preview,
            errors: [],
            warnings: macro.message ? [macro.message] : [],
            isProcessing: false,
            phash: compressed.phash,
            exif,
            originalFile: file,
            qualityScore: macro.score,
            captureSource,
          });
          emitChange(next);
          return next;
        });
      } catch {
        setSlots((prev) => {
          const next = new Map(prev);
          const current = getSlot(prev, slotKey);
          next.set(slotKey, {
            ...current,
            isProcessing: false,
            errors: ["Failed to process image. Please try another file."],
            warnings: [],
          });
          return next;
        });
      }
    },
    [emitChange]
  );

  const handleFileSelect = useCallback(
    (slotKey: string, file: File | undefined) => {
      if (!file) return;
      processFile(slotKey, file);
    },
    [processFile]
  );

  // US-952: pre-stage any seeded photos once, routing each through processFile
  // (the standard validate + compress path) so the front slot fills exactly as
  // if the user had picked it. The ref makes this run a single time even though
  // the parent may pass a fresh `initialPhotos` array on each render.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !initialPhotos || initialPhotos.length === 0) {
      return;
    }
    seededRef.current = true;
    for (const { slotKey, file } of initialPhotos) {
      if (!getSlot(slots, slotKey).file) {
        processFile(slotKey, file);
      }
    }
    // Mount-once seeding; slots/processFile are intentionally not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPhotos]);

  const handleDrop = useCallback(
    (slotKey: string, e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) {
        processFile(slotKey, file);
      }
    },
    [processFile]
  );

  const handleRemove = useCallback(
    (slotKey: string) => {
      setSlots((prev) => {
        const current = getSlot(prev, slotKey);
        if (current.preview) {
          URL.revokeObjectURL(current.preview);
        }
        const next = new Map(prev);
        next.set(slotKey, { ...DEFAULT_SLOT_STATE });
        emitChange(next);
        return next;
      });
      const input = fileInputRefs.current[slotKey];
      if (input) input.value = "";
    },
    [emitChange]
  );

  function renderSlot(slot: UploadSlot) {
    const state = getSlot(slots, slot.slotKey);
    const Icon = slot.icon;
    // US-949: this slot was flagged by the grader on a retake — emphasise it so
    // the seller redoes exactly the photos that came back unusable.
    const flagged = highlightSlotKeys?.includes(slot.slotKey) ?? false;

    return (
      <div key={slot.slotKey} className="space-y-1">
        <div
          className={cn(
            "group relative flex aspect-square cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors",
            state.preview
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-primary/50 hover:bg-accent/50",
            // US-948: draw the eye to required slots that still need a photo.
            slot.required && !state.preview && "border-primary/40",
            flagged &&
              !state.preview &&
              "border-amber-500 bg-amber-50 hover:border-amber-500 dark:bg-amber-950/30",
            state.isProcessing && "pointer-events-none opacity-60",
            state.errors.length > 0 && "border-destructive/50"
          )}
          role="button"
          tabIndex={0}
          aria-label={`Upload ${slot.label} photo`}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={(e) => handleDrop(slot.slotKey, e)}
          onClick={() => fileInputRefs.current[slot.slotKey]?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRefs.current[slot.slotKey]?.click();
            }
          }}
        >
          <input
            ref={(el) => {
              fileInputRefs.current[slot.slotKey] = el;
            }}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,video/*,.mov,.mp4,.m4v"
            className="hidden"
            onChange={(e) =>
              handleFileSelect(slot.slotKey, e.target.files?.[0])
            }
          />

          {state.isProcessing ? (
            <div
              className="flex flex-col items-center gap-2"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <div
                className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
                aria-hidden="true"
              />
              <span className="text-xs text-muted-foreground">
                Processing {slot.label} photo…
              </span>
            </div>
          ) : state.preview ? (
            <>
              <img
                src={state.preview}
                alt={slot.label}
                className="h-full w-full rounded-lg object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${slot.label} photo`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(slot.slotKey);
                }}
                className="absolute right-1 top-1 rounded-full bg-destructive p-1 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-1.5 p-2 text-center">
              {/* US-948: required slots show a framing example; optional slots
                  keep the plain category icon. */}
              {slot.required ? (
                <div className="text-primary/70" aria-hidden="true">
                  <ExampleThumbnail slotKey={slot.slotKey} />
                </div>
              ) : (
                <div className="rounded-full bg-muted p-2">
                  <Icon className="h-5 w-5 text-muted-foreground" />
                </div>
              )}
              <div className="flex items-center gap-1">
                <ImagePlus className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-medium">
                  {slot.label}
                  {slot.required && (
                    <span className="text-destructive"> *</span>
                  )}
                </span>
              </div>
              <span className="text-[10px] leading-tight text-muted-foreground">
                {slot.description}
              </span>
              {/* US-947: live-capture affordance alongside the file picker
                  (the slot body itself triggers upload). Only shown where
                  getUserMedia is available; otherwise the file picker stands
                  alone. stopPropagation so the tap doesn't also open the
                  file dialog. */}
              {cameraSupported && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCameraSlotKey(slot.slotKey);
                  }}
                  className="mt-0.5 inline-flex items-center gap-1 rounded-md border border-primary/30 px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10"
                >
                  <Camera className="h-3 w-3" />
                  Take photo
                </button>
              )}
            </div>
          )}
        </div>

        {state.errors.length > 0 && (
          <div className="space-y-0.5">
            {state.errors.map((error, i) => (
              <p
                key={i}
                className="text-[10px] leading-tight text-destructive"
              >
                {error}
              </p>
            ))}
          </div>
        )}

        {/* US-2136 AC3: in-capture guidance, amber not destructive. The photo
            IS accepted — this offers a retake and says what to change, because
            "low resolution" tells a seller nothing they can act on. Rendered
            above the flag/hint lines so the newest, most specific feedback is
            the one nearest the slot. */}
        {state.warnings.length > 0 && state.errors.length === 0 && (
          <div className="space-y-0.5">
            {state.warnings.map((warning, i) => (
              <p
                key={i}
                className="text-[10px] leading-tight text-amber-600 dark:text-amber-400"
              >
                {warning}
              </p>
            ))}
          </div>
        )}

        {flagged && !state.preview && state.errors.length === 0 && (
          <p className="text-[10px] font-medium leading-tight text-amber-600 dark:text-amber-400">
            Retake this photo
          </p>
        )}

        {/* US-948: per-slot shoot hint. Rendered under the tap target (not
            inside it) so the slot stays full-size on the 2-col mobile grid. */}
        {slot.hint && !state.preview && !flagged && state.errors.length === 0 &&
          state.warnings.length === 0 && (
          <p className="text-[10px] leading-tight text-muted-foreground">
            {slot.hint}
          </p>
        )}
      </div>
    );
  }

  // US-948: completeness progress over the required slots — surfaced as
  // "N of M required photos" plus an explicit list of which are still missing.
  const requiredSlots = UPLOAD_SLOTS.filter((s) => s.required);
  const missingRequired = requiredSlots.filter(
    (s) => !getSlot(slots, s.slotKey).file
  );
  const filledRequired = requiredSlots.length - missingRequired.length;
  const allRequiredComplete = missingRequired.length === 0;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Camera className="h-4 w-4" />
            <span>Required photos</span>
          </div>
          <span className="flex items-center gap-1 text-sm font-medium tabular-nums">
            {allRequiredComplete && (
              <Check
                className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            )}
            {filledRequired} of {requiredSlots.length}
          </span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={filledRequired}
          aria-valuemin={0}
          aria-valuemax={requiredSlots.length}
          aria-label="Required photos uploaded"
        >
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{
              width: `${(filledRequired / requiredSlots.length) * 100}%`,
            }}
          />
        </div>
        {allRequiredComplete ? (
          <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            All {requiredSlots.length} required photos added.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Still need:{" "}
            <span className="font-medium text-foreground">
              {missingRequired.map((s) => s.label).join(", ")}
            </span>
          </p>
        )}
      </div>

      {SLOT_GROUPS.map(({ group, title, hint }) => {
        const groupSlots = UPLOAD_SLOTS.filter((s) => s.group === group);
        if (groupSlots.length === 0) return null;
        return (
          <div key={group} className="space-y-2">
            <div>
              <h4 className="text-sm font-semibold text-foreground">
                {title}
              </h4>
              {hint && (
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {hint}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {groupSlots.map(renderSlot)}
            </div>
          </div>
        );
      })}

      {/* US-947: live camera capture for the active slot. The captured JPEG is
          routed through processFile — the identical validate + compress + EXIF
          path a manual upload takes (no bypass). */}
      <CameraCaptureDialog
        open={cameraSlotKey !== null}
        photoType={
          UPLOAD_SLOTS.find((s) => s.slotKey === cameraSlotKey)?.imageType
        }
        slotLabel={
          UPLOAD_SLOTS.find((s) => s.slotKey === cameraSlotKey)?.label ?? "photo"
        }
        onOpenChange={(open) => {
          if (!open) setCameraSlotKey(null);
        }}
        onCapture={(file) => {
          const key = cameraSlotKey;
          setCameraSlotKey(null);
          // US-2802: the ONLY site that may claim in-app capture. Everything
          // else defaults to `library`, so this line is the whole difference
          // between a photo that can earn the live badge and one that cannot.
          if (key) processFile(key, file, IN_APP_CAPTURE_SOURCE);
        }}
        onFallback={() => {
          const key = cameraSlotKey;
          setCameraSlotKey(null);
          if (key) fileInputRefs.current[key]?.click();
        }}
      />
    </div>
  );
}

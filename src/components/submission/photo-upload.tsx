import { useCallback, useRef, useState } from "react";
import {
  Camera,
  ImagePlus,
  Shirt,
  Tag,
  Search,
  AlertTriangle,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { validateImage, compressImage } from "@/lib/image-utils";
import type { ImageType } from "@/types/database";

export interface PhotoUploadItem {
  file: File;
  imageType: ImageType;
  preview: string;
}

interface UploadSlot {
  imageType: ImageType;
  label: string;
  required: boolean;
  icon: React.ElementType;
  description: string;
  slotKey: string;
}

const UPLOAD_SLOTS: UploadSlot[] = [
  {
    imageType: "front",
    label: "Front",
    required: true,
    icon: Shirt,
    description: "Full front view of garment",
    slotKey: "front",
  },
  {
    imageType: "back",
    label: "Back",
    required: true,
    icon: Shirt,
    description: "Full back view of garment",
    slotKey: "back",
  },
  {
    imageType: "label",
    label: "Label",
    required: true,
    icon: Tag,
    description: "Brand and care label",
    slotKey: "label",
  },
  {
    imageType: "detail",
    label: "Detail",
    required: true,
    icon: Search,
    description: "Close-up of key feature",
    slotKey: "detail-1",
  },
  {
    imageType: "detail",
    label: "Detail 2",
    required: false,
    icon: Search,
    description: "Additional detail (optional)",
    slotKey: "detail-2",
  },
  {
    imageType: "defect",
    label: "Defect 1",
    required: false,
    icon: AlertTriangle,
    description: "Damage or flaw (optional)",
    slotKey: "defect-1",
  },
  {
    imageType: "defect",
    label: "Defect 2",
    required: false,
    icon: AlertTriangle,
    description: "Additional defect (optional)",
    slotKey: "defect-2",
  },
  {
    imageType: "defect",
    label: "Defect 3",
    required: false,
    icon: AlertTriangle,
    description: "Additional defect (optional)",
    slotKey: "defect-3",
  },
];

interface SlotState {
  file: File | null;
  preview: string | null;
  errors: string[];
  isProcessing: boolean;
}

const DEFAULT_SLOT_STATE: SlotState = {
  file: null,
  preview: null,
  errors: [],
  isProcessing: false,
};

function getSlot(slots: Map<string, SlotState>, key: string): SlotState {
  return slots.get(key) ?? DEFAULT_SLOT_STATE;
}

interface PhotoUploadProps {
  onChange: (items: PhotoUploadItem[]) => void;
}

export function PhotoUpload({ onChange }: PhotoUploadProps) {
  const [slots, setSlots] = useState<Map<string, SlotState>>(() => {
    const initial = new Map<string, SlotState>();
    for (const slot of UPLOAD_SLOTS) {
      initial.set(slot.slotKey, { ...DEFAULT_SLOT_STATE });
    }
    return initial;
  });

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

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
          });
        }
      }
      onChange(items);
    },
    [onChange]
  );

  const processFile = useCallback(
    async (slotKey: string, file: File) => {
      setSlots((prev) => {
        const next = new Map(prev);
        const current = getSlot(prev, slotKey);
        next.set(slotKey, { ...current, isProcessing: true, errors: [] });
        return next;
      });

      const validation = await validateImage(file);
      if (!validation.valid) {
        const errors = validation.errors.map((e) => e.message);
        setSlots((prev) => {
          const next = new Map(prev);
          const current = getSlot(prev, slotKey);
          next.set(slotKey, { ...current, isProcessing: false, errors });
          return next;
        });
        return;
      }

      try {
        const compressed = await compressImage(file);
        const compressedFile = new File([compressed], file.name, {
          type: compressed.type,
        });
        const preview = URL.createObjectURL(compressed);

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
            isProcessing: false,
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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Camera className="h-4 w-4" />
        <span>Upload garment photos. Required slots are marked with *</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {UPLOAD_SLOTS.map((slot) => {
          const state = getSlot(slots, slot.slotKey);
          const Icon = slot.icon;

          return (
            <div key={slot.slotKey} className="space-y-1">
              <div
                className={cn(
                  "group relative flex aspect-square cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors",
                  state.preview
                    ? "border-primary bg-primary/5"
                    : "border-muted-foreground/25 hover:border-primary/50 hover:bg-accent/50",
                  state.isProcessing && "pointer-events-none opacity-60",
                  state.errors.length > 0 && "border-destructive/50"
                )}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => handleDrop(slot.slotKey, e)}
                onClick={() => fileInputRefs.current[slot.slotKey]?.click()}
              >
                <input
                  ref={(el) => {
                    fileInputRefs.current[slot.slotKey] = el;
                  }}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) =>
                    handleFileSelect(slot.slotKey, e.target.files?.[0])
                  }
                />

                {state.isProcessing ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    <span className="text-xs text-muted-foreground">
                      Processing...
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
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemove(slot.slotKey);
                      }}
                      className="absolute right-1 top-1 rounded-full bg-destructive p-1 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-1.5 p-2 text-center">
                    <div className="rounded-full bg-muted p-2">
                      <Icon className="h-5 w-5 text-muted-foreground" />
                    </div>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { compressImage } from "@/lib/image-utils";

// US-2525: pick images to send with a support message. The server is the one
// that validates (magic bytes, not the client's claim) and strips EXIF, so this
// is purely the picker — it shrinks what it sends so a 12MP phone photo does
// not become a 4MB base64 body.

export const MAX_ATTACHMENTS = 3;

export interface PickedAttachment {
  id: string;
  name: string;
  /** data:image/…;base64,… — what the edge accepts. */
  dataUrl: string;
  /** Object URL for the local preview; revoked when the item is removed. */
  previewUrl: string;
}

async function toDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export function AttachmentPicker({
  attachments,
  onChange,
  disabled,
}: {
  attachments: PickedAttachment[];
  onChange: (next: PickedAttachment[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      toast.error(`Up to ${MAX_ATTACHMENTS} images per message.`);
      return;
    }
    setBusy(true);
    try {
      const picked: PickedAttachment[] = [];
      for (const file of Array.from(files).slice(0, room)) {
        if (!file.type.startsWith("image/")) {
          toast.error(`${file.name} is not an image.`);
          continue;
        }
        // Same compressor the grading uploads use: a support screenshot does
        // not need to travel at full sensor resolution.
        const { blob } = await compressImage(file);
        picked.push({
          id: `${file.name}-${Date.now()}-${picked.length}`,
          name: file.name,
          dataUrl: await toDataUrl(blob),
          previewUrl: URL.createObjectURL(blob),
        });
      }
      if (picked.length > 0) onChange([...attachments, ...picked]);
    } catch (err) {
      toastError(err, "Could not attach that.");
    } finally {
      setBusy(false);
    }
  }

  function remove(id: string) {
    const target = attachments.find((a) => a.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    onChange(attachments.filter((a) => a.id !== id));
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy || attachments.length >= MAX_ATTACHMENTS}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <ImagePlus className="mr-1 h-4 w-4" />
          )}
          Attach a screenshot
        </Button>
        <span className="text-xs text-muted-foreground">
          Up to {MAX_ATTACHMENTS} images. Location data is stripped before they
          are stored.
        </span>
      </div>
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <li key={a.id} className="relative">
              <img
                src={a.previewUrl}
                alt={a.name}
                className="h-16 w-16 rounded border object-cover"
              />
              <button
                type="button"
                onClick={() => remove(a.id)}
                aria-label={`Remove ${a.name}`}
                className="absolute -right-1.5 -top-1.5 rounded-full border bg-background p-0.5 text-muted-foreground shadow-sm hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

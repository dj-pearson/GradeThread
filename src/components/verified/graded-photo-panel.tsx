import { useState } from "react";
import { Check, Copy, Download, ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import { SITE_URL } from "@/lib/seo/public-routes";

// US-765: the seller's "graded photo" panel — preview, pick a marketplace
// format, then download or copy the PSA-style certified image (rendered by the
// /slab/cert/:id Pages Function, US-763/US-764) to drop straight into a listing
// or socials. The slab is a public asset, so this is safe to show on the public
// certificate page as a share tool as well as on the owner's submission detail.

type SlabFormat = "square" | "portrait" | "story" | "label";

const FORMATS: { id: SlabFormat; label: string; aspect: string }[] = [
  { id: "square", label: "Square", aspect: "aspect-square" },
  { id: "portrait", label: "Portrait", aspect: "aspect-[4/5]" },
  { id: "story", label: "Story", aspect: "aspect-[9/16]" },
  { id: "label", label: "Label only", aspect: "aspect-square" },
];

// Same-origin in production/preview (so the download fetch isn't cross-origin);
// SITE_URL is the fallback for any non-browser render.
function slabUrl(certificateId: string, format: SlabFormat): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : SITE_URL;
  return `${origin}/slab/cert/${encodeURIComponent(certificateId)}?format=${format}`;
}

export function GradedPhotoPanel({
  certificateId,
  className,
}: {
  certificateId: string;
  className?: string;
}) {
  const [format, setFormat] = useState<SlabFormat>("square");
  const [busy, setBusy] = useState<null | "download" | "copy">(null);
  const [copied, setCopied] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);

  const url = slabUrl(certificateId, format);
  const activeAspect =
    FORMATS.find((f) => f.id === format)?.aspect ?? "aspect-square";

  async function fetchBlob(): Promise<Blob> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`slab ${res.status}`);
    return res.blob();
  }

  async function download() {
    setBusy("download");
    try {
      const blob = await fetchBlob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `gradethread-grade-${certificateId.slice(0, 8)}-${format}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      track("graded_photo_download", { certificate_id: certificateId, format });
    } catch {
      toast.error("Couldn't generate the image — please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function copyImage() {
    setBusy("copy");
    try {
      // ClipboardItem image write isn't universal (Firefox/Safari vary) —
      // fall back to a download so the seller always gets the asset.
      if (
        typeof ClipboardItem === "undefined" ||
        !navigator.clipboard?.write
      ) {
        await download();
        return;
      }
      const blob = await fetchBlob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Graded photo copied — paste it into your listing.");
      track("graded_photo_copy", { certificate_id: certificateId, format });
    } catch {
      // Clipboard blocked → degrade to download rather than failing silently.
      await download();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap gap-2">
        {FORMATS.map((f) => (
          <Button
            key={f.id}
            type="button"
            size="sm"
            variant={format === f.id ? "default" : "outline"}
            onClick={() => {
              setFormat(f.id);
              setPreviewFailed(false);
            }}
            aria-pressed={format === f.id}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <div className="flex justify-center">
        <div
          className={cn(
            "relative w-full max-w-xs overflow-hidden rounded-lg border bg-muted",
            activeAspect,
          )}
        >
          {previewFailed ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
              <ImageIcon className="h-6 w-6" />
              <span>
                Preview generates on the live site. Download still works.
              </span>
            </div>
          ) : (
            <img
              key={url}
              src={url}
              alt="Graded photo preview"
              className="h-full w-full object-contain"
              loading="lazy"
              onError={() => setPreviewFailed(true)}
            />
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={download} disabled={busy !== null} className="flex-1">
          <Download className="mr-2 h-4 w-4" />
          {busy === "download" ? "Preparing…" : "Download graded photo"}
        </Button>
        <Button
          onClick={copyImage}
          disabled={busy !== null}
          variant="outline"
          className="flex-1"
        >
          {copied ? (
            <Check className="mr-2 h-4 w-4 text-green-600 dark:text-green-400" />
          ) : (
            <Copy className="mr-2 h-4 w-4" />
          )}
          {busy === "copy" ? "Copying…" : "Copy image"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Add your official grade to any listing — buyers scan the code to verify.
      </p>
    </div>
  );
}

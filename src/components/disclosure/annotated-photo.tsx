import { useEffect, useRef, useState, useCallback } from "react";
import { Download, Loader2, ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSaveAnnotatedPhoto, type DisclosurePhoto } from "@/hooks/use-disclosure";

// Renders an AI-annotated defect photo: the garment image with a numbered
// callout box over each localized defect (and a numbered legend underneath for
// defects the grader couldn't localize). Exports the composited image so it can
// be downloaded or attached to the listing's photo set.

// Severity tones follow the refreshed media kit (design.md §3B): Vibrant
// Crimson for major defects, Amber Gold for moderate.
const SEVERITY_COLOR: Record<string, string> = {
  major: "#F03D5F",
  moderate: "#F59E0B",
  minor: "#EAB308",
};

function severityColor(s: string): string {
  return SEVERITY_COLOR[s] ?? "#F03D5F";
}

const MAX_CANVAS_W = 900;
const LEGEND_LINE_H = 26;
const LEGEND_PAD = 14;

export function AnnotatedPhoto({
  photo,
  itemId,
}: {
  photo: DisclosurePhoto;
  itemId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [tainted, setTainted] = useState(false);
  const save = useSaveAnnotatedPhoto(itemId);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    setReady(false);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const scale = Math.min(1, MAX_CANVAS_W / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const legendH = LEGEND_PAD * 2 + photo.annotations.length * LEGEND_LINE_H + 24;
      canvas.width = w;
      canvas.height = h + legendH;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Photo.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, w, h);

      // Callout boxes for localized defects.
      ctx.lineWidth = Math.max(2, Math.round(w / 250));
      ctx.font = `${Math.max(14, Math.round(w / 45))}px system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      for (const a of photo.annotations) {
        const color = severityColor(a.severity);
        if (a.bbox) {
          const [bx, by, bw, bh] = a.bbox;
          const rx = bx * w;
          const ry = by * h;
          const rw = bw * w;
          const rh = bh * h;
          ctx.strokeStyle = color;
          ctx.strokeRect(rx, ry, rw, rh);
          // Numbered marker at the box's top-left.
          const r = Math.max(11, Math.round(w / 36));
          ctx.beginPath();
          ctx.arc(rx, ry, r, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.fillText(String(a.n), rx, ry + 1);
        }
      }

      // Legend strip.
      const legendTop = h + LEGEND_PAD;
      ctx.textAlign = "left";
      ctx.font = `600 ${Math.max(13, Math.round(w / 55))}px system-ui, sans-serif`;
      ctx.fillStyle = "#0C1E36";
      ctx.fillText("Documented condition — AI-verified by GradeThread", LEGEND_PAD, legendTop);
      ctx.font = `${Math.max(13, Math.round(w / 60))}px system-ui, sans-serif`;
      photo.annotations.forEach((a, idx) => {
        const y = legendTop + 24 + idx * LEGEND_LINE_H + LEGEND_LINE_H / 2;
        // number chip
        const chip = severityColor(a.severity);
        const cx = LEGEND_PAD + 9;
        ctx.beginPath();
        ctx.arc(cx, y, 9, 0, Math.PI * 2);
        ctx.fillStyle = chip;
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.font = `bold ${Math.max(11, Math.round(w / 75))}px system-ui, sans-serif`;
        ctx.fillText(String(a.n), cx, y + 0.5);
        // text
        ctx.textAlign = "left";
        ctx.fillStyle = "#0E0E1A";
        ctx.font = `${Math.max(13, Math.round(w / 60))}px system-ui, sans-serif`;
        const loc = a.location ? ` (${a.location})` : "";
        ctx.fillText(`${a.issue}${loc} — ${a.severity}`, LEGEND_PAD + 26, y);
      });

      setReady(true);
    };
    img.onerror = () => {
      if (!cancelled) {
        setTainted(true);
        setReady(false);
      }
    };
    img.src = photo.url;
    return () => {
      cancelled = true;
    };
  }, [photo]);

  const exportDataUrl = useCallback((): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    try {
      return canvas.toDataURL("image/png");
    } catch {
      // Cross-origin taint — display works, export doesn't.
      setTainted(true);
      return null;
    }
  }, []);

  const onDownload = useCallback(() => {
    const url = exportDataUrl();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `gradethread-disclosure-${photo.image_type}.png`;
    a.click();
  }, [exportDataUrl, photo.image_type]);

  const onSave = useCallback(() => {
    const url = exportDataUrl();
    if (!url) return;
    save.mutate({ imageType: photo.image_type, dataUrl: url });
  }, [exportDataUrl, photo.image_type, save]);

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <Badge variant="outline" className="capitalize">
          {photo.image_type.replace(/_/g, " ")}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {photo.annotations.length} flaw{photo.annotations.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="overflow-hidden rounded-md border bg-muted">
        <canvas ref={canvasRef} className="h-auto w-full" />
      </div>
      {tainted && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          This image can't be exported from the browser. The annotations still
          display above.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDownload}
          disabled={!ready || tainted}
        >
          <Download className="mr-1.5 h-4 w-4" />
          Download
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onSave}
          disabled={!ready || tainted || save.isPending}
        >
          {save.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <ImagePlus className="mr-1.5 h-4 w-4" />
          )}
          Attach to item
        </Button>
      </div>
    </div>
  );
}

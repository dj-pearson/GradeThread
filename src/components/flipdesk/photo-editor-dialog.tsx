import { useEffect, useRef, useState } from "react";
import { RotateCcw, RotateCw, Crop, Loader2, Check, Spline } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Rect = { x: number; y: number; w: number; h: number }; // all 0-1 normalized
type Corner = "tl" | "tr" | "bl" | "br";
type DragState = {
  mode: "move" | Corner;
  startX: number;
  startY: number;
  startCrop: Rect;
} | null;

const MIN_SIZE = 0.05;

interface Props {
  open: boolean;
  /** Supabase public URL of the photo to edit. */
  src: string;
  onClose: () => void;
  /** Receives the edited image as a JPEG Blob. Must close the dialog on success. */
  onSave: (blob: Blob) => Promise<void>;
}

/**
 * In-browser photo editor: rotate (90° steps) + interactive crop.
 * Uses a hidden <img> as the source, draws to a <canvas> for transforms,
 * and fetches the image as a blob-URL to avoid canvas CORS taint.
 */
// US-534: straighten/deskew range (degrees). Small fine angle on top of the
// 90° rotation steps; the frame is auto-scaled to cover so corners never go
// transparent.
const STRAIGHTEN_MAX = 15;

export function PhotoEditorDialog({ open, src, onClose, onSave }: Props) {
  const [rotation, setRotation] = useState(0); // degrees: 0 | 90 | 180 | 270
  const [fine, setFine] = useState(0); // straighten angle, -15..15
  const [cropMode, setCropMode] = useState(false);
  const [crop, setCrop] = useState<Rect>({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
  const [saving, setSaving] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hiddenImgRef = useRef<HTMLImageElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState>(null);

  // Fetch as blob to avoid tainted-canvas errors from cross-origin images.
  useEffect(() => {
    if (!open || !src) return;
    let objectUrl: string | null = null;
    setRotation(0);
    setFine(0);
    setCropMode(false);
    setCrop({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
    setSaving(false);
    setBlobUrl(null);

    fetch(src)
      .then((r) => r.blob())
      .then((b) => {
        objectUrl = URL.createObjectURL(b);
        setBlobUrl(objectUrl);
      })
      .catch(() => setBlobUrl(src)); // fallback: try direct URL (may work if CORS allows)

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, src]);

  function drawFrame(img: HTMLImageElement, rot: number, fineAngle: number) {
    const canvas = canvasRef.current;
    if (!canvas || img.naturalWidth === 0) return;
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    const swapped = rot % 180 !== 0;
    const cw = swapped ? sh : sw;
    const ch = swapped ? sw : sh;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, cw, ch);
    // US-534: the 90° rotation alone fills cw×ch exactly. The fine straighten
    // angle rotates that filled frame further, so scale up by the cover factor
    // (smallest scale that keeps the rotated cw×ch content covering the cw×ch
    // window) to avoid transparent corners.
    const phi = (fineAngle * Math.PI) / 180;
    const c = Math.abs(Math.cos(phi));
    const s = Math.abs(Math.sin(phi));
    const cover = Math.max((cw * c + ch * s) / cw, (cw * s + ch * c) / ch);
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(((rot + fineAngle) * Math.PI) / 180);
    ctx.scale(cover, cover);
    ctx.drawImage(img, -sw / 2, -sh / 2);
    ctx.restore();
  }

  function redraw(rot: number, fineAngle: number) {
    const img = hiddenImgRef.current;
    if (img?.complete && img.naturalWidth > 0) drawFrame(img, rot, fineAngle);
  }

  function rotate(delta: -90 | 90) {
    const r = (rotation + delta + 360) % 360;
    setRotation(r);
    redraw(r, fine);
  }

  function straighten(angle: number) {
    const a = Math.max(-STRAIGHTEN_MAX, Math.min(STRAIGHTEN_MAX, angle));
    setFine(a);
    redraw(rotation, a);
  }

  /** Convert a pointer event to a 0-1 position relative to the canvas wrapper. */
  function relPos(e: React.PointerEvent) {
    const wrap = canvasWrapRef.current;
    if (!wrap) return { rx: 0, ry: 0 };
    const r = wrap.getBoundingClientRect();
    return {
      rx: (e.clientX - r.left) / r.width,
      ry: (e.clientY - r.top) / r.height,
    };
  }

  function clamp(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, v));
  }

  function onPointerDown(e: React.PointerEvent, mode: "move" | Corner) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { rx, ry } = relPos(e);
    drag.current = { mode, startX: rx, startY: ry, startCrop: { ...crop } };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const { rx, ry } = relPos(e);
    const dx = rx - d.startX;
    const dy = ry - d.startY;
    const sc = d.startCrop;

    setCrop(() => {
      let { x, y, w, h } = sc;
      switch (d.mode) {
        case "move":
          x = clamp(x + dx, 0, 1 - w);
          y = clamp(y + dy, 0, 1 - h);
          break;
        case "tl": {
          const nx = clamp(x + dx, 0, x + w - MIN_SIZE);
          const ny = clamp(y + dy, 0, y + h - MIN_SIZE);
          w = x + w - nx; h = y + h - ny; x = nx; y = ny;
          break;
        }
        case "tr": {
          const ny = clamp(y + dy, 0, y + h - MIN_SIZE);
          w = clamp(w + dx, MIN_SIZE, 1 - x); h = y + h - ny; y = ny;
          break;
        }
        case "bl": {
          const nx = clamp(x + dx, 0, x + w - MIN_SIZE);
          w = x + w - nx; h = clamp(h + dy, MIN_SIZE, 1 - y); x = nx;
          break;
        }
        case "br":
          w = clamp(w + dx, MIN_SIZE, 1 - x);
          h = clamp(h + dy, MIN_SIZE, 1 - y);
          break;
      }
      return { x, y, w, h };
    });
  }

  function onPointerUp() {
    drag.current = null;
  }

  async function handleSave() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    try {
      const out = document.createElement("canvas");
      const cw = canvas.width;
      const ch = canvas.height;
      if (cropMode && (crop.w < 0.99 || crop.h < 0.99)) {
        out.width = Math.max(1, Math.round(crop.w * cw));
        out.height = Math.max(1, Math.round(crop.h * ch));
        out
          .getContext("2d")!
          .drawImage(
            canvas,
            Math.round(crop.x * cw),
            Math.round(crop.y * ch),
            out.width,
            out.height,
            0,
            0,
            out.width,
            out.height,
          );
      } else {
        out.width = cw;
        out.height = ch;
        out.getContext("2d")!.drawImage(canvas, 0, 0);
      }
      const blob = await new Promise<Blob>((res, rej) =>
        out.toBlob(
          (b) => (b ? res(b) : rej(new Error("toBlob failed"))),
          "image/jpeg",
          0.92,
        ),
      );
      await onSave(blob);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="flex max-h-[95dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-3 overflow-hidden p-4">
        <DialogHeader className="shrink-0">
          <DialogTitle>Edit photo</DialogTitle>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b pb-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => rotate(-90)}
            disabled={saving}
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Rotate left
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => rotate(90)}
            disabled={saving}
          >
            <RotateCw className="mr-1.5 h-4 w-4" />
            Rotate right
          </Button>
          <Button
            variant={cropMode ? "default" : "outline"}
            size="sm"
            onClick={() => setCropMode((m) => !m)}
            disabled={saving}
          >
            <Crop className="mr-1.5 h-4 w-4" />
            {cropMode ? "Cropping…" : "Crop"}
          </Button>
          {cropMode && (
            <p className="text-xs text-muted-foreground">
              Drag corners to resize · drag inside to move
            </p>
          )}

          {/* US-534: straighten / deskew */}
          <div className="ml-auto flex items-center gap-2">
            <label
              htmlFor="straighten"
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
            >
              <Spline className="h-4 w-4" />
              Straighten
            </label>
            <input
              id="straighten"
              type="range"
              min={-STRAIGHTEN_MAX}
              max={STRAIGHTEN_MAX}
              step={0.5}
              value={fine}
              onChange={(e) => straighten(Number(e.target.value))}
              disabled={saving}
              className="h-1 w-28 cursor-pointer accent-primary"
              aria-label="Straighten angle in degrees"
            />
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
              {fine > 0 ? `+${fine}` : fine}°
            </span>
            {fine !== 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => straighten(0)}
                disabled={saving}
              >
                Reset
              </Button>
            )}
          </div>
        </div>

        {/* Canvas stage */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-black">
          {/* Wrapper sized to the canvas; crop overlay hangs off this. */}
          <div
            ref={canvasWrapRef}
            className="relative"
            style={{
              display: "inline-flex",
              touchAction: cropMode ? "none" : "auto",
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            {/* Hidden source image — loaded for drawFrame */}
            <img
              ref={hiddenImgRef}
              src={blobUrl ?? undefined}
              alt=""
              className="hidden"
              onLoad={() => {
                const img = hiddenImgRef.current;
                if (img) drawFrame(img, rotation, fine);
              }}
            />
            {/* Rotated canvas — CSS-scaled to fit the dialog */}
            <canvas
              ref={canvasRef}
              className="block max-h-[52vh] max-w-full"
            />

            {/* Crop overlay — absolutely covers the canvas exactly */}
            {cropMode && (
              <div className="pointer-events-none absolute inset-0">
                <div className="pointer-events-auto absolute inset-0">
                  {/* Dark regions outside the selection */}
                  <div
                    className="absolute inset-x-0 top-0 bg-black/55"
                    style={{ height: `${crop.y * 100}%` }}
                  />
                  <div
                    className="absolute inset-x-0 bottom-0 bg-black/55"
                    style={{ top: `${(crop.y + crop.h) * 100}%` }}
                  />
                  <div
                    className="absolute bg-black/55"
                    style={{
                      top: `${crop.y * 100}%`,
                      bottom: `${(1 - crop.y - crop.h) * 100}%`,
                      left: 0,
                      width: `${crop.x * 100}%`,
                    }}
                  />
                  <div
                    className="absolute bg-black/55"
                    style={{
                      top: `${crop.y * 100}%`,
                      bottom: `${(1 - crop.y - crop.h) * 100}%`,
                      left: `${(crop.x + crop.w) * 100}%`,
                      right: 0,
                    }}
                  />
                  {/* Selection box — drag interior to move */}
                  <div
                    className="absolute cursor-move border border-white/80"
                    style={{
                      left: `${crop.x * 100}%`,
                      top: `${crop.y * 100}%`,
                      width: `${crop.w * 100}%`,
                      height: `${crop.h * 100}%`,
                    }}
                    onPointerDown={(e) => onPointerDown(e, "move")}
                  >
                    {/* Rule-of-thirds grid */}
                    <div className="pointer-events-none absolute inset-0">
                      <div className="absolute bottom-0 left-1/3 top-0 border-l border-white/25" />
                      <div className="absolute bottom-0 left-2/3 top-0 border-l border-white/25" />
                      <div className="absolute left-0 right-0 top-1/3 border-t border-white/25" />
                      <div className="absolute left-0 right-0 top-2/3 border-t border-white/25" />
                    </div>
                    {/* Corner drag handles */}
                    {(["tl", "tr", "bl", "br"] as const).map((corner) => (
                      <div
                        key={corner}
                        onPointerDown={(e) => onPointerDown(e, corner)}
                        className={cn(
                          // US-451: intentional fixed white — a crop handle that
                          // must stay visible over any photo, not a themeable
                          // surface.
                          "absolute h-5 w-5 rounded-sm bg-white shadow-md",
                          corner === "tl" && "-left-2.5 -top-2.5 cursor-nw-resize",
                          corner === "tr" && "-right-2.5 -top-2.5 cursor-ne-resize",
                          corner === "bl" && "-bottom-2.5 -left-2.5 cursor-sw-resize",
                          corner === "br" && "-bottom-2.5 -right-2.5 cursor-se-resize",
                        )}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 justify-between gap-2 border-t pt-3">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            {saving ? "Saving…" : "Save edit"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RotateCcw,
  RotateCw,
  Crop,
  Loader2,
  Check,
  Spline,
  Sparkles,
  Undo2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Eraser,
  Lock,
  History,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  NEUTRAL_ADJUSTMENTS,
  analyzeCanvas,
  applyPixelPassesToCanvas,
  autoAdjust,
  filterString,
  isNeutral,
  type Adjustments,
} from "@/lib/image-adjustments";
import {
  buildEditRecipe,
  type PhotoEditRecipe,
} from "@/lib/photo-edit-recipe";
import { cn } from "@/lib/utils";

type Rect = { x: number; y: number; w: number; h: number }; // all 0-1 normalized
type Corner = "tl" | "tr" | "bl" | "br";
type DragState = {
  mode: "move" | Corner | "pan";
  startX: number;
  startY: number;
  startCrop: Rect;
  startPan: { x: number; y: number };
} | null;

const MIN_SIZE = 0.05;
const FULL_CROP: Rect = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };

// The interactive preview renders from a downscaled copy. Warmth and sharpness
// are per-pixel passes, and running them over a 12MP original on every slider
// tick would drop frames; at this edge length they complete well inside a frame.
// The full-resolution original is re-rendered once, on save.
const PREVIEW_EDGE = 1100;

// US-534: straighten/deskew range (degrees). Small fine angle on top of the
// 90° rotation steps; the frame is auto-scaled to cover so corners never go
// transparent.
const STRAIGHTEN_MAX = 15;

const ASPECT_PRESETS: { label: string; ratio: number | null; hint: string }[] = [
  { label: "Free", ratio: null, hint: "Crop to any shape" },
  // eBay's gallery thumbnail is square-cropped from whatever you upload, so
  // composing square here is the only way to control what buyers see in search.
  { label: "1:1", ratio: 1, hint: "Square — matches eBay's gallery thumbnail" },
  { label: "4:3", ratio: 4 / 3, hint: "Standard landscape" },
  { label: "3:4", ratio: 3 / 4, hint: "Standard portrait" },
];

interface Props {
  open: boolean;
  /** Supabase public URL of the photo to edit. */
  src: string;
  /**
   * US-2208: public URL of the preserved PRE-EDIT original, when this photo has
   * been edited before. Supplying it makes a re-edit lossless — the editor
   * renders from the pristine file with `initialRecipe` replayed into the
   * controls, instead of stacking tone and another JPEG generation onto an
   * already-edited image every time the seller nudges a slider.
   */
  originalSrc?: string | null;
  /** The recipe that produced the current image, replayed into the controls. */
  initialRecipe?: PhotoEditRecipe | null;
  /** Restore the preserved original. Shown only when there is an edit to undo. */
  onRevert?: () => Promise<void>;
  onClose: () => void;
  /**
   * Receives the edited image as a JPEG Blob. Must close the dialog on success.
   *
   * `dims` is the output canvas size. It travels with the blob because the
   * caller needs it to keep `item_photos.width/height` honest and to carry a
   * MeasureCard calibration across a rotation (US-2888), and decoding the blob
   * a second time to read two numbers this already has is waste.
   */
  onSave: (
    blob: Blob,
    recipe: PhotoEditRecipe,
    dims: [number, number],
  ) => Promise<void>;
  /**
   * When false, the tonal tools (brightness/contrast/saturation/warmth/sharpness,
   * Auto, and background removal) are withheld — geometry-only editing.
   *
   * A photo submitted as grading evidence must keep the tone it was graded from:
   * the edge pipeline abstains from grading images it judges too dark or too
   * blurry (lib/image-quality.ts), and letting a seller brighten one and
   * resubmit would route around that gate. Brightening also hides the pilling
   * and staining a condition grade exists to disclose. Rotate, straighten and
   * crop stay available — they change framing, not the evidence.
   */
  allowToneEdits?: boolean;
}

/**
 * In-browser photo editor: rotate (90° steps), straighten, interactive crop,
 * tonal enhancement, background removal, and zoom review.
 *
 * Uses a hidden img element as the source, draws to a canvas for transforms, and
 * fetches the image as a blob-URL to avoid canvas CORS taint.
 */
export function PhotoEditorDialog({
  open,
  src,
  originalSrc,
  initialRecipe,
  onRevert,
  onClose,
  onSave,
  allowToneEdits = true,
}: Props) {
  const [rotation, setRotation] = useState(0); // degrees: 0 | 90 | 180 | 270
  const [fine, setFine] = useState(0); // straighten angle, -15..15
  const [cropMode, setCropMode] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  const [crop, setCrop] = useState<Rect>(FULL_CROP);
  const [adj, setAdj] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgProgress, setBgProgress] = useState(0);
  const [bgRemoved, setBgRemoved] = useState(false);
  // `notice` is any surfaced message; `fatal` means the source never loaded, so
  // there is nothing to save. A failed background removal is a notice, not a
  // fatal — the photo is untouched and still perfectly saveable.
  const [notice, setNotice] = useState<string | null>(null);
  const [fatal, setFatal] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState>(null);
  // Full-resolution source, used only at save time.
  const fullBitmapRef = useRef<ImageBitmap | null>(null);
  // Downscaled source driving the interactive preview.
  const previewBitmapRef = useRef<ImageBitmap | null>(null);
  // The pristine fetched bytes, so "Reset" can undo a background removal.
  const originalBlobRef = useRef<Blob | null>(null);
  const rafRef = useRef<number | null>(null);
  const recipeRef = useRef(initialRecipe);
  recipeRef.current = initialRecipe;
  const [reverting, setReverting] = useState(false);

  const toneLocked = !allowToneEdits;

  // ── Source loading ────────────────────────────────────────────────
  const loadBitmaps = useCallback(async (blob: Blob) => {
    // Cancel any queued repaint first: it closes over the CURRENT bitmaps, and
    // the swap below closes them. A frame landing after the swap would draw from
    // a detached ImageBitmap and throw.
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const full = await createImageBitmap(blob);
    const scale = Math.min(
      1,
      PREVIEW_EDGE / Math.max(full.width, full.height),
    );
    const preview =
      scale < 1
        ? await createImageBitmap(blob, {
            resizeWidth: Math.max(1, Math.round(full.width * scale)),
            resizeHeight: Math.max(1, Math.round(full.height * scale)),
            resizeQuality: "high",
          })
        : await createImageBitmap(blob);
    fullBitmapRef.current?.close();
    previewBitmapRef.current?.close();
    fullBitmapRef.current = full;
    previewBitmapRef.current = preview;
  }, []);

  // Fetch as blob to avoid tainted-canvas errors from cross-origin images.
  useEffect(() => {
    if (!open || !src) return;
    let cancelled = false;

    // US-2208: when a preserved original exists, edit THAT and replay the saved
    // recipe. Editing the already-edited file instead would re-encode a lossy
    // JPEG and compound tone on tone with every visit.
    const editingOriginal = !!originalSrc;
    const loadFrom = originalSrc || src;
    // Read through the ref: `initialRecipe` is parsed from a jsonb column, so
    // it is a fresh object on every parent render. As a dependency it would
    // restart this fetch continuously; as a ref it stays a one-shot seed and no
    // call site has to remember to memoize it.
    const seed = editingOriginal ? recipeRef.current : null;

    setRotation(seed?.rotation ?? 0);
    setFine(seed?.fine ?? 0);
    setCropMode(seed?.crop != null);
    setAspect(seed?.aspect ?? null);
    setCrop(seed?.crop ?? FULL_CROP);
    setAdj(seed?.adjustments ?? NEUTRAL_ADJUSTMENTS);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSaving(false);
    // The cut-out is recorded but not replayed — re-running segmentation is
    // seconds of work nobody asked for. Start from "not removed" and tell the
    // seller it was, so re-applying stays a deliberate single click.
    setBgRemoved(false);
    setBgBusy(false);
    setNotice(
      seed?.bgRemoved
        ? "This photo had its background removed. Editing from the original — click Cut out to reapply it."
        : null,
    );
    setFatal(false);
    setLoading(true);

    void (async () => {
      try {
        const res = await fetch(loadFrom);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        originalBlobRef.current = blob;
        await loadBitmaps(blob);
        if (cancelled) return;
        setLoading(false);
      } catch {
        if (!cancelled) {
          setNotice("Couldn't load this photo for editing.");
          setFatal(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, src, originalSrc, loadBitmaps]);

  // Release the decoded bitmaps when the dialog closes — each one pins its full
  // pixel buffer, and a 12MP photo is ~48MB held until GC gets around to it.
  useEffect(() => {
    if (open) return;
    fullBitmapRef.current?.close();
    previewBitmapRef.current?.close();
    fullBitmapRef.current = null;
    previewBitmapRef.current = null;
    originalBlobRef.current = null;
  }, [open]);

  // ── Rendering ─────────────────────────────────────────────────────
  /** Draw `source` into `canvas` with the given geometry + tone applied. */
  function paint(
    canvas: HTMLCanvasElement,
    source: ImageBitmap,
    rot: number,
    fineAngle: number,
    tone: Adjustments,
    readback: boolean,
  ) {
    const sw = source.width;
    const sh = source.height;
    const swapped = rot % 180 !== 0;
    const cw = swapped ? sh : sw;
    const ch = swapped ? sw : sh;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", {
      willReadFrequently: readback,
    }) as CanvasRenderingContext2D;
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
    // brightness/contrast/saturation ride on the browser's own filter pipeline;
    // warmth and sharpness need the pixel pass below.
    ctx.filter = filterString(tone);
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(((rot + fineAngle) * Math.PI) / 180);
    ctx.scale(cover, cover);
    ctx.drawImage(source, -sw / 2, -sh / 2);
    ctx.restore();
    applyPixelPassesToCanvas(ctx, cw, ch, tone);
  }

  /** Repaint the on-screen preview, coalesced to one draw per frame. */
  const redraw = useCallback(
    (rot: number, fineAngle: number, tone: Adjustments) => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const canvas = canvasRef.current;
        const bmp = previewBitmapRef.current;
        if (!canvas || !bmp) return;
        paint(canvas, bmp, rot, fineAngle, tone, true);
      });
    },
    [],
  );

  // Repaint whenever geometry or tone changes (and once the source arrives).
  useEffect(() => {
    if (loading || fatal) return;
    redraw(rotation, fine, adj);
  }, [loading, fatal, rotation, fine, adj, redraw]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  function rotate(delta: -90 | 90) {
    setRotation((r) => (r + delta + 360) % 360);
  }

  function straighten(angle: number) {
    setFine(Math.max(-STRAIGHTEN_MAX, Math.min(STRAIGHTEN_MAX, angle)));
  }

  function setTone(patch: Partial<Adjustments>) {
    setAdj((a) => ({ ...a, ...patch }));
  }

  function resetAll() {
    setRotation(0);
    setFine(0);
    setAdj(NEUTRAL_ADJUSTMENTS);
    setCrop(FULL_CROP);
    setAspect(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    // Undo a background removal by reloading the pristine bytes.
    if (bgRemoved && originalBlobRef.current) {
      const blob = originalBlobRef.current;
      setBgRemoved(false);
      setLoading(true);
      void loadBitmaps(blob)
        .then(() => setLoading(false))
        .catch(() => {
          setNotice("Couldn't restore the original photo.");
          setFatal(true);
          setLoading(false);
        });
    }
  }

  /** One-click enhancement — reads the CURRENT preview and solves the sliders. */
  function applyAuto() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Analyse the un-adjusted image so Auto is idempotent rather than compounding
    // on top of whatever the sliders already say.
    const probe = document.createElement("canvas");
    const bmp = previewBitmapRef.current;
    if (!bmp) return;
    paint(probe, bmp, rotation, fine, NEUTRAL_ADJUSTMENTS, true);
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const next = autoAdjust(analyzeCanvas(ctx, probe.width, probe.height));
    // Keep any sharpening the seller dialled in; Auto doesn't have an opinion.
    setAdj({ ...next, sharpness: adj.sharpness });
  }

  async function removeBg() {
    const blob = originalBlobRef.current;
    if (!blob || bgBusy) return;
    setBgBusy(true);
    setBgProgress(0);
    try {
      const { removeImageBackground } = await import("@/lib/background-removal");
      // White composite (not transparent): the editor saves back over the
      // original JPEG, and a transparent PNG written to a .jpg path would be
      // both a format and an extension mismatch. A transparent cut-out is still
      // available from the photo grid, which files it as a NEW flatlay.
      const out = await removeImageBackground(blob, "white", setBgProgress);
      await loadBitmaps(out.full);
      setBgRemoved(true);
    } catch (err) {
      // US-3069: tell the two failures apart. "Failed" on a missing model
      // blames the photo, and the seller retries with a better one forever.
      setNotice(
        (err as Error)?.name === "NoLocalSegmenter"
          ? "On-device background removal isn't available in this build. Use Remove background from the photo grid, which runs on the server."
          : "Background removal failed. The photo is unchanged.",
      );
    } finally {
      setBgBusy(false);
    }
  }

  // ── Crop / pan interaction ────────────────────────────────────────
  /** Convert a pointer event to a 0-1 position relative to the canvas wrapper.
   *  getBoundingClientRect() reports the POST-transform box, so this stays
   *  correct while the stage is zoomed or panned. */
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

  /** Canvas pixel aspect, needed to express a target ratio in normalized units. */
  function canvasAspect(): number {
    const canvas = canvasRef.current;
    if (!canvas || canvas.height === 0) return 1;
    return canvas.width / canvas.height;
  }

  /** Force `r` to the locked aspect ratio, anchored at its top-left. */
  function enforceAspect(r: Rect, ratio: number | null): Rect {
    if (ratio == null) return r;
    // A ratio in IMAGE pixels becomes ratio/canvasAspect in normalized units.
    const normRatio = ratio / canvasAspect();
    let { w, h } = r;
    // Shrink the longer side so the box always stays inside the frame.
    if (w / h > normRatio) w = h * normRatio;
    else h = w / normRatio;
    const x = clamp(r.x, 0, 1 - w);
    const y = clamp(r.y, 0, 1 - h);
    return { x, y, w, h };
  }

  function pickAspect(ratio: number | null) {
    setAspect(ratio);
    setCropMode(true);
    if (ratio == null) return;
    // Recentre a maximal box at the new ratio.
    const normRatio = ratio / canvasAspect();
    let w = 0.9;
    let h = w / normRatio;
    if (h > 0.9) {
      h = 0.9;
      w = h * normRatio;
    }
    setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  }

  function onPointerDown(e: React.PointerEvent, mode: "move" | Corner | "pan") {
    if (mode === "pan" && zoom <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { rx, ry } = relPos(e);
    drag.current = {
      mode,
      startX: rx,
      startY: ry,
      startCrop: { ...crop },
      startPan: { ...pan },
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const { rx, ry } = relPos(e);
    const dx = rx - d.startX;
    const dy = ry - d.startY;

    if (d.mode === "pan") {
      // Pan in stage-relative units; the wrapper rect already accounts for zoom.
      setPan({ x: d.startPan.x + dx * 100, y: d.startPan.y + dy * 100 });
      return;
    }

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
      return enforceAspect({ x, y, w, h }, aspect);
    });
  }

  function onPointerUp() {
    drag.current = null;
  }

  function onWheel(e: React.WheelEvent) {
    if (cropMode) return; // crop dragging owns the stage
    e.preventDefault();
    setZoom((z) => {
      const next = clamp(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 8);
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }

  function nudgeZoom(factor: number) {
    setZoom((z) => {
      const next = clamp(z * factor, 1, 8);
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }

  function fitZoom() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  // ── Save ──────────────────────────────────────────────────────────
  /** Whether the crop is a real crop rather than the untouched default frame. */
  function croppedRect(): { x: number; y: number; w: number; h: number } | null {
    return cropMode && (crop.w < 0.99 || crop.h < 0.99) ? { ...crop } : null;
  }

  async function handleSave() {
    const full = fullBitmapRef.current;
    if (!full) return;
    setSaving(true);
    try {
      // Re-render at FULL resolution — the preview was a downscaled proxy, and
      // saving it would silently degrade every edited photo to ~1100px.
      const rendered = document.createElement("canvas");
      paint(rendered, full, rotation, fine, adj, false);

      const out = document.createElement("canvas");
      const cw = rendered.width;
      const ch = rendered.height;
      if (cropMode && (crop.w < 0.99 || crop.h < 0.99)) {
        out.width = Math.max(1, Math.round(crop.w * cw));
        out.height = Math.max(1, Math.round(crop.h * ch));
        out
          .getContext("2d")!
          .drawImage(
            rendered,
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
        out.getContext("2d")!.drawImage(rendered, 0, 0);
      }
      const blob = await new Promise<Blob>((res, rej) =>
        out.toBlob(
          (b) => (b ? res(b) : rej(new Error("toBlob failed"))),
          "image/jpeg",
          0.92,
        ),
      );
      // The recipe describes how this output was derived FROM THE ORIGINAL, so
      // reopening can replay it rather than re-editing an edited file.
      await onSave(
        blob,
        buildEditRecipe({
          rotation,
          fine,
          crop: croppedRect(),
          aspect,
          adjustments: adj,
          // Sticky across a re-edit: the seller sees the cut-out already applied
          // in the image they opened, so not carrying the flag would quietly
          // drop it from the record on the next save.
          bgRemoved: bgRemoved || recipeRef.current?.bgRemoved === true,
          editedAt: new Date().toISOString(),
        }),
        [out.width, out.height],
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleRevert() {
    if (!onRevert) return;
    setReverting(true);
    try {
      await onRevert();
    } catch {
      setNotice("Couldn't revert this photo. Nothing was changed.");
    } finally {
      setReverting(false);
    }
  }

  const busy = saving || bgBusy || reverting;
  const dirty =
    rotation !== 0 || fine !== 0 || !isNeutral(adj) || bgRemoved || cropMode;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="@container flex max-h-[95dvh] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-3 overflow-hidden p-4">
        <DialogHeader className="shrink-0">
          <DialogTitle>Edit photo</DialogTitle>
        </DialogHeader>

        {notice && (
          <div className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {notice}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden @3xl:flex-row">
          {/* ── Stage ──────────────────────────────────────────── */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            {/* Geometry toolbar */}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => rotate(-90)}
                disabled={busy || loading}
              >
                <RotateCcw className="mr-1.5 h-4 w-4" />
                Left
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => rotate(90)}
                disabled={busy || loading}
              >
                <RotateCw className="mr-1.5 h-4 w-4" />
                Right
              </Button>
              <Button
                variant={cropMode ? "default" : "outline"}
                size="sm"
                onClick={() => setCropMode((m) => !m)}
                disabled={busy || loading}
              >
                <Crop className="mr-1.5 h-4 w-4" />
                Crop
              </Button>

              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => nudgeZoom(1 / 1.4)}
                  disabled={busy || loading || zoom <= 1}
                  aria-label="Zoom out"
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">
                  {Math.round(zoom * 100)}%
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => nudgeZoom(1.4)}
                  disabled={busy || loading || zoom >= 8}
                  aria-label="Zoom in"
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={fitZoom}
                  disabled={busy || loading || (zoom === 1 && pan.x === 0 && pan.y === 0)}
                  aria-label="Fit to window"
                >
                  <Maximize className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Crop aspect presets */}
            {cropMode && (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {ASPECT_PRESETS.map((p) => (
                  <Button
                    key={p.label}
                    variant={aspect === p.ratio ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    title={p.hint}
                    onClick={() => pickAspect(p.ratio)}
                    disabled={busy}
                  >
                    {p.label}
                  </Button>
                ))}
                <p className="text-xs text-muted-foreground">
                  Drag corners to resize · drag inside to move
                </p>
              </div>
            )}

            {/* Canvas stage */}
            <div
              className="relative flex min-h-[40dvh] flex-1 items-center justify-center overflow-hidden rounded-md bg-black"
              onWheel={onWheel}
            >
              {loading && (
                <div className="flex items-center gap-2 text-sm text-white/70">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading photo…
                </div>
              )}
              {bgBusy && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm text-white">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Removing background… {Math.round(bgProgress * 100)}%
                  <span className="text-xs text-white/60">
                    First run downloads the model — later photos are instant.
                  </span>
                </div>
              )}
              {/* Wrapper sized to the canvas; crop overlay hangs off this. */}
              <div
                ref={canvasWrapRef}
                className={cn(
                  "relative",
                  !cropMode && zoom > 1 && "cursor-grab active:cursor-grabbing",
                )}
                style={{
                  display: loading ? "none" : "inline-flex",
                  touchAction: cropMode || zoom > 1 ? "none" : "auto",
                  transform: `scale(${zoom}) translate(${pan.x}%, ${pan.y}%)`,
                  transformOrigin: "center center",
                }}
                onPointerDown={(e) => !cropMode && onPointerDown(e, "pan")}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
              >
                {/* Rotated canvas — CSS-scaled to fit the dialog */}
                <canvas
                  ref={canvasRef}
                  className="block max-h-[52dvh] max-w-full"
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
                              // US-451: intentional fixed white — a crop handle
                              // that must stay visible over any photo, not a
                              // themeable surface.
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
            {zoom > 1 && !cropMode && (
              <p className="shrink-0 text-center text-xs text-muted-foreground">
                Drag to pan · scroll to zoom
              </p>
            )}
          </div>

          {/* ── Controls ───────────────────────────────────────── */}
          <div className="shrink-0 space-y-3 overflow-y-auto border-t pt-3 @3xl:w-64 @3xl:border-l @3xl:border-t-0 @3xl:pl-4 @3xl:pt-0">
            {/* US-534: straighten / deskew */}
            <SliderRow
              id="straighten"
              icon={<Spline className="h-3.5 w-3.5" />}
              label="Straighten"
              value={fine}
              min={-STRAIGHTEN_MAX}
              max={STRAIGHTEN_MAX}
              step={0.5}
              suffix="°"
              onChange={straighten}
              onReset={() => straighten(0)}
              disabled={busy || loading}
            />

            <div className="border-t pt-3">
              {toneLocked ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                  <p className="flex items-center gap-1.5 font-medium">
                    <Lock className="h-3.5 w-3.5" />
                    Tone locked
                  </p>
                  <p className="mt-1 leading-snug">
                    This photo was used for grading, so its brightness and colour
                    have to stay as graded. Rotate, straighten and crop still
                    work.
                  </p>
                </div>
              ) : (
                <>
                  <div className="mb-2 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 flex-1"
                      onClick={applyAuto}
                      disabled={busy || loading}
                    >
                      <Sparkles className="mr-1.5 h-4 w-4" />
                      Auto
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 flex-1"
                      onClick={removeBg}
                      disabled={busy || loading || bgRemoved}
                      title="Replace the background with studio white, on this device"
                    >
                      <Eraser className="mr-1.5 h-4 w-4" />
                      {bgRemoved ? "Removed" : "Cut out"}
                    </Button>
                  </div>

                  <SliderRow
                    id="brightness"
                    label="Brightness"
                    value={adj.brightness}
                    min={-100}
                    max={100}
                    step={1}
                    onChange={(v) => setTone({ brightness: v })}
                    onReset={() => setTone({ brightness: 0 })}
                    disabled={busy || loading}
                  />
                  <SliderRow
                    id="contrast"
                    label="Contrast"
                    value={adj.contrast}
                    min={-100}
                    max={100}
                    step={1}
                    onChange={(v) => setTone({ contrast: v })}
                    onReset={() => setTone({ contrast: 0 })}
                    disabled={busy || loading}
                  />
                  <SliderRow
                    id="saturation"
                    label="Saturation"
                    value={adj.saturation}
                    min={-100}
                    max={100}
                    step={1}
                    onChange={(v) => setTone({ saturation: v })}
                    onReset={() => setTone({ saturation: 0 })}
                    disabled={busy || loading}
                  />
                  <SliderRow
                    id="warmth"
                    label="Warmth"
                    value={adj.warmth}
                    min={-100}
                    max={100}
                    step={1}
                    onChange={(v) => setTone({ warmth: v })}
                    onReset={() => setTone({ warmth: 0 })}
                    disabled={busy || loading}
                  />
                  <SliderRow
                    id="sharpness"
                    label="Sharpness"
                    value={adj.sharpness}
                    min={0}
                    max={100}
                    step={1}
                    onChange={(v) => setTone({ sharpness: v })}
                    onReset={() => setTone({ sharpness: 0 })}
                    disabled={busy || loading}
                  />
                </>
              )}
            </div>

            {dirty && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-full text-xs"
                onClick={resetAll}
                disabled={busy || loading}
              >
                <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                Reset all changes
              </Button>
            )}

            {/* US-2208: discard the SAVED edit, not just this session's — only
                offered when a preserved original exists to restore. */}
            {onRevert && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-full text-xs text-muted-foreground"
                onClick={handleRevert}
                disabled={busy || loading}
              >
                {reverting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <History className="mr-1.5 h-3.5 w-3.5" />
                )}
                Revert to original photo
              </Button>
            )}

            <p className="text-xs leading-snug text-muted-foreground">
              {originalSrc
                ? "Editing from your original photo, so repeat edits never stack up. "
                : ""}
              eBay doesn't allow added borders, text, or watermarks — these tools
              only adjust the image itself.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 justify-between gap-2 border-t pt-3">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={busy || loading || fatal}>
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

/** Labelled range input matching the straighten control's existing look. */
function SliderRow({
  id,
  icon,
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  onChange,
  onReset,
  disabled,
}: {
  id: string;
  icon?: React.ReactNode;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  const neutral = value === 0;
  return (
    <div className="py-1">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={id}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
        >
          {icon}
          {label}
        </label>
        <div className="flex items-center gap-1">
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
            {value > 0 ? `+${value}` : value}
            {suffix}
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={disabled || neutral}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:invisible"
            aria-label={`Reset ${label.toLowerCase()}`}
          >
            <Undo2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="h-1 w-full cursor-pointer accent-primary"
        aria-label={label}
      />
    </div>
  );
}

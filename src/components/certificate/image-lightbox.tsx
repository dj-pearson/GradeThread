import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { cn } from "@/lib/utils";

// US-761: accessible full-screen viewer for the certificate photo gallery so a
// buyer can inspect the evidence behind the grade — zoom, step through photos
// (keyboard + swipe), see each photo's type, and download the original.

export interface LightboxImage {
  id: string;
  src: string;
  caption: string;
}

export function ImageLightbox({
  images,
  index,
  onClose,
  onNavigate,
}: {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
  onNavigate: (next: number) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchStartX = useRef<number | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const current = images[index];
  const hasMultiple = images.length > 1;

  const go = useCallback(
    (delta: number) => {
      setZoomed(false);
      const next = (index + delta + images.length) % images.length;
      onNavigate(next);
    },
    [index, images.length, onNavigate],
  );

  // Focus trap + Esc-to-close + background inert/aria-hidden + scroll lock + focus
  // restore on close, all via the shared overlay helper (US-448). Focus lands on
  // the close button first.
  const overlayRef = useFocusTrap<HTMLDivElement>({
    onEscape: onClose,
    initialFocus: closeRef,
  });

  // Arrow keys step through the gallery (Esc/Tab are owned by the focus trap).
  useEffect(() => {
    if (!hasMultiple) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, hasMultiple]);

  async function download() {
    if (!current) return;
    try {
      const res = await fetch(current.src);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${current.caption.replace(/\s+/g, "-").toLowerCase()}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Cross-origin/CORS can block a programmatic download — open the original
      // so the buyer can still save it manually.
      window.open(current.src, "_blank", "noopener");
    }
  }

  if (!current) return null;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Photo: ${current.caption}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
    >
      {/* Backdrop click-to-close. A dedicated button (behind the content via
          -z-10) keeps the dismiss affordance for pointer users; keyboard users
          dismiss with the toolbar Close button or Esc (focus trap). */}
      <button
        type="button"
        aria-label="Close photo viewer"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 -z-10 cursor-default"
      />
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{current.caption}</p>
          {hasMultiple && (
            <p className="text-xs text-white/60">
              {index + 1} of {images.length}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-white"
            onClick={() => setZoomed((z) => !z)}
            aria-label={zoomed ? "Zoom out" : "Zoom in"}
          >
            {zoomed ? <ZoomOut className="h-5 w-5" /> : <ZoomIn className="h-5 w-5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-white"
            onClick={download}
            aria-label="Download photo"
          >
            <Download className="h-5 w-5" />
          </Button>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Image stage */}
      <div
        className={cn(
          "flex flex-1 items-center justify-center overflow-auto p-2 sm:p-6",
          zoomed ? "cursor-zoom-out" : "cursor-zoom-in",
        )}
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          if (zoomed || touchStartX.current === null) return;
          const dx = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
          if (Math.abs(dx) > 50 && hasMultiple) go(dx < 0 ? 1 : -1);
          touchStartX.current = null;
        }}
      >
        <button
          type="button"
          onClick={() => setZoomed((z) => !z)}
          aria-label={zoomed ? "Zoom out" : "Zoom in"}
          className="contents"
        >
          <img
            src={current.src}
            alt={current.caption}
            className={cn(
              "select-none transition-transform",
              zoomed
                ? "max-w-none scale-100 sm:scale-150"
                : "max-h-full max-w-full object-contain",
            )}
          />
        </button>
      </div>

      {/* Prev / next */}
      {hasMultiple && (
        <>
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous photo"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next photo"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}
    </div>
  );
}

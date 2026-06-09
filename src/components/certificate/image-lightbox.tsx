import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);
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

  // Move focus into the dialog on open; restore it to the trigger on close.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // lock background scroll
    return () => {
      document.body.style.overflow = prevOverflow;
      (restoreFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  // Keyboard: Esc closes, arrows navigate, Tab is trapped within the overlay.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" && hasMultiple) {
        go(1);
      } else if (e.key === "ArrowLeft" && hasMultiple) {
        go(-1);
      } else if (e.key === "Tab") {
        const focusables = overlayRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href]',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, hasMultiple, onClose]);

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
      onClick={(e) => {
        // Backdrop click (not the image/controls) closes.
        if (e.target === overlayRef.current) onClose();
      }}
    >
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
        <img
          src={current.src}
          alt={current.caption}
          onClick={() => setZoomed((z) => !z)}
          className={cn(
            "select-none transition-transform",
            zoomed
              ? "max-w-none scale-100 sm:scale-150"
              : "max-h-full max-w-full object-contain",
          )}
        />
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

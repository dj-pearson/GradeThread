import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ImageIcon, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface ReviewPhoto {
  id: string;
  image_type: string;
  signed_url: string | null;
}

export function ReviewPhotos({ images }: { images: ReviewPhoto[] }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const current = images[index];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <p className="mb-3 text-sm text-muted-foreground">Select a photo to enlarge it and zoom in on damage.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {images.map((photo, photoIndex) => (
          <div key={photo.id}>
            {photo.signed_url ? (
              <DialogTrigger asChild>
                <button
                  type="button"
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setIndex(photoIndex);
                  }}
                  aria-label={`Enlarge ${photo.image_type} photo ${photoIndex + 1}`}
                  className="group relative block w-full cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <img src={photo.signed_url} alt={photo.image_type} loading="lazy" decoding="async" className="aspect-square w-full rounded-lg bg-muted object-contain" />
                  <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded bg-background px-2 py-1 text-xs">
                    <Maximize2 className="size-3" /> Enlarge
                  </span>
                </button>
              </DialogTrigger>
            ) : (
              <div className="flex aspect-square items-center justify-center rounded-lg bg-muted" role="img" aria-label={`${photo.image_type} photo unavailable`}>
                <ImageIcon className="size-8 text-muted-foreground" />
              </div>
            )}
            <p className="mt-1 text-sm capitalize">{photo.image_type.replace(/_/g, " ")}{!photo.signed_url && " (unavailable)"}</p>
          </div>
        ))}
      </div>
      <DialogContent
        className="flex h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col overflow-hidden p-3 sm:max-w-[calc(100%-2rem)] sm:p-5"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="capitalize">{current?.image_type.replace(/_/g, " ")} photo</DialogTitle>
          <DialogDescription>Photo {index + 1} of {images.length}. Zoom in, then drag or scroll to inspect. Press Escape to return to your review.</DialogDescription>
        </DialogHeader>
        {open && current && (
          <PhotoInspection
            key={`${current.id}:${current.signed_url}`}
            photo={current}
            previous={index > 0 ? () => setIndex(index - 1) : undefined}
            next={index < images.length - 1 ? () => setIndex(index + 1) : undefined}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PhotoInspection({ photo, previous, next }: {
  photo: ReviewPhoto;
  previous?: () => void;
  next?: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const ready = natural.width > 0 && !failed;

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = ready ? Math.min(size.width / natural.width, size.height / natural.height, 1) : 1;
  const width = natural.width * fit * zoom;
  const height = natural.height * fit * zoom;

  function reset() {
    setZoom(1);
    if (stage.current) {
      stage.current.scrollLeft = 0;
      stage.current.scrollTop = 0;
    }
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="icon" aria-label="Previous photo" disabled={!previous} onClick={previous}><ChevronLeft /></Button>
        <Button type="button" variant="outline" size="icon" aria-label="Next photo" disabled={!next} onClick={next}><ChevronRight /></Button>
        <Button type="button" variant="outline" size="icon" aria-label="Zoom out" disabled={!ready || zoom <= 1} onClick={() => setZoom(Math.max(1, zoom - 0.5))}><ZoomOut /></Button>
        <output className="min-w-12 text-center text-sm" aria-label="Photo zoom">{zoom}x</output>
        <Button type="button" variant="outline" size="icon" aria-label="Zoom in" disabled={!ready || zoom >= 8} onClick={() => setZoom(Math.min(8, zoom + 0.5))}><ZoomIn /></Button>
        <Button type="button" variant="outline" disabled={!ready} onClick={reset}>Fit photo</Button>
      </div>
      <div
        ref={stage}
        role="region"
        aria-label="Photo inspection area"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        style={{ cursor: ready && zoom > 1 ? "grab" : "auto", touchAction: zoom > 1 ? "none" : "auto" }}
        onPointerDown={(event) => {
          if (!ready || zoom <= 1 || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
      >
        {failed || !photo.signed_url ? (
          <p className="p-6 text-center text-sm" role="alert">Photo unavailable. Close and reopen the review to refresh photo access.</p>
        ) : (
          <div className="flex min-h-full min-w-full items-center justify-center" style={{ width: ready ? width : "100%", height: ready ? height : "100%" }}>
            {!ready && <p role="status" className="p-6 text-sm">Loading photo...</p>}
            <img
              src={photo.signed_url}
              alt={`${photo.image_type} inspection`}
              draggable={false}
              onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={() => setFailed(true)}
              className="max-w-none shrink-0 select-none"
              style={{ width, height, visibility: ready ? "visible" : "hidden" }}
            />
          </div>
        )}
      </div>
    </>
  );
}

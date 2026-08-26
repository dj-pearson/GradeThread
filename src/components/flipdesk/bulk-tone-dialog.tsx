import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Check, Wand2, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  NEUTRAL_ADJUSTMENTS,
  analyzeCanvas,
  isNeutral,
  pickReferenceIndex,
  renderAdjustedCanvas,
  solveToneMatch,
  toneDistance,
  type Adjustments,
  type ToneStats,
} from "@/lib/image-adjustments";
import { PHOTO_TYPE_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { ItemPhotoRow } from "@/types/database";

// Analysis and the before/after strip both run off a downscaled copy: tone
// statistics are means and percentiles, which a 700px proxy reproduces to well
// within a slider step, and holding a dozen full-resolution bitmaps at once
// would cost hundreds of megabytes. Full resolution is re-read one photo at a
// time, at apply time.
const PROXY_EDGE = 700;

// Below this the set already reads as consistent and matching would be churn
// for no visible gain. Roughly "a few levels of exposure apart".
const MATCH_WORTH_IT = 6;

interface LoadedPhoto {
  photo: ItemPhotoRow;
  blob: Blob;
  proxy: ImageBitmap;
  stats: ToneStats;
  adjust: Adjustments;
  include: boolean;
}

interface Props {
  open: boolean;
  photos: ItemPhotoRow[];
  onClose: () => void;
  /**
   * Persist one corrected photo. Called once per included photo, in sequence.
   *
   * The recipe argument is always null here, and deliberately so: tone matching
   * composes on top of whatever edit a photo already had (it reads the CURRENT
   * image, not the original), so no single recipe describes the result as a
   * transform of the original. Writing a partial one would let the editor
   * re-render from the original and silently drop an existing crop. A null
   * recipe means "current image is authoritative" — the preserved original is
   * still kept, so Revert to original keeps working.
   */
  onSavePhoto: (
    photo: ItemPhotoRow,
    blob: Blob,
    recipe: null,
  ) => Promise<unknown>;
  /** Invoked after every included photo has been saved. */
  onDone: () => void | Promise<void>;
}

/**
 * Bulk tone matching: bring every photo of an item to a common white balance
 * and exposure, so a set shot half in daylight and half under a lamp reads as
 * one shoot.
 *
 * The seller picks (or accepts) a reference photo; every other photo is solved
 * against it and shown before/after with a per-photo opt-out before anything
 * is written.
 */
export function BulkToneDialog({
  open,
  photos,
  onClose,
  onSavePhoto,
  onDone,
}: Props) {
  const [loaded, setLoaded] = useState<LoadedPhoto[] | null>(null);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef<LoadedPhoto[] | null>(null);
  loadedRef.current = loaded;

  // ── Load + analyse ────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoaded(null);
    setReferenceId(null);
    setProgress({ done: 0, total: 0 });

    void (async () => {
      try {
        const out: LoadedPhoto[] = [];
        for (const photo of photos) {
          const res = await fetch(photo.photo_url);
          if (!res.ok) continue; // skip an unreachable photo rather than fail all
          const blob = await res.blob();
          const full = await createImageBitmap(blob);
          const scale = Math.min(
            1,
            PROXY_EDGE / Math.max(full.width, full.height),
          );
          const proxy =
            scale < 1
              ? await createImageBitmap(blob, {
                  resizeWidth: Math.max(1, Math.round(full.width * scale)),
                  resizeHeight: Math.max(1, Math.round(full.height * scale)),
                  resizeQuality: "high",
                })
              : await createImageBitmap(blob);
          full.close();
          const canvas = renderAdjustedCanvas(
            proxy,
            proxy.width,
            proxy.height,
            NEUTRAL_ADJUSTMENTS,
          );
          const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
          const stats = analyzeCanvas(ctx, canvas.width, canvas.height);
          out.push({
            photo,
            blob,
            proxy,
            stats,
            adjust: NEUTRAL_ADJUSTMENTS,
            include: true,
          });
        }
        if (cancelled) {
          out.forEach((p) => p.proxy.close());
          return;
        }
        if (out.length < 2) {
          setError("Need at least two readable photos to match tone across.");
          setLoading(false);
          return;
        }
        const refIdx = pickReferenceIndex(out.map((p) => p.stats));
        setReferenceId(out[refIdx]!.photo.id);
        setLoaded(out);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError("Couldn't load these photos for tone matching.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, photos]);

  // Free the decoded proxies when the dialog closes.
  useEffect(() => {
    if (open) return;
    loadedRef.current?.forEach((p) => p.proxy.close());
    setLoaded(null);
  }, [open]);

  // ── Solve against the chosen reference ────────────────────────────
  useEffect(() => {
    if (!loaded || !referenceId) return;
    const ref = loaded.find((p) => p.photo.id === referenceId);
    if (!ref) return;
    setLoaded((prev) =>
      prev
        ? prev.map((p) => {
            if (p.photo.id === referenceId) {
              return { ...p, adjust: NEUTRAL_ADJUSTMENTS, include: false };
            }
            const adjust = solveToneMatch(p.stats, ref.stats);
            return {
              ...p,
              adjust,
              // Default to correcting only what visibly needs it, so a set that
              // is already consistent doesn't get rewritten for nothing.
              include:
                !isNeutral(adjust) &&
                toneDistance(p.stats, ref.stats) >= MATCH_WORTH_IT,
            };
          })
        : prev,
    );
    // `loaded` is intentionally excluded: this effect writes to it, and including
    // it would re-solve on its own output every pass. Re-solving is driven by the
    // reference changing (or the initial load, which sets referenceId).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceId, loading]);

  const toggleInclude = useCallback((id: string) => {
    setLoaded((prev) =>
      prev
        ? prev.map((p) =>
            p.photo.id === id ? { ...p, include: !p.include } : p,
          )
        : prev,
    );
  }, []);

  // ── Apply ─────────────────────────────────────────────────────────
  async function apply() {
    if (!loaded) return;
    const targets = loaded.filter((p) => p.include && !isNeutral(p.adjust));
    if (targets.length === 0) return;
    setApplying(true);
    setError(null);
    setProgress({ done: 0, total: targets.length });
    let failures = 0;
    try {
      for (const t of targets) {
        try {
          // Re-decode at FULL resolution here — the proxy was only ever for
          // analysis and preview; saving it would downgrade the photo to 700px.
          const full = await createImageBitmap(t.blob);
          try {
            const canvas = renderAdjustedCanvas(
              full,
              full.width,
              full.height,
              t.adjust,
            );
            const blob = await new Promise<Blob>((res, rej) =>
              canvas.toBlob(
                (b) => (b ? res(b) : rej(new Error("toBlob failed"))),
                "image/jpeg",
                0.92,
              ),
            );
            await onSavePhoto(t.photo, blob, null);
          } finally {
            full.close();
          }
        } catch {
          failures++;
        }
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      if (failures > 0) {
        setError(
          `${failures} of ${targets.length} photo${targets.length === 1 ? "" : "s"} couldn't be saved. The rest were updated.`,
        );
      }
      await onDone();
      if (failures === 0) onClose();
    } finally {
      setApplying(false);
    }
  }

  const selectedCount =
    loaded?.filter((p) => p.include && !isNeutral(p.adjust)).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !applying && onClose()}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-2rem)] max-w-4xl flex-col gap-3 overflow-hidden p-4">
        <DialogHeader className="shrink-0">
          <DialogTitle>Match tone across photos</DialogTitle>
          <DialogDescription>
            Pick the photo whose colour and exposure look right. Every other
            photo is corrected to match it.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex flex-1 items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading photos…
          </div>
        )}

        {!loading && loaded && (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Photos already close to the reference are left unticked — there's
                nothing to gain from rewriting them. Untick any correction you
                don't want.
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {loaded.map((p) => (
                <ToneCard
                  key={p.photo.id}
                  entry={p}
                  isReference={p.photo.id === referenceId}
                  onMakeReference={() => setReferenceId(p.photo.id)}
                  onToggle={() => toggleInclude(p.photo.id)}
                  disabled={applying}
                />
              ))}
            </div>
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            {applying
              ? `Saving ${progress.done} of ${progress.total}…`
              : selectedCount > 0
                ? `${selectedCount} photo${selectedCount === 1 ? "" : "s"} will be corrected`
                : "No corrections selected"}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={applying}>
              Cancel
            </Button>
            <Button
              onClick={apply}
              disabled={applying || loading || selectedCount === 0}
            >
              {applying ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Apply
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One photo's before/after pair, with reference and include controls. */
function ToneCard({
  entry,
  isReference,
  onMakeReference,
  onToggle,
  disabled,
}: {
  entry: LoadedPhoto;
  isReference: boolean;
  onMakeReference: () => void;
  onToggle: () => void;
  disabled: boolean;
}) {
  const beforeRef = useRef<HTMLCanvasElement>(null);
  const afterRef = useRef<HTMLCanvasElement>(null);
  const { proxy, adjust } = entry;

  useEffect(() => {
    // Thumbnail-sized previews: the strip shows a dozen at once, and the
    // correction is a global tone shift that is entirely legible at this size.
    const edge = 150;
    const scale = Math.min(1, edge / Math.max(proxy.width, proxy.height));
    const w = Math.max(1, Math.round(proxy.width * scale));
    const h = Math.max(1, Math.round(proxy.height * scale));

    const before = beforeRef.current;
    if (before) {
      before.width = w;
      before.height = h;
      before.getContext("2d")!.drawImage(proxy, 0, 0, w, h);
    }
    const after = afterRef.current;
    if (after) {
      const rendered = renderAdjustedCanvas(proxy, w, h, adjust);
      after.width = w;
      after.height = h;
      after.getContext("2d")!.drawImage(rendered, 0, 0);
    }
  }, [proxy, adjust]);

  const unchanged = isNeutral(adjust);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-card",
        isReference && "ring-2 ring-primary",
      )}
    >
      <div className="grid grid-cols-2 gap-px bg-border">
        <div className="relative bg-muted/40">
          <canvas ref={beforeRef} className="h-full w-full object-contain" />
          <span className="absolute left-1 top-1 rounded bg-background/80 px-1 text-[10px] text-muted-foreground">
            Before
          </span>
        </div>
        <div className="relative bg-muted/40">
          <canvas ref={afterRef} className="h-full w-full object-contain" />
          <span className="absolute left-1 top-1 rounded bg-background/80 px-1 text-[10px] text-muted-foreground">
            {isReference ? "Reference" : "After"}
          </span>
        </div>
      </div>
      <div className="space-y-1.5 p-1.5">
        <p className="truncate text-[11px] text-muted-foreground">
          {PHOTO_TYPE_LABELS[entry.photo.photo_type]}
        </p>
        {isReference ? (
          <p className="text-[11px] font-medium text-primary">
            Reference photo
          </p>
        ) : (
          <>
            <label className="flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={entry.include}
                onChange={onToggle}
                disabled={disabled || unchanged}
                className="h-3 w-3 accent-primary"
              />
              {unchanged ? "Already matches" : "Correct this photo"}
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-full px-1 text-[10px]"
              onClick={onMakeReference}
              disabled={disabled}
            >
              <Wand2 className="mr-1 h-3 w-3" />
              Use as reference
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

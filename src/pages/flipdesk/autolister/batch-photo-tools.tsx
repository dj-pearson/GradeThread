import { Eraser, Loader2, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// US-2520: lifted out of autolister.tsx. Both bars do the same shape of thing —
// one tap, applied to every staged photo, undoable because the original is kept
// — so they belong together and neither needs anything from the grouping grid.

export type StudioBackgroundMode = "white" | "transparent";

/** US-536: auto-crop, white-balance and even out exposure across the batch. */
export function AutoEnhanceBar({
  untouchedCount,
  busy,
  onEnhanceAll,
}: {
  /** Photos with no saved original, i.e. nothing has been applied to them yet. */
  untouchedCount: number;
  busy: boolean;
  onEnhanceAll: () => void;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3">
      <div className="flex items-center gap-2">
        <WandSparkles className="h-4 w-4 text-brand-red-text" />
        <span className="text-sm font-medium">Auto-enhance</span>
      </div>
      <Button size="sm" onClick={onEnhanceAll} disabled={busy || untouchedCount === 0}>
        {busy ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <WandSparkles className="mr-1 h-4 w-4" />
        )}
        Enhance all ({untouchedCount})
      </Button>
      <span className="text-xs text-muted-foreground">
        Auto-crops to the item, white-balances &amp; evens out exposure.
      </span>
    </Card>
  );
}

/** US-535: on-device background replacement across the batch. */
export function StudioBackgroundBar({
  mode,
  onModeChange,
  untouchedCount,
  busy,
  modelProgress,
  onApplyAll,
}: {
  mode: StudioBackgroundMode;
  onModeChange: (mode: StudioBackgroundMode) => void;
  untouchedCount: number;
  busy: boolean;
  /** 0–1 while the segmentation model downloads on first use; null after. */
  modelProgress: number | null;
  onApplyAll: (mode: StudioBackgroundMode) => void;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3">
      <div className="flex items-center gap-2">
        <Eraser className="h-4 w-4 text-brand-red-text" />
        <span className="text-sm font-medium">Studio background</span>
      </div>
      <div className="inline-flex overflow-hidden rounded-md border text-xs">
        <button
          type="button"
          onClick={() => onModeChange("white")}
          className={cn(
            "px-2.5 py-1",
            mode === "white"
              ? "bg-primary text-primary-foreground"
              : "hover:bg-muted",
          )}
        >
          Studio white
        </button>
        <button
          type="button"
          onClick={() => onModeChange("transparent")}
          className={cn(
            "border-l px-2.5 py-1",
            mode === "transparent"
              ? "bg-primary text-primary-foreground"
              : "hover:bg-muted",
          )}
        >
          Transparent
        </button>
      </div>
      <Button
        size="sm"
        onClick={() => onApplyAll(mode)}
        disabled={busy || untouchedCount === 0}
      >
        {busy ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Eraser className="mr-1 h-4 w-4" />
        )}
        Clean all ({untouchedCount})
      </Button>
      <span className="text-xs text-muted-foreground">
        {modelProgress != null
          ? `Downloading model… ${Math.round(modelProgress * 100)}%`
          : "Runs in your browser · no per-photo cost · first use downloads a model"}
      </span>
    </Card>
  );
}

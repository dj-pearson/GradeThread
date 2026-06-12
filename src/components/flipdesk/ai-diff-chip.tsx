import { Sparkles, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";

// US-551: an inline diff chip for a field the seller changed away from the AI's
// draft. Renders nothing when unchanged. The whole chip is a button that reverts
// the field to the AI's original value — keyboard-accessible and self-labeling.
// Parents decide *when* a field changed (via the helpers in listing-ai-diff.ts)
// and pass the formatted AI + current values for display.
export function AiDiffChip({
  changed,
  aiDisplay,
  currentDisplay,
  onRevert,
  className,
}: {
  changed: boolean;
  aiDisplay: string;
  currentDisplay?: string;
  onRevert: () => void;
  className?: string;
}) {
  if (!changed) return null;
  return (
    <button
      type="button"
      onClick={onRevert}
      title={`Revert to AI: ${aiDisplay}`}
      aria-label={`Revert to AI value ${aiDisplay}`}
      className={cn(
        "group inline-flex max-w-full items-center gap-1 rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-[10px] font-medium leading-none text-amber-700 transition-colors hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20",
        className,
      )}
    >
      <Sparkles className="h-2.5 w-2.5 shrink-0" />
      <span className="opacity-70">AI:</span>
      <span className="truncate line-through decoration-amber-500/60">
        {aiDisplay}
      </span>
      {currentDisplay !== undefined && (
        <>
          <span aria-hidden className="opacity-60">
            →
          </span>
          <span className="truncate">{currentDisplay}</span>
        </>
      )}
      <Undo2 className="h-2.5 w-2.5 shrink-0 opacity-60 group-hover:opacity-100" />
    </button>
  );
}

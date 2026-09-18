import { Sparkles, X } from "lucide-react";

// The amber "the AI thinks…" chips on the AutoLister workbench, in one place.
//
// Two of them, and they were near-identical 44- and 32-line blocks inline in
// autolister.tsx: the US-1904 proposed-item chips above the ungrouped drop
// zone, and the US-1544 grouping suggestions inside each group header. Neither
// holds state or talks to the network — each takes rows and two callbacks —
// so the page kept seventy-six lines of markup for no reason beyond where it
// was first written.
//
// US-3420 is what forced the extraction, and the reason is worth keeping. The
// Create and Apply buttons were the only names a screen reader heard on those
// rows, which is the defect src/test/repeated-labels.test.ts counts. That
// test's header recorded the labels as WRITTEN AND REVERTED: autolister.tsx
// sits exactly on its US-2520 line ceiling, and two aria-label attributes push
// it over. The ceiling says to extract a piece rather than raise the number,
// so the accessible name is now part of the chip's contract and the caller
// cannot render one without supplying it.

/** A row rendered as one chip. `label` is what a screen reader hears. */
export interface AiChipRow {
  id: string;
  /** Visible chip text. */
  text: string;
  /** Distinguishing name for the row, used in BOTH buttons' aria-labels. */
  label: string;
  /** 0–1. Rendered as a whole-number percentage beside the text. */
  confidence: number;
  /** Tooltip explaining the AI's reasoning. Empty is treated as absent. */
  reason?: string | null;
}

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 " +
  "bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-200";

function AiChip({
  row,
  textClassName,
  acceptText,
  acceptLabel,
  dismissLabel,
  onAccept,
  onDismiss,
}: {
  row: AiChipRow;
  textClassName: string;
  acceptText: string;
  acceptLabel: string;
  dismissLabel: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <span className={CHIP} title={row.reason || undefined}>
      <Sparkles className="h-3 w-3 shrink-0" />
      <span className={textClassName}>
        {row.text} · {Math.round(row.confidence * 100)}%
      </span>
      <button
        type="button"
        aria-label={acceptLabel}
        onClick={onAccept}
        className="font-semibold underline-offset-2 hover:underline"
      >
        {acceptText}
      </button>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="rounded-full p-0.5 hover:bg-amber-500/20"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * US-1904: propose-groups boundaries the model was not confident about. Created
 * only on the seller's confirmation, never silently applied.
 */
export function ProposalReviewChips({
  reviews,
  onAccept,
  onDismiss,
}: {
  reviews: AiChipRow[];
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (reviews.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Proposed items to review"
      className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
    >
      <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
        {reviews.length} proposed item{reviews.length === 1 ? "" : "s"} the AI wasn't sure
        about — create the ones that look right:
      </p>
      <div className="flex flex-wrap gap-1.5">
        {reviews.map((r) => (
          <AiChip
            key={r.id}
            row={r}
            textClassName="max-w-56 truncate"
            acceptText="Create"
            acceptLabel={`Create the proposed item from ${r.label}`}
            dismissLabel={`Dismiss proposal of ${r.label}`}
            onAccept={() => onAccept(r.id)}
            onDismiss={() => onDismiss(r.id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * US-1544: merge/split/move suggestions for one group. Dismissible, and Apply
 * is undoable through the US-1543 toast rather than auto-applied.
 */
export function GroupSuggestionChips({
  suggestions,
  onApply,
  onDismiss,
}: {
  suggestions: AiChipRow[];
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {suggestions.map((s) => (
        <AiChip
          key={s.id}
          row={s}
          textClassName="max-w-64 truncate"
          acceptText="Apply"
          acceptLabel={`Apply suggestion: ${s.label}`}
          dismissLabel={`Dismiss suggestion: ${s.label}`}
          onAccept={() => onApply(s.id)}
          onDismiss={() => onDismiss(s.id)}
        />
      ))}
    </div>
  );
}

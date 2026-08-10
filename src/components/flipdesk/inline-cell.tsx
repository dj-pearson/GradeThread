import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Props = {
  value: string | number | null;
  onChange: (next: string) => void;
  /**
   * What this cell edits, in the user's words — "Cost", "Tracking", "Notes".
   *
   * REQUIRED, and required on purpose. Until US-2450 this component said "Edit
   * value" for every one of its seven appearances in a listings row, which
   * passed the has-a-name bar in src/test/control-labels.test.ts and still left
   * a screen reader user unable to tell a cost field from a target price. A
   * required prop makes the compiler refuse a new call site that forgets, which
   * no test can do as reliably.
   */
  label: string;
  /**
   * Which row this cell belongs to — see itemRowLabel().
   *
   * Also required. `label` alone disambiguates ACROSS a row and does nothing
   * for the far commoner movement, which is down a column: seven "Cost"
   * editors that differ only by which garment they belong to. Optional would
   * have been the polite choice and it would have been forgotten.
   */
  rowLabel: string;
  type?: "text" | "number";
  align?: "left" | "right";
  className?: string;
  placeholder?: string;
  pending?: boolean;
  // Clamp the display to a single line with an ellipsis (full value on hover via
  // `title`). Prevents a long unbroken value — e.g. a pasted URL in Notes — from
  // blowing out the column width. Click still opens the editor, where the full
  // text is visible/scrollable. The parent cell must bound the width (e.g.
  // `max-w-[220px]`) for the ellipsis to kick in.
  truncate?: boolean;
};

// Click-to-edit cell. Enter/blur stages the change (parent decides when to
// actually persist). Esc cancels the edit. `pending` flag adds an amber tint
// so the user can see which cells have unsaved changes.
export function InlineCell({
  value,
  onChange,
  label,
  rowLabel,
  type = "text",
  align = "left",
  className,
  placeholder = "—",
  pending = false,
  truncate = false,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value == null ? "" : String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // The field, qualified by the row it sits in. Built once so the read view and
  // the editor cannot describe the same cell differently — a name that changes
  // when a control is activated reads as a different control.
  const scoped = `${label} for ${rowLabel}`;

  function stage() {
    const trimmed = draft.trim();
    const current = value == null ? "" : String(value);
    if (trimmed !== current.trim()) {
      onChange(trimmed);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        // No value in the label: an <input>'s value is announced natively, and
        // repeating it here would have it read twice.
        aria-label={scoped}
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={stage}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            stage();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value == null ? "" : String(value));
            setEditing(false);
          }
        }}
        className={cn(
          "w-full rounded-sm bg-background px-1 outline-none ring-1 ring-brand-navy",
          align === "right" && "text-right tabular-nums",
          className,
        )}
      />
    );
  }

  const display =
    value == null || value === ""
      ? null
      : type === "number"
        ? Number(value).toFixed(2)
        : String(value);

  return (
    <div
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setEditing(true);
        }
      }}
      role="button"
      // role="button" activates an inline text editor; the label states that so
      // the "button" announcement matches the actual (text-edit) affordance.
      //
      // The current value is spelled into the label because aria-label REPLACES
      // the element's text content in the accessible name — without it, the
      // number on screen is simply not announced. "empty" rather than nothing,
      // so a blank cell is heard as blank instead of as a truncated label.
      aria-label={`Edit ${scoped}, currently ${display ?? "empty"}`}
      // Full value on hover when clamped, so the user can peek without editing.
      title={truncate && display != null ? display : undefined}
      className={cn(
        "cursor-text rounded-sm px-1 -mx-1 hover:bg-muted/60 focus:bg-muted focus:outline-none",
        truncate && "block max-w-full truncate",
        pending && "bg-amber-100 ring-1 ring-amber-400/60 dark:bg-amber-950/40",
        align === "right" && "text-right tabular-nums",
        className,
      )}
    >
      {display ?? (
        <span className="text-muted-foreground/40">{placeholder}</span>
      )}
    </div>
  );
}

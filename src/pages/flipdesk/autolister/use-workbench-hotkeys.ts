// AL-15: keyboard-first sorting on the AutoLister workbench. Grouping a big
// dump was the slowest step and the page had no key handler at all.
//
//   arrows          move the focus ring over the ungrouped grid
//   Shift+arrows    move and extend the selection
//   Space           toggle the focused photo
//   g               group the selection into a new item
//   1-9             send the selection to the Nth visible item
//   Delete / Bksp   delete the selection (the undoable AL-13 path)
//   Esc             clear the selection
//   ?               show the cheat sheet
//
// Ignored while typing, inside any dialog, and with Ctrl/Cmd/Alt held.
import { useEffect, useState } from "react";

/** The index the focus ring moves to. Pure so the grid maths is testable. */
export function moveFocus(
  index: number,
  key: string,
  columns: number,
  count: number,
): number {
  if (count === 0) return -1;
  const cur = index < 0 ? 0 : Math.min(index, count - 1);
  const cols = Math.max(1, columns);
  switch (key) {
    case "ArrowRight":
      return Math.min(cur + 1, count - 1);
    case "ArrowLeft":
      return Math.max(cur - 1, 0);
    case "ArrowDown":
      return Math.min(cur + cols, count - 1);
    case "ArrowUp":
      return Math.max(cur - cols, 0);
    default:
      return cur;
  }
}

/** True when a workbench shortcut must stay out of this keydown's way. */
export function ignoreWorkbenchKey(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "defaultPrevented" | "target" | "key">): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return true;
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
  if (el.closest("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return true;
  // Space/Enter on a focused control belong to that control.
  if ((e.key === " " || e.key === "Enter") && (tag === "BUTTON" || tag === "A")) return true;
  return false;
}

export function useWorkbenchHotkeys({
  photoIds,
  columns,
  suspended,
  setSelected,
  onGroupSelection,
  onSendToGroup,
  onDeleteSelection,
  onFocusIndex,
}: {
  /** The ungrouped grid, in display order. */
  photoIds: string[];
  columns: number;
  /** A dialog or busy state owns the keyboard. */
  suspended: boolean;
  setSelected: (update: (prev: Set<string>) => Set<string>) => void;
  onGroupSelection: () => void;
  /** 0-based index into the visible items. */
  onSendToGroup: (index: number) => void;
  onDeleteSelection: () => void;
  /** Scroll the focused tile into view. */
  onFocusIndex: (index: number) => void;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    if (suspended) return;
    function onKeyDown(e: KeyboardEvent) {
      if (ignoreWorkbenchKey(e)) return;
      const index = focusedId ? photoIds.indexOf(focusedId) : -1;
      if (e.key.startsWith("Arrow")) {
        if (photoIds.length === 0) return;
        e.preventDefault();
        const next = moveFocus(index, e.key, columns, photoIds.length);
        const id = photoIds[next]!;
        setFocusedId(id);
        onFocusIndex(next);
        if (e.shiftKey) {
          const from = index < 0 ? next : index;
          const [lo, hi] = from <= next ? [from, next] : [next, from];
          setSelected((prev) => new Set([...prev, ...photoIds.slice(lo, hi + 1)]));
        }
        return;
      }
      if (e.key === " " && focusedId && index >= 0) {
        e.preventDefault();
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(focusedId)) next.delete(focusedId);
          else next.add(focusedId);
          return next;
        });
      } else if (e.key === "g") {
        e.preventDefault();
        onGroupSelection();
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        onSendToGroup(Number(e.key) - 1);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onDeleteSelection();
      } else if (e.key === "Escape") {
        setSelected(() => new Set());
        setFocusedId(null);
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [suspended, focusedId, photoIds, columns, setSelected, onGroupSelection, onSendToGroup, onDeleteSelection, onFocusIndex]);

  return { focusedId, helpOpen, setHelpOpen };
}

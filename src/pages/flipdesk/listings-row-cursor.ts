import { useEffect, useRef, useState } from "react";
import { isTypingTarget } from "@/hooks/use-keyboard-shortcuts";

// INV-15: work the inventory table from the keyboard.
//
//   j / k        move the row cursor down / up
//   x            select or unselect the cursor row
//   Shift+x      select every row from the last x to the cursor
//   Enter        quick edit the cursor row
//   e            open the cursor row in the full editor
//   Esc          drop the cursor
//
// All of it is off while a dialog or sheet is open, while typing in a field,
// and (for Enter) while focus is on a control, where Enter already means
// "press this".

/** True when a modal surface is open, so page shortcuts must not fire under it. */
export function dialogIsOpen(doc: Document = document): boolean {
  return doc.querySelector('[role="dialog"], [role="alertdialog"]') != null;
}

function onControl(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("button, a[href], [role='menuitem'], [role='option'], [role='tab']") != null
  );
}

export interface RowCursorHandlers {
  count: number;
  idAt: (index: number) => string | undefined;
  toggle: (id: string) => void;
  selectRange: (ids: string[]) => void;
  quickEdit: (index: number) => void;
  openFull: (index: number) => void;
  scrollTo: (index: number) => void;
}

export function useRowCursor(h: RowCursorHandlers, enabled = true) {
  const [cursor, setCursor] = useState<number | null>(null);
  const anchor = useRef<number | null>(null);
  const ref = useRef(h);
  useEffect(() => {
    ref.current = h;
  });
  const cursorRef = useRef(cursor);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // A cursor past the end of a shorter page points at nothing.
  const clamped = cursor != null && cursor >= h.count ? (h.count > 0 ? h.count - 1 : null) : cursor;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (!e.key || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || dialogIsOpen()) return;
      const hh = ref.current;
      if (hh.count === 0) return;
      const cur = cursorRef.current != null ? Math.min(cursorRef.current, hh.count - 1) : null;
      const move = (next: number) => {
        e.preventDefault();
        cursorRef.current = next;
        setCursor(next);
        hh.scrollTo(next);
      };
      switch (e.key) {
        case "j":
          move(cur == null ? 0 : Math.min(hh.count - 1, cur + 1));
          return;
        case "k":
          move(cur == null ? 0 : Math.max(0, cur - 1));
          return;
        case "x":
        case "X": {
          if (cur == null) return;
          e.preventDefault();
          if (e.shiftKey && anchor.current != null) {
            const [a, b] = [Math.min(anchor.current, cur), Math.max(anchor.current, cur)];
            const ids: string[] = [];
            for (let i = a; i <= b; i++) {
              const id = hh.idAt(i);
              if (id) ids.push(id);
            }
            hh.selectRange(ids);
          } else {
            const id = hh.idAt(cur);
            if (id) hh.toggle(id);
          }
          anchor.current = cur;
          return;
        }
        case "Enter":
          if (cur == null || onControl(e.target)) return;
          e.preventDefault();
          hh.quickEdit(cur);
          return;
        case "e":
          if (cur == null) return;
          e.preventDefault();
          hh.openFull(cur);
          return;
        case "Escape":
          if (cur == null) return;
          cursorRef.current = null;
          setCursor(null);
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  return { cursor: clamped, setCursor };
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CornerDownLeft } from "lucide-react";

// US-2881. One palette, two shells.
//
// There were two components: src/components/flipdesk/command-palette.tsx (824
// lines, the seller shell) and src/components/admin/command-palette.tsx (259
// lines, the admin shell). They looked alike and behaved differently, and the
// differences were not cosmetic:
//
//   * the seller palette implements the full combobox pattern (US-441) --
//     role="combobox", aria-activedescendant, role="listbox"/"option". The
//     admin one was a plain input over a div of buttons, so a screen-reader
//     user got no announcement of the active row at all.
//   * arrow keys WRAPPED in admin (modulo) and CLAMPED in the seller shell.
//     Same key, two behaviours, one product.
//   * the seller shell hand-rolled a window keydown listener; admin used
//     useKeyboardShortcuts with allowInInput. So Cmd-K inside a text field
//     worked on /admin and did nothing on /dashboard.
//
// This component owns all of that. A module supplies WHAT the rows are and
// what a row looks like inside; the shell owns the dialog, the input, the
// grouping, the keyboard, the ARIA and the empty state.
//
// MODULES ARE STRUCTURAL, NOT REGISTERED. There is no runtime registry to
// unregister from: the admin sections are built inside the admin palette,
// which only AdminLayout mounts. An admin command cannot leak into the seller
// shell because the seller shell never constructs one -- which is a stronger
// guarantee than a register/unregister lifecycle, and it cannot leak on a
// missed cleanup.

export interface PaletteSection<T> {
  /** Group heading. Also the group's accessible name. */
  title: string;
  entries: readonly T[];
}

export interface PaletteShellProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name for the dialog. Never rendered visually. */
  title: string;
  query: string;
  onQueryChange: (next: string) => void;
  placeholder: string;
  /** Accessible name for the input. Usually the placeholder without the ellipsis. */
  inputLabel: string;
  sections: readonly PaletteSection<T>[];
  /** Stable key for an entry. */
  keyOf: (entry: T) => string;
  /** The row's inner content. The shell owns the button, the icon slot is yours. */
  renderEntry: (entry: T, isActive: boolean) => ReactNode;
  onSelect: (entry: T) => void;
  /**
   * What to show when there are no rows. A hint before the user has typed
   * enough, a "no results" line after -- the caller decides which, because
   * only the caller knows whether it is still loading.
   */
  empty: ReactNode;
  /** Replaces the search icon while a request is in flight. */
  leading?: ReactNode;
  /** Rendered above the results. Used for the deep-search outage notice. */
  banner?: ReactNode;
  /** Rendered under the results. The seller shell's keyboard legend. */
  footer?: ReactNode;
}

export function PaletteShell<T>({
  open,
  onOpenChange,
  title,
  query,
  onQueryChange,
  placeholder,
  inputLabel,
  sections,
  keyOf,
  renderEntry,
  onSelect,
  empty,
  leading,
  banner,
  footer,
}: PaletteShellProps<T>) {
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const flat = useMemo(() => sections.flatMap((s) => s.entries), [sections]);

  // Keep the active row in range as results change. CLAMPED, not wrapped --
  // the two palettes disagreed about this and clamping is the one that does
  // not silently jump a user from the last row back to the first.
  useEffect(() => {
    setActiveIdx((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  // Open fresh every time.
  useEffect(() => {
    if (!open) setActiveIdx(0);
  }, [open]);

  // A new query means a new result set, so the active row goes back to the
  // top. Both palettes did this before the split -- the seller shell on every
  // keystroke, the admin one when a search returned -- and CLAMPING alone
  // would leave somebody who had arrowed to row five sitting on row five of a
  // completely different list.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = flat[activeIdx];
      if (entry !== undefined) onSelect(entry);
    }
  }

  let runningIdx = -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>

        <div className="flex items-center gap-2 border-b px-3">
          {leading}
          <input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={placeholder}
            className="h-12 flex-1 rounded-sm bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            // US-441: the combobox pattern. The input owns the listbox below;
            // aria-activedescendant points at the arrow-key-active row so a
            // screen reader announces it without moving DOM focus off the
            // input. The admin palette had none of this until US-2881.
            role="combobox"
            aria-label={inputLabel}
            aria-autocomplete="list"
            aria-expanded={flat.length > 0}
            aria-controls="palette-listbox"
            aria-activedescendant={
              flat.length > 0 ? `palette-option-${activeIdx}` : undefined
            }
          />
          <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id="palette-listbox"
          role="listbox"
          aria-label="Search results"
          className="max-h-[60dvh] overflow-y-auto p-2"
        >
          {banner}
          {flat.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{empty}</div>
          ) : (
            sections.map((section) => {
              if (section.entries.length === 0) return null;
              return (
                // Each section is a labelled group inside the listbox; the
                // visual header is aria-hidden so it is not announced twice.
                <div
                  key={section.title}
                  role="group"
                  aria-label={section.title}
                  className="mb-2"
                >
                  <div
                    aria-hidden="true"
                    className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {section.title}
                  </div>
                  {section.entries.map((entry) => {
                    runningIdx++;
                    const idx = runningIdx;
                    const isActive = idx === activeIdx;
                    return (
                      <button
                        key={keyOf(entry)}
                        type="button"
                        id={`palette-option-${idx}`}
                        role="option"
                        aria-selected={isActive}
                        data-idx={idx}
                        onMouseMove={() => setActiveIdx(idx)}
                        onClick={() => onSelect(entry)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm",
                          isActive ? "bg-muted" : "hover:bg-muted/60",
                        )}
                      >
                        {renderEntry(entry, isActive)}
                        {isActive && (
                          <CornerDownLeft className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {footer}
      </DialogContent>
    </Dialog>
  );
}
